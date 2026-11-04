#!/usr/bin/env python3
"""Run the isolated macOS process-lifecycle probe for the experimental store.

This script is deliberately not part of XCTest: the hosted test process starts
the YouTube player. It creates its own private synthetic temporary roots under
the fixed canonical macOS base /private/tmp (ignoring TMPDIR/TEMP/TMP), builds
the helper with xcrun/swiftc for macOS 14, speaks a bounded JSON-line protocol
to each child, and attempts bounded kill/reap before deleting only fixtures it
created itself. If process ownership is uncertain, it retains every fixture
tree instead of deleting it. External roots are refused: there are no root
arguments.

The observed cases cover cooperative lock retention across process boundaries.
They do not establish power-loss durability, physical read-only behavior, full
store integrity, adversarial filesystem protection, migration-free behavior, or
protection against a hostile same-user process racing path validation.

Compiler helpers and probe children run with TMPDIR/TEMP/TMP overridden to a
verified, owned 0700 scratch directory created under the same canonical base;
they never inherit an environment-selected scratch path. Compiler helpers also
run in separate process groups with bounded SIGTERM/SIGKILL shutdown.
Uninterruptible or escaped descendants cannot be guaranteed dead; such runs
taint the harness and retain fixture/build trees rather than claim they were
definitively reaped or that a process group is empty.

Mac command:
    python3 -B macos/tests/run_standalone_library_store_probe.py
"""
from __future__ import annotations

from collections import namedtuple
import json
import os
import platform
import queue
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

MACOS = Path(__file__).resolve().parents[1]
MARKER = b"TubeShuffle local library 1\n"
COMPILE_FLAGS = [
    "-DDEBUG",
    "-DTUBESHUFFLE_STANDALONE_LIBRARY_PROBE",
    "-swift-version", "5",
]
COMPILE_TIMEOUT = 180
START_TIMEOUT = 15
WAIT_TIMEOUT = 10

# A fixed canonical base, deliberately independent of TMPDIR/TEMP/TMP and of
# Foundation/Python environment lookup. macOS exposes /tmp as a legacy symlink;
# /private/tmp is the canonical directory and must not itself be a symlink.
MACOS_TEMP_BASE = Path("/private/tmp")

FixtureIdentity = namedtuple("FixtureIdentity", "dev ino uid mode")
Fixture = namedtuple("Fixture", "path identity")


def validated_temp_base(base=None):
    """Return the canonical, non-symlink temporary base, or fail closed."""
    base = MACOS_TEMP_BASE if base is None else Path(base)
    try:
        info = os.lstat(base)
    except OSError as error:
        raise HarnessFailure(f"temporary base unavailable: {base}: {error}") from error
    require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
            f"temporary base is not a real directory: {base}")
    try:
        resolved = Path(os.path.realpath(base))
    except OSError as error:
        raise HarnessFailure(f"temporary base cannot be resolved: {base}: {error}") from error
    require(resolved == base,
            f"temporary base is not canonical (symlink or alias): {base} -> {resolved}")
    require(os.access(base, os.W_OK | os.X_OK),
            f"temporary base is not writable/traversable: {base}")
    return resolved

SWIFT_SOURCES = [
    MACOS / "TubeShuffle/Domain/Library/LibrarySnapshot.swift",
    MACOS / "TubeShuffle/Persistence/SwiftDataLibraryRepository.swift",
    MACOS / "TubeShuffleTests/Domain/Library/ExperimentalLocalLibraryStore.swift",
    MACOS / "tests/standalone_library_probe.swift",
]


class HarnessFailure(AssertionError):
    pass


def require(condition, message):
    if not condition:
        raise HarnessFailure(message)


def expect(event, name, failure=None, context="probe"):
    require(event.get("event") == name,
            f"{context}: expected event {name!r}, got {event!r}")
    if failure is not None:
        require(event.get("failure") == failure,
                f"{context}: expected failure {failure!r}, got {event!r}")


class ChildProbe:
    """Ownership record created before a process exists.

    Registration happens before Popen. Until attach() records a real process,
    ownership is uncertain: cleanup must retain fixture trees rather than treat
    this record as safely reaped.
    """

    def __init__(self, mode, root, proc=None):
        self.proc = proc
        self.mode = mode
        self.root = Path(root)
        self.uncertain = False
        self._events = queue.Queue()
        self._stderr = []
        self._stdout_thread = None
        self._stderr_thread = None

    def attach(self, proc):
        self.proc = proc

    def mark_uncertain(self):
        self.uncertain = True

    def _process(self):
        require(self.proc is not None and not self.uncertain,
                f"{self.mode}: child process ownership is uncertain")
        return self.proc

    def start(self):
        proc = self._process()
        self._stdout_thread = threading.Thread(
            target=self._drain_stdout, args=(proc,), daemon=True)
        self._stderr_thread = threading.Thread(
            target=self._drain_stderr, args=(proc,), daemon=True)
        self._stdout_thread.start()
        self._stderr_thread.start()

    def _drain_stdout(self, proc):
        try:
            for line in proc.stdout:
                self._events.put(line)
        except (OSError, ValueError):
            pass
        finally:
            self._events.put(None)

    def _drain_stderr(self, proc):
        try:
            for line in proc.stderr:
                if len(self._stderr) < 100:
                    self._stderr.append(line.rstrip())
        except (OSError, ValueError):
            pass

    def stderr_text(self):
        return "\n".join(self._stderr)

    def is_alive(self):
        return self.proc is not None and not self.uncertain and self.proc.poll() is None

    def next_event(self, timeout=START_TIMEOUT):
        proc = self._process()
        try:
            item = self._events.get(timeout=timeout)
        except queue.Empty:
            raise HarnessFailure(
                f"{self.mode}: timed out waiting for event; stderr={self.stderr_text()}")
        if item is None:
            raise HarnessFailure(
                f"{self.mode}: stdout closed (exit={proc.poll()}); "
                f"stderr={self.stderr_text()}")
        try:
            return json.loads(item)
        except json.JSONDecodeError as error:
            raise HarnessFailure(f"{self.mode}: invalid JSON {item!r}: {error}")

    def send_exit(self):
        proc = self._process()
        require(proc.stdin is not None, f"{self.mode}: missing stdin pipe")
        try:
            proc.stdin.write("exit\n")
            proc.stdin.flush()
        except (BrokenPipeError, OSError) as error:
            raise HarnessFailure(f"{self.mode}: could not send exit: {error}")

    def wait(self, expected=0, timeout=WAIT_TIMEOUT):
        proc = self._process()
        try:
            code = proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.kill_and_reap()
            raise HarnessFailure(f"{self.mode}: timed out exiting; stderr={self.stderr_text()}")
        if expected is not None:
            require(code == expected,
                    f"{self.mode}: exit {code}, expected {expected}; "
                    f"stderr={self.stderr_text()}")
        return code

    def kill_and_reap(self):
        if self.proc is None or self.uncertain:
            raise HarnessFailure(f"{self.mode}: child spawn ownership is uncertain")

        proc = self.proc
        if proc.poll() is None:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
        try:
            code = proc.wait(timeout=WAIT_TIMEOUT)
        except subprocess.TimeoutExpired:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                code = proc.wait(timeout=WAIT_TIMEOUT)
            except subprocess.TimeoutExpired as error:
                raise HarnessFailure(
                    f"{self.mode}: child was not definitively reaped") from error

        for thread in (self._stdout_thread, self._stderr_thread):
            if thread is not None:
                thread.join(timeout=2)
        for stream in (proc.stdin, proc.stdout, proc.stderr):
            if stream is not None:
                try:
                    stream.close()
                except (OSError, ValueError):
                    pass
        return code


class Harness:
    def __init__(self, temp_base=None):
        self.created = []
        self.children = []
        self.identities = {}
        self.tainted = False
        self.temp_base = validated_temp_base(temp_base)
        # Private scratch is created and identity-recorded before any process.
        # Every child/compiler gets TMPDIR/TEMP/TMP pointing here, so no child
        # inherits an environment-selected scratch path.
        self.scratch = self._temporary("tubeshuffle-standalone-scratch-")
        self.build = self._temporary("tubeshuffle-standalone-build-")
        self.executable = self.build / "probe"

    @staticmethod
    def _identity(path):
        info = os.lstat(path)
        require(stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode),
                f"fixture is not a directory: {path}")
        require(info.st_uid == os.geteuid(), f"fixture owner mismatch: {path}")
        mode = stat.S_IMODE(info.st_mode)
        require(mode == 0o700, f"fixture permissions are not 0700: {path}")
        return FixtureIdentity(info.st_dev, info.st_ino, info.st_uid, mode)

    @staticmethod
    def _matches(info, identity):
        return (stat.S_ISDIR(info.st_mode) and not stat.S_ISLNK(info.st_mode)
                and info.st_dev == identity.dev
                and info.st_ino == identity.ino
                and info.st_uid == identity.uid
                and stat.S_IMODE(info.st_mode) == identity.mode)

    @classmethod
    def _matches_path(cls, path, identity):
        try:
            return cls._matches(os.lstat(path), identity)
        except OSError:
            return False

    @staticmethod
    def _display(path):
        return f"<temp>/{Path(path).name}"

    def _temporary(self, prefix):
        # mkdtemp with an explicit canonical base never consults TMPDIR/TEMP.
        path = Path(tempfile.mkdtemp(prefix=prefix, dir=str(self.temp_base)))
        # Register before provenance validation. If chmod/lstat fails or is
        # interrupted, identity stays None and cleanup retains the path rather
        # than recursively deleting a directory of uncertain provenance.
        fixture = Fixture(path, None)
        self.created.append(fixture)
        try:
            os.chmod(path, 0o700)
            identity = self._identity(path)
            self.identities[path] = identity
            self.created[-1] = Fixture(path, identity)
            return path
        except BaseException:
            self.tainted = True
            raise

    def new_root(self):
        return self._temporary("tubeshuffle-standalone-root-")

    def _child_env(self):
        """Return a child environment with scratch pinned to the owned dir.

        The inherited TMPDIR/TEMP/TMP values are deliberately discarded. The
        scratch directory must still match its recorded provenance; otherwise
        spawning fails closed before any process exists.
        """
        identity = self.identities.get(self.scratch)
        require(identity is not None,
                "scratch directory is not a recorded fixture")
        require(self._matches_path(self.scratch, identity),
                "scratch provenance changed before spawning")
        scratch = str(self.scratch)
        env = dict(os.environ)
        env["TMPDIR"] = scratch
        env["TEMP"] = scratch
        env["TMP"] = scratch
        return env

    @staticmethod
    def _group_alive(pgid):
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
        except OSError:
            return True
        return True

    def _terminate_group(self, process, pgid):
        # Bounded SIGTERM then SIGKILL. Reaping the parent is not treated as
        # proof that its process group is empty.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                pass
            except OSError:
                pass
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                continue
            if not self._group_alive(pgid):
                return True
        return not self._group_alive(pgid)

    @staticmethod
    def _reap_direct(process):
        # Best-effort bounded reap of the direct parent when the process group
        # id could not be established. Group absence cannot be confirmed in
        # this path, so the caller remains tainted.
        try:
            process.kill()
        except BaseException:
            pass
        try:
            process.wait(timeout=2)
        except BaseException:
            pass

    def _run_bounded(self, command, timeout, context):
        """Run a compiler helper in its own process group, bounded.

        Ownership is treated as uncertain from before Popen until both the
        direct parent is reaped and the process group is confirmed absent. Any
        BaseException (including one between Popen and pgid assignment, or
        during termination) leaves the harness tainted so the build tree is
        retained. On a fully confirmed clean run the prior taint state is
        restored; a run that was already tainted stays tainted.
        """
        try:
            env = self._child_env()
        except BaseException:
            self.tainted = True
            raise
        previously_tainted = self.tainted
        # Conservative: Popen may create a process and then fail.
        self.tainted = True

        try:
            process = subprocess.Popen(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                close_fds=True,
                start_new_session=True,
                env=env,
            )
        except BaseException:
            raise

        try:
            pgid = process.pid
        except BaseException:
            self._reap_direct(process)
            raise

        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            self._terminate_group(process, pgid)
            raise HarnessFailure(
                f"{context}: timed out after {timeout}s") from error
        except BaseException:
            self._terminate_group(process, pgid)
            raise

        if self._group_alive(pgid):
            self._terminate_group(process, pgid)
            raise HarnessFailure(
                f"{context}: process group was still populated after parent exit")

        # Direct parent reaped by communicate() and group confirmed absent.
        self.tainted = previously_tainted
        return process.returncode, stdout or "", stderr or ""

    def compile(self):
        require(sys.platform == "darwin",
                "standalone probe requires macOS with Xcode/xcrun swiftc")
        missing = [str(path) for path in SWIFT_SOURCES if not path.is_file()]
        require(not missing, f"missing Swift source(s): {missing}")

        located_code, located_out, located_err = self._run_bounded(
            ["xcrun", "--find", "swiftc"], 30, "xcrun --find swiftc")
        require(located_code == 0,
                f"xcrun --find swiftc failed: {located_err.strip()}")
        swiftc = located_out.strip()
        require(bool(swiftc), "xcrun --find swiftc returned no path")

        target = f"{platform.machine()}-apple-macos14.0"
        command = [
            swiftc,
            "-target", target,
            "-parse-as-library",
            *COMPILE_FLAGS,
            "-o", str(self.executable),
            *[str(path) for path in SWIFT_SOURCES],
        ]
        result_code, result_out, result_err = self._run_bounded(
            command, COMPILE_TIMEOUT, "swiftc")
        require(result_code == 0,
                "swiftc failed\n"
                f"command: {' '.join(command)}\n"
                f"stdout:\n{result_out}\n"
                f"stderr:\n{result_err}")

    def spawn(self, mode, root):
        root = Path(root)
        identity = self.identities.get(root)
        require(identity is not None, f"{mode}: root is not a recorded fixture")
        require(self._matches_path(root, identity),
                f"{mode}: root provenance changed before spawn")

        fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            inherited = os.fstat(fd)
            require(self._matches(inherited, identity),
                    f"{mode}: inherited descriptor does not match recorded fixture")
            require(self._matches_path(root, identity),
                    f"{mode}: root provenance changed before use")

            command = [
                str(self.executable),
                "--mode", mode,
                "--root", str(root),
                "--root-fd", str(fd),
                "--dev", str(identity.dev),
                "--ino", str(identity.ino),
                "--uid", str(identity.uid),
                "--root-mode", str(identity.mode),
            ]
            # Register an ownership record before spawning. If Popen or the
            # attach step is interrupted, ownership is uncertain: taint the
            # harness so cleanup retains every fixture tree instead of deleting.
            child = ChildProbe(mode, root)
            proc = None
            try:
                env = self._child_env()
                self.children.append(child)
                proc = subprocess.Popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    bufsize=1,
                    close_fds=True,
                    pass_fds=(fd,),
                    env=env,
                )
                child.attach(proc)
            except BaseException:
                if proc is not None:
                    # Popen returned but registration was interrupted: retain
                    # the real process handle so cleanup can still reap it.
                    child.attach(proc)
                else:
                    child.mark_uncertain()
                self.tainted = True
                raise
            child.start()
            return child
        finally:
            os.close(fd)

    def cleanup(self):
        errors = []
        all_reaped = True
        for child in reversed(self.children):
            try:
                child.kill_and_reap()
            except BaseException as error:  # keep trying every child, then retain trees
                all_reaped = False
                errors.append(f"{child.mode}: {error}")

        if not all_reaped or self.tainted:
            retained = []
            for fixture in self.created:
                if not fixture.path.exists():
                    continue
                retained.append(self._display(fixture.path))
                if fixture.identity is None:
                    errors.append(
                        f"retaining {self._display(fixture.path)}: provenance unknown")
            reason = ("spawn/compile ownership uncertain" if self.tainted
                      else "child reap uncertain")
            errors.append(
                f"{reason}; retaining owned temp trees: {', '.join(retained)}")
            return errors

        remaining = []
        for fixture in reversed(self.created):
            try:
                if not fixture.path.exists():
                    continue
                if fixture.identity is None:
                    errors.append(
                        f"retaining {self._display(fixture.path)}: provenance unknown")
                    remaining.append(fixture)
                    continue
                if not self._matches_path(fixture.path, fixture.identity):
                    errors.append(
                        f"retaining {self._display(fixture.path)}: provenance mismatch")
                    remaining.append(fixture)
                    continue
                shutil.rmtree(fixture.path)
            except BaseException as error:
                remaining.append(fixture)
                errors.append(
                    f"could not remove {self._display(fixture.path)}: {error}")

        self.created = remaining
        if all_reaped:
            self.children.clear()
        return errors


def case_create_hold_then_reopen(harness):
    root = harness.new_root()
    holder = harness.spawn("create-hold", root)
    expect(holder.next_event(), "holding", context="create-hold")
    require((root / "library/version").read_bytes() == MARKER,
            "create-hold did not write the synthetic completion marker")

    contender = harness.spawn("contend", root)
    expect(contender.next_event(), "denied", "alreadyOwned", context="contender")
    contender.wait(0)

    holder.send_exit()
    expect(holder.next_event(), "exited", context="create-hold")
    holder.wait(0)

    reopened = harness.spawn("open-success", root)
    expect(reopened.next_event(), "opened", context="separate reopen")
    reopened.wait(0)
    print("ok: create/hold -> contender denied -> exit/reap -> separate process opens")


def case_abnormal_termination_then_reopen(harness):
    root = harness.new_root()
    holder = harness.spawn("create-hold", root)
    expect(holder.next_event(), "holding", context="abnormal holder")
    require(holder.is_alive(), "abnormal holder exited before the deliberate kill")
    code = holder.kill_and_reap()
    require(code == -signal.SIGKILL,
            f"abnormal holder did not terminate by SIGKILL: {code}")

    reopened = harness.spawn("open-success", root)
    expect(reopened.next_event(), "opened", context="post-kill reopen")
    reopened.wait(0)
    print("ok: abnormal termination -> contender can open")


def case_failed_preflight_holds_lock(harness):
    root = harness.new_root()  # No library directory: inspection fails after locking.
    holder = harness.spawn("preflight-hold", root)
    expect(holder.next_event(), "failed", "invalidStore", context="preflight")
    expect(holder.next_event(), "preflight-no-constructor", context="preflight")
    expect(holder.next_event(), "retained", "alreadyOwned", context="preflight")
    expect(holder.next_event(), "holding", context="preflight")

    contender = harness.spawn("contend", root)
    expect(contender.next_event(), "denied", "alreadyOwned", context="preflight contender")
    contender.wait(0)

    holder.send_exit()
    expect(holder.next_event(), "exited", context="preflight")
    holder.wait(0)

    later = harness.spawn("open-fail", root)
    expect(later.next_event(), "failed", "invalidStore", context="after preflight exit")
    expect(later.next_event(), "open-fail-no-constructor", context="after preflight exit")
    later.wait(0)
    print("ok: failed preflight never constructs; lock held until process exit")


def case_injected_post_container_failure(harness):
    root = harness.new_root()
    holder = harness.spawn("injected-fail-hold", root)
    expect(holder.next_event(), "before-container", context="injected failure")
    expect(holder.next_event(), "container-assigned", context="injected failure")
    expect(holder.next_event(), "failed", "invalidStore", context="injected failure")
    expect(holder.next_event(), "retained", "alreadyOwned", context="injected failure")
    expect(holder.next_event(), "holding", context="injected failure")

    library = root / "library"
    require(library.is_dir(), "injected failure did not leave the synthetic library directory")
    require(not (library / "version").exists(),
            "injected failure unexpectedly completed the version marker")

    contender = harness.spawn("contend", root)
    expect(contender.next_event(), "denied", "alreadyOwned", context="injected contender")
    contender.wait(0)

    holder.send_exit()
    expect(holder.next_event(), "exited", context="injected failure")
    holder.wait(0)

    require(not (library / "version").exists(),
            "injected failure fixture became complete after process exit")
    later = harness.spawn("open-fail", root)
    expect(later.next_event(), "failed", "invalidStore", context="after injected exit")
    expect(later.next_event(), "open-fail-no-constructor", context="after injected exit")
    later.wait(0)
    print("ok: container assigned -> injected failure -> lock retained -> incomplete reopen rejects")


def case_incomplete_fixture_rejects_reopen(harness):
    root = harness.new_root()
    library = root / "library"
    library.mkdir(mode=0o700)
    os.chmod(library, 0o700)
    (library / "version").write_bytes(MARKER)
    sentinel = library / "sentinel"
    sentinel.write_bytes(b"preserve")

    first = harness.spawn("open-fail", root)
    expect(first.next_event(), "failed", "invalidStore", context="incomplete first open")
    expect(first.next_event(), "open-fail-no-constructor", context="incomplete first open")
    first.wait(0)

    second = harness.spawn("open-fail", root)
    expect(second.next_event(), "failed", "invalidStore", context="incomplete reopen")
    expect(second.next_event(), "open-fail-no-constructor", context="incomplete reopen")
    second.wait(0)

    require(sentinel.read_bytes() == b"preserve", "incomplete inspection replaced sentinel")
    require(not (library / "library.store").exists(),
            "incomplete inspection created library.store")
    print("ok: incomplete fixture rejects first open and reopen")


def run_cases(harness):
    case_create_hold_then_reopen(harness)
    case_abnormal_termination_then_reopen(harness)
    case_failed_preflight_holds_lock(harness)
    # Corrupt-store behavior is omitted as construction proof: it is
    # platform-dependent and does not establish that a container was assigned.
    case_injected_post_container_failure(harness)
    case_incomplete_fixture_rejects_reopen(harness)


def run_harness(harness):
    failure = None
    try:
        harness.compile()
        run_cases(harness)
    except BaseException as error:
        failure = error
    finally:
        cleanup_errors = harness.cleanup()
    return failure, cleanup_errors


def main(argv):
    if argv:
        print("This harness creates its own synthetic temporary roots; "
              "external arguments or roots are refused.", file=sys.stderr)
        return 2
    if sys.platform != "darwin":
        print("This probe requires macOS with Xcode/xcrun swiftc. "
              "Run: python3 -B macos/tests/run_standalone_library_store_probe.py",
              file=sys.stderr)
        return 2

    # Construct explicitly so a partially initialized harness can still report
    # retained paths if build-fixture provenance fails during setup.
    harness = Harness.__new__(Harness)
    try:
        harness.__init__()
    except BaseException as error:
        try:
            setup_cleanup_errors = harness.cleanup()
        except BaseException as cleanup_error:
            setup_cleanup_errors = [f"cleanup failed: {cleanup_error}"]
        if isinstance(error, KeyboardInterrupt):
            print("interrupted during harness setup; cleanup reported below",
                  file=sys.stderr)
        else:
            print(f"FAIL: {error}", file=sys.stderr)
        for item in setup_cleanup_errors:
            print(f"cleanup: {item}", file=sys.stderr)
        return 130 if isinstance(error, KeyboardInterrupt) else 1

    failure, cleanup_errors = run_harness(harness)
    if failure is not None:
        if isinstance(failure, KeyboardInterrupt):
            print("interrupted; cleanup completed", file=sys.stderr)
        else:
            print(f"FAIL: {failure}", file=sys.stderr)
        for error in cleanup_errors:
            print(f"cleanup: {error}", file=sys.stderr)
        return 130 if isinstance(failure, KeyboardInterrupt) else 1
    if cleanup_errors:
        for error in cleanup_errors:
            print(f"cleanup: {error}", file=sys.stderr)
        return 1
    print("standalone lifecycle probe: ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
