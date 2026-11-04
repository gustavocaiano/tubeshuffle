#!/usr/bin/env python3
"""Focused offline tests for the standalone probe runner's safety semantics.

These tests do not invoke swiftc, spawn the probe, or require macOS. They use
real temporary fixture directories only to exercise cleanup/provenance handling
and mocked subprocess objects to exercise child reaping and compiler-group
semantics.
"""
import os
from pathlib import Path
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_standalone_library_store_probe as runner  # noqa: E402

# Test scaffolding must never ask tempfile for an environment-selected base.
# Use a portable explicit base: /private/tmp on macOS, /tmp/opencode on Linux.
TEST_BASE_ROOT = None
TEST_BASE = None


def explicit_test_base_root():
    root = Path("/private/tmp") if sys.platform == "darwin" else Path("/tmp/opencode")
    try:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError as error:
        raise unittest.SkipTest(f"explicit test base unavailable: {root}: {error}")
    info = os.lstat(root)
    if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise unittest.SkipTest(f"explicit test base is not a real directory: {root}")
    if Path(os.path.realpath(root)) != root:
        raise unittest.SkipTest(f"explicit test base is not canonical: {root}")
    if not os.access(root, os.W_OK | os.X_OK):
        raise unittest.SkipTest(f"explicit test base is not writable: {root}")
    return root


def setUpModule():
    global TEST_BASE_ROOT, TEST_BASE
    TEST_BASE_ROOT = explicit_test_base_root()
    TEST_BASE = runner.validated_temp_base(
        Path(tempfile.mkdtemp(
            prefix="tubeshuffle-standalone-test-base-",
            dir=str(TEST_BASE_ROOT))))
    os.chmod(TEST_BASE, 0o700)


def tearDownModule():
    if TEST_BASE is not None:
        shutil.rmtree(TEST_BASE, ignore_errors=True)


class FakeChild:
    def __init__(self, mode="create-hold", error=None):
        self.mode = mode
        self.error = error
        self.reaps = 0

    def kill_and_reap(self):
        self.reaps += 1
        if self.error is not None:
            raise self.error
        return 0


class FakeProc:
    def __init__(self, wait_codes):
        self._wait_codes = list(wait_codes)
        self.killed = 0
        self.stdin = None
        self.stdout = None
        self.stderr = None

    def poll(self):
        return None

    def kill(self):
        self.killed += 1

    def wait(self, timeout=None):
        code = self._wait_codes.pop(0)
        if isinstance(code, Exception):
            raise code
        return code


class FakeCompileProc:
    def __init__(self, communicate_error=None):
        self.pid = 987654
        self.returncode = -signal.SIGKILL
        self.communicate_error = communicate_error
        self.waited = 0

    def communicate(self, timeout=None):
        if self.communicate_error is not None:
            raise self.communicate_error
        return "", ""

    def poll(self):
        return None

    def wait(self, timeout=None):
        self.waited += 1
        return self.returncode


class HarnessTestBase(unittest.TestCase):
    def make_harness(self, children=(), created=(), scratch=None):
        harness = runner.Harness.__new__(runner.Harness)
        harness.created = list(created)
        harness.children = list(children)
        harness.identities = {}
        harness.tainted = False
        harness.temp_base = TEST_BASE
        if scratch is None:
            scratch = self.make_fixture("tubeshuffle-standalone-scratch-")
        harness.scratch = scratch.path
        harness.identities[scratch.path] = scratch.identity
        harness.build = TEST_BASE / "nonexistent-tubeshuffle-build"
        harness.executable = harness.build / "probe"
        return harness

    def make_fixture(self, prefix="tubeshuffle-standalone-root-"):
        path = Path(tempfile.mkdtemp(
            prefix=prefix,
            dir=str(TEST_BASE)))
        self.addCleanup(shutil.rmtree, path, ignore_errors=True)
        os.chmod(path, 0o700)
        identity = runner.Harness._identity(path)
        return runner.Fixture(path, identity)


class TempBaseTests(unittest.TestCase):
    def test_fixed_base_is_canonical_macos_path(self):
        self.assertEqual(runner.MACOS_TEMP_BASE, Path("/private/tmp"))

    def test_fixed_base_ignores_tmpdir_environment(self):
        with mock.patch.object(runner, "MACOS_TEMP_BASE", TEST_BASE):
            with mock.patch.dict(os.environ, {
                    "TMPDIR": "/definitely/not/the/base",
                    "TEMP": "/definitely/not/the/base",
                    "TMP": "/definitely/not/the/base"}):
                with mock.patch.object(
                        runner.tempfile, "gettempdir",
                        side_effect=AssertionError("environment lookup")):
                    self.assertEqual(runner.validated_temp_base(), TEST_BASE)

    def test_runner_has_no_environment_temp_lookup(self):
        source = Path(runner.__file__).read_text()
        self.assertNotIn("gettempdir", source)

    def test_harness_creation_uses_fixed_base(self):
        with mock.patch.object(runner, "MACOS_TEMP_BASE", TEST_BASE):
            with mock.patch.dict(os.environ, {
                    "TMPDIR": "/definitely/not/the/base"}):
                with mock.patch.object(
                        runner.tempfile, "gettempdir",
                        side_effect=AssertionError("environment lookup")):
                    harness = runner.Harness()
        self.addCleanup(harness.cleanup)
        self.assertEqual(harness.build.parent, TEST_BASE)
        self.assertTrue(harness.build.name.startswith(
            "tubeshuffle-standalone-build-"))
        self.assertEqual(harness.scratch.parent, TEST_BASE)
        self.assertTrue(harness.scratch.name.startswith(
            "tubeshuffle-standalone-scratch-"))

    def test_test_base_is_explicit_not_environment_selected(self):
        expected = Path("/private/tmp") if sys.platform == "darwin" else Path("/tmp/opencode")
        self.assertEqual(TEST_BASE_ROOT, expected)
        self.assertEqual(TEST_BASE.parent, expected)
        self.assertTrue(TEST_BASE.name.startswith(
            "tubeshuffle-standalone-test-base-"))
        info = os.lstat(TEST_BASE)
        self.assertTrue(stat.S_ISDIR(info.st_mode))
        self.assertFalse(stat.S_ISLNK(info.st_mode))
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o700)
        self.assertEqual(info.st_uid, os.geteuid())
        with mock.patch.dict(os.environ, {
                "TMPDIR": "/definitely/not/the/base",
                "TEMP": "/definitely/not/the/base",
                "TMP": "/definitely/not/the/base"}):
            self.assertEqual(TEST_BASE.parent, expected)

    def test_symlinked_base_is_refused(self):
        alias = TEST_BASE / "tubeshuffle-standalone-base-alias"
        os.symlink(TEST_BASE, alias)
        self.addCleanup(alias.unlink, missing_ok=True)
        with self.assertRaises(runner.HarnessFailure):
            runner.validated_temp_base(alias)


class ControlledEnvTests(HarnessTestBase):
    def test_child_env_overrides_inherited_tmp_variables(self):
        harness = self.make_harness()
        with mock.patch.dict(os.environ, {
                "TMPDIR": "/hostile/tmpdir",
                "TEMP": "/hostile/temp",
                "TMP": "/hostile/tmp",
                "PATH": os.environ.get("PATH", "/usr/bin:/bin")}):
            env = harness._child_env()
        scratch = str(harness.scratch)
        self.assertEqual(env["TMPDIR"], scratch)
        self.assertEqual(env["TEMP"], scratch)
        self.assertEqual(env["TMP"], scratch)
        self.assertEqual(env.get("PATH"), os.environ.get("PATH", "/usr/bin:/bin"))

    def test_spawn_passes_controlled_env_to_child(self):
        fixture = self.make_fixture()
        harness = self.make_harness(created=[fixture])
        harness.identities[fixture.path] = fixture.identity

        captured = {}

        def fake_popen(_command, **kwargs):
            captured.update(kwargs)
            return FakeProc([])

        with mock.patch.object(runner.subprocess, "Popen", side_effect=fake_popen):
            with mock.patch.object(runner.ChildProbe, "start", return_value=None):
                harness.spawn("create-hold", fixture.path)

        scratch = str(harness.scratch)
        self.assertEqual(captured["env"]["TMPDIR"], scratch)
        self.assertEqual(captured["env"]["TEMP"], scratch)
        self.assertEqual(captured["env"]["TMP"], scratch)

    def test_compiler_popen_passes_controlled_env(self):
        harness = self.make_harness()
        captured = {}

        def fake_popen(_command, **kwargs):
            captured.update(kwargs)
            return FakeCompileProc()

        with mock.patch.object(runner.subprocess, "Popen", side_effect=fake_popen):
            with mock.patch.object(
                    runner.os, "killpg", side_effect=ProcessLookupError):
                harness._run_bounded(["swiftc"], 1, "compile")

        scratch = str(harness.scratch)
        self.assertEqual(captured["env"]["TMPDIR"], scratch)
        self.assertEqual(captured["env"]["TEMP"], scratch)
        self.assertEqual(captured["env"]["TMP"], scratch)

    def test_scratch_is_owned_0700_and_removed_with_fixtures(self):
        harness = runner.Harness(temp_base=TEST_BASE)
        scratch = harness.scratch
        build = harness.build
        self.assertEqual(stat.S_IMODE(os.lstat(scratch).st_mode), 0o700)
        self.assertEqual(os.lstat(scratch).st_uid, os.geteuid())
        self.assertIn(scratch, harness.identities)
        self.assertIn(build, harness.identities)
        self.assertEqual(harness.cleanup(), [])
        self.assertFalse(scratch.exists())
        self.assertFalse(build.exists())

    def test_scratch_provenance_change_blocks_spawn(self):
        fixture = self.make_fixture()
        harness = self.make_harness(created=[fixture])
        harness.identities[fixture.path] = fixture.identity
        os.chmod(harness.scratch, 0o755)

        with mock.patch.object(runner.subprocess, "Popen") as popen:
            with self.assertRaises(runner.HarnessFailure):
                harness.spawn("contend", fixture.path)
        popen.assert_not_called()
        self.assertTrue(harness.tainted)


class StandaloneRunnerCleanupTests(HarnessTestBase):
    def test_cleanup_deletes_owned_tree_only_after_every_child_reaped(self):
        order = []

        class OrderedChild(FakeChild):
            def kill_and_reap(self):
                order.append("reap")
                return super().kill_and_reap()

        fixture = self.make_fixture()
        path = fixture.path
        harness = self.make_harness(children=[OrderedChild()], created=[fixture])

        real_rmtree = runner.shutil.rmtree

        def observed_rmtree(target, *args, **kwargs):
            order.append("remove")
            return real_rmtree(target, *args, **kwargs)

        with mock.patch.object(runner.shutil, "rmtree", observed_rmtree):
            errors = harness.cleanup()

        self.assertEqual(errors, [])
        self.assertEqual(order, ["reap", "remove"])
        self.assertFalse(path.exists())
        self.assertEqual(harness.children, [])
        self.assertEqual(harness.created, [])

    def test_uncertain_reap_retains_trees_and_reports_sanitized_paths(self):
        fixture = self.make_fixture()
        failure = runner.HarnessFailure("child was not definitively reaped")
        harness = self.make_harness(
            children=[FakeChild(error=failure)], created=[fixture])

        errors = harness.cleanup()

        self.assertTrue(fixture.path.exists())
        self.assertEqual(len(harness.children), 1)
        self.assertEqual(harness.created, [fixture])
        joined = "\n".join(errors)
        self.assertIn("child reap uncertain", joined)
        self.assertIn(fixture.path.name, joined)
        self.assertNotIn(str(fixture.path.parent), joined)

    def test_tainted_cleanup_retains_all_trees_even_after_reap(self):
        fixture = self.make_fixture()
        harness = self.make_harness(children=[FakeChild()], created=[fixture])
        harness.tainted = True

        with mock.patch.object(runner.shutil, "rmtree") as rmtree:
            errors = harness.cleanup()

        rmtree.assert_not_called()
        self.assertTrue(fixture.path.exists())
        self.assertEqual(harness.created, [fixture])
        joined = "\n".join(errors)
        self.assertIn("ownership uncertain", joined)
        self.assertIn(fixture.path.name, joined)
        self.assertNotIn(str(fixture.path.parent), joined)

    def test_cleanup_retains_fixture_after_provenance_mismatch(self):
        fixture = self.make_fixture()
        displaced = fixture.path.with_name(fixture.path.name + "-displaced")
        fixture.path.rename(displaced)
        self.addCleanup(shutil.rmtree, displaced, ignore_errors=True)

        os.makedirs(fixture.path, mode=0o700)
        os.chmod(fixture.path, 0o700)

        harness = self.make_harness(children=[FakeChild()], created=[fixture])
        errors = harness.cleanup()

        joined = "\n".join(errors)
        self.assertTrue(fixture.path.exists())
        self.assertIn("provenance mismatch", joined)
        self.assertIn(fixture.path.name, joined)
        self.assertNotIn(str(fixture.path.parent), joined)
        self.assertEqual(harness.created, [fixture])

    def test_temporary_provenance_failure_retains_without_deleting(self):
        harness = self.make_harness()
        harness.temp_base = TEST_BASE

        with mock.patch.object(
                runner.Harness, "_identity",
                side_effect=runner.HarnessFailure("provenance failure")):
            with self.assertRaises(runner.HarnessFailure):
                harness._temporary("tubeshuffle-standalone-root-")

        fixture = harness.created[-1]
        self.addCleanup(shutil.rmtree, fixture.path, ignore_errors=True)
        self.assertIsNone(fixture.identity)
        self.assertTrue(fixture.path.exists())
        self.assertTrue(harness.tainted)

        with mock.patch.object(runner.shutil, "rmtree") as rmtree:
            errors = harness.cleanup()
        rmtree.assert_not_called()
        self.assertTrue(fixture.path.exists())
        joined = "\n".join(errors)
        self.assertIn(fixture.path.name, joined)
        self.assertIn("provenance unknown", joined)

    def test_child_is_registered_before_popen(self):
        fixture = self.make_fixture()
        harness = self.make_harness()
        harness.identities[fixture.path] = fixture.identity

        def popen_side_effect(*_args, **_kwargs):
            self.assertEqual(len(harness.children), 1)
            self.assertIsNone(harness.children[0].proc)
            return FakeProc([])

        with mock.patch.object(
                runner.subprocess, "Popen", side_effect=popen_side_effect):
            with mock.patch.object(
                    runner.ChildProbe, "start",
                    side_effect=RuntimeError("post-popen failure")):
                with self.assertRaises(RuntimeError):
                    harness.spawn("create-hold", fixture.path)

        self.assertEqual(len(harness.children), 1)
        self.assertEqual(harness.children[0].mode, "create-hold")
        self.assertIsNotNone(harness.children[0].proc)

    def test_popen_failure_taints_and_retains_fixtures(self):
        fixture = self.make_fixture()
        harness = self.make_harness(created=[fixture])
        harness.identities[fixture.path] = fixture.identity

        with mock.patch.object(
                runner.subprocess, "Popen",
                side_effect=RuntimeError("constructor failure")):
            with self.assertRaises(RuntimeError):
                harness.spawn("create-hold", fixture.path)

        self.assertTrue(harness.tainted)
        self.assertEqual(len(harness.children), 1)
        self.assertTrue(harness.children[0].uncertain)

        with mock.patch.object(runner.shutil, "rmtree") as rmtree:
            errors = harness.cleanup()
        rmtree.assert_not_called()
        self.assertTrue(fixture.path.exists())
        self.assertIn(fixture.path.name, "\n".join(errors))

    def test_registration_failure_after_popen_keeps_real_process_handle(self):
        fixture = self.make_fixture()
        harness = self.make_harness(created=[fixture])
        harness.identities[fixture.path] = fixture.identity
        real_attach = runner.ChildProbe.attach
        calls = []

        def flaky_attach(child, proc):
            calls.append(proc)
            if len(calls) == 1:
                raise RuntimeError("registration interruption")
            return real_attach(child, proc)

        with mock.patch.object(
                runner.subprocess, "Popen", return_value=FakeProc([])):
            with mock.patch.object(
                    runner.ChildProbe, "attach", flaky_attach):
                with self.assertRaises(RuntimeError):
                    harness.spawn("create-hold", fixture.path)

        self.assertTrue(harness.tainted)
        self.assertEqual(len(harness.children), 1)
        self.assertIsNotNone(harness.children[0].proc)
        self.assertFalse(harness.children[0].uncertain)

    def test_popen_interruption_taints_and_retains_fixtures(self):
        fixture = self.make_fixture()
        harness = self.make_harness(created=[fixture])
        harness.identities[fixture.path] = fixture.identity

        with mock.patch.object(
                runner.subprocess, "Popen", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                harness.spawn("create-hold", fixture.path)

        self.assertTrue(harness.tainted)
        self.assertEqual(len(harness.children), 1)
        self.assertTrue(harness.children[0].uncertain)

        with mock.patch.object(runner.shutil, "rmtree") as rmtree:
            errors = harness.cleanup()
        rmtree.assert_not_called()
        self.assertTrue(fixture.path.exists())
        self.assertIn(fixture.path.name, "\n".join(errors))

    def test_spawn_refuses_unrecorded_fixture_before_popen(self):
        fixture = self.make_fixture()
        harness = self.make_harness()
        with mock.patch.object(runner.subprocess, "Popen") as popen:
            with self.assertRaises(runner.HarnessFailure):
                harness.spawn("contend", fixture.path)
        popen.assert_not_called()
        self.assertEqual(harness.children, [])

    def test_spawn_refuses_tampered_fixture_before_popen(self):
        fixture = self.make_fixture()
        harness = self.make_harness()
        harness.identities[fixture.path] = fixture.identity

        displaced = fixture.path.with_name(fixture.path.name + "-displaced")
        fixture.path.rename(displaced)
        self.addCleanup(shutil.rmtree, displaced, ignore_errors=True)
        os.makedirs(fixture.path, mode=0o700)
        os.chmod(fixture.path, 0o700)

        with mock.patch.object(runner.subprocess, "Popen") as popen:
            with self.assertRaises(runner.HarnessFailure):
                harness.spawn("contend", fixture.path)
        popen.assert_not_called()
        self.assertEqual(harness.children, [])

    def test_identity_rejects_wrong_permissions(self):
        path = Path(tempfile.mkdtemp(
            prefix="tubeshuffle-standalone-root-",
            dir=str(TEST_BASE)))
        self.addCleanup(shutil.rmtree, path, ignore_errors=True)
        os.chmod(path, 0o755)
        with self.assertRaises(runner.HarnessFailure):
            runner.Harness._identity(path)

    def test_display_never_reveals_parent_directory(self):
        display = runner.Harness._display(
            Path("/tmp/private-parent/tubeshuffle-standalone-root-abc"))
        self.assertEqual(display, "<temp>/tubeshuffle-standalone-root-abc")
        self.assertNotIn("private-parent", display)


class StandaloneRunnerReapingTests(unittest.TestCase):
    def test_kill_and_reap_returns_signal_status(self):
        proc = FakeProc([-signal.SIGKILL])
        probe = runner.ChildProbe("create-hold", "/tmp/root", proc)
        self.assertEqual(probe.kill_and_reap(), -signal.SIGKILL)
        self.assertEqual(proc.killed, 1)

    def test_kill_and_reap_refuses_uncertain_ownership(self):
        probe = runner.ChildProbe("create-hold", "/tmp/root")
        with self.assertRaises(runner.HarnessFailure):
            probe.kill_and_reap()

    def test_kill_and_reap_fails_closed_when_reap_stays_uncertain(self):
        timeout = subprocess.TimeoutExpired("probe", 1)
        proc = FakeProc([timeout, timeout])
        probe = runner.ChildProbe("create-hold", "/tmp/root", proc)
        with self.assertRaises(runner.HarnessFailure):
            probe.kill_and_reap()
        self.assertEqual(proc.killed, 2)

    def test_wait_rejects_nonsignal_exit_for_signal_expectation(self):
        proc = FakeProc([0, 0])
        probe = runner.ChildProbe("create-hold", "/tmp/root", proc)
        with self.assertRaises(runner.HarnessFailure):
            probe.wait(expected=-signal.SIGKILL)
        self.assertEqual(probe.wait(expected=None), 0)


class PidRaisingProc:
    """Fake whose pgid lookup raises, simulating interruption after Popen."""

    returncode = -signal.SIGKILL

    def __init__(self):
        self.waited = 0
        self.killed = 0

    @property
    def pid(self):
        raise KeyboardInterrupt

    def kill(self):
        self.killed += 1

    def wait(self, timeout=None):
        self.waited += 1
        return self.returncode


class StandaloneRunnerCompilerGroupTests(HarnessTestBase):
    def run_with(self, process, command=None):
        harness = self.make_harness()

        def call():
            with mock.patch.object(
                    runner.subprocess, "Popen", return_value=process):
                with mock.patch.object(
                        runner.os, "killpg", side_effect=ProcessLookupError):
                    return harness._run_bounded(
                        command or ["swiftc"], 1, "compile")

        return harness, call

    def test_compile_timeout_taints_and_retains(self):
        process = FakeCompileProc(
            subprocess.TimeoutExpired("swiftc", 1))
        harness, call = self.run_with(process)
        with self.assertRaises(runner.HarnessFailure):
            call()
        self.assertTrue(harness.tainted)
        self.assertGreaterEqual(process.waited, 1)

    def test_compile_interruption_taints_and_retains(self):
        process = FakeCompileProc(KeyboardInterrupt)
        harness, call = self.run_with(process)
        with self.assertRaises(KeyboardInterrupt):
            call()
        self.assertTrue(harness.tainted)

    def test_popen_failure_stays_tainted_conservatively(self):
        harness = self.make_harness()
        with mock.patch.object(
                runner.subprocess, "Popen",
                side_effect=RuntimeError("spawn failure")):
            with self.assertRaises(RuntimeError):
                harness._run_bounded(["swiftc"], 1, "compile")
        self.assertTrue(harness.tainted)

    def test_interruption_between_popen_and_pgid_retains_build_tree(self):
        fixture = self.make_fixture("tubeshuffle-standalone-build-")
        harness = self.make_harness(created=[fixture])
        harness.build = fixture.path
        process = PidRaisingProc()

        with mock.patch.object(
                runner.subprocess, "Popen", return_value=process):
            with self.assertRaises(KeyboardInterrupt):
                harness._run_bounded(["swiftc"], 1, "compile")

        self.assertTrue(harness.tainted)
        self.assertGreaterEqual(process.waited, 1)
        with mock.patch.object(runner.shutil, "rmtree") as rmtree:
            errors = harness.cleanup()
        rmtree.assert_not_called()
        self.assertTrue(fixture.path.exists())
        self.assertIn("ownership uncertain", "\n".join(errors))

    def test_interruption_during_termination_stays_tainted(self):
        fixture = self.make_fixture("tubeshuffle-standalone-build-")
        harness = self.make_harness(created=[fixture])
        harness.build = fixture.path
        process = FakeCompileProc(
            subprocess.TimeoutExpired("swiftc", 1))

        with mock.patch.object(
                runner.subprocess, "Popen", return_value=process):
            with mock.patch.object(
                    runner.os, "killpg", side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    harness._run_bounded(["swiftc"], 1, "compile")

        self.assertTrue(harness.tainted)
        with mock.patch.object(runner.shutil, "rmtree") as rmtree:
            errors = harness.cleanup()
        rmtree.assert_not_called()
        self.assertTrue(fixture.path.exists())
        self.assertIn("ownership uncertain", "\n".join(errors))

    def test_successful_compile_clears_only_its_own_taint(self):
        harness, call = self.run_with(FakeCompileProc())
        self.assertEqual(call()[0], -signal.SIGKILL)
        self.assertFalse(harness.tainted)

    def test_successful_compile_preserves_preexisting_taint(self):
        harness, call = self.run_with(FakeCompileProc())
        harness.tainted = True
        call()
        self.assertTrue(harness.tainted)

    def test_compiler_timeout_with_fixture_retains_build_tree(self):
        fixture = self.make_fixture("tubeshuffle-standalone-build-")
        harness = self.make_harness(created=[fixture])
        harness.build = fixture.path
        harness.executable = fixture.path / "probe"
        process = FakeCompileProc(
            subprocess.TimeoutExpired("swiftc", 1))
        with mock.patch.object(
                runner.subprocess, "Popen", return_value=process):
            with mock.patch.object(
                    runner.os, "killpg", side_effect=ProcessLookupError):
                with self.assertRaises(runner.HarnessFailure):
                    harness._run_bounded(["swiftc"], 1, "compile")

        with mock.patch.object(runner.shutil, "rmtree") as rmtree:
            errors = harness.cleanup()
        rmtree.assert_not_called()
        self.assertTrue(fixture.path.exists())
        self.assertIn("ownership uncertain", "\n".join(errors))


class CompileCommandTests(HarnessTestBase):
    SDK = ("/Applications/Xcode.app/Contents/Developer/Platforms/"
           "MacOSX.platform/Developer/SDKs/MacOSX.sdk")
    SWIFTC = "/usr/bin/swiftc"

    def compile_with(self, sdk_code=0, sdk_out=None, sdk_err=""):
        harness = self.make_harness()
        calls = []
        sdk_out = self.SDK + "\n" if sdk_out is None else sdk_out

        def fake_run(command, timeout, context):
            calls.append(list(command))
            if command[:3] == ["xcrun", "--find", "swiftc"]:
                return 0, self.SWIFTC + "\n", ""
            if command[:4] == ["xcrun", "--sdk", "macosx", "--show-sdk-path"]:
                return sdk_code, sdk_out, sdk_err
            return 0, "", ""

        def invoke():
            with mock.patch.object(runner.sys, "platform", "darwin"):
                with mock.patch.object(
                        runner.platform, "machine", return_value="arm64"):
                    with mock.patch.object(
                            harness, "_run_bounded", side_effect=fake_run):
                        harness.compile()

        return harness, calls, invoke

    def test_compile_queries_sdk_and_passes_it_to_swiftc(self):
        _harness, calls, invoke = self.compile_with()
        invoke()

        sdk_queries = [
            call for call in calls
            if call[:4] == ["xcrun", "--sdk", "macosx", "--show-sdk-path"]]
        self.assertEqual(len(sdk_queries), 1)
        swiftc_calls = [call for call in calls if call and call[0] == self.SWIFTC]
        self.assertEqual(len(swiftc_calls), 1)
        command = swiftc_calls[0]
        self.assertEqual(
            command[:5],
            [self.SWIFTC, "-sdk", self.SDK,
             "-target", "arm64-apple-macos14.0"])
        self.assertIn("-parse-as-library", command)
        self.assertIn("-DDEBUG", command)

    def test_sdk_query_failure_is_clear_and_stops_before_swiftc(self):
        _harness, calls, invoke = self.compile_with(
            sdk_code=1, sdk_out="", sdk_err="sdk query boom")
        with self.assertRaises(runner.HarnessFailure) as context:
            invoke()
        message = str(context.exception)
        self.assertIn("xcrun --sdk macosx --show-sdk-path failed", message)
        self.assertIn("sdk query boom", message)
        self.assertFalse([call for call in calls if call and call[0] == self.SWIFTC])

    def test_empty_sdk_path_is_clear_and_stops_before_swiftc(self):
        _harness, calls, invoke = self.compile_with(
            sdk_code=0, sdk_out="  \n")
        with self.assertRaises(runner.HarnessFailure) as context:
            invoke()
        self.assertIn("returned no SDK path", str(context.exception))
        self.assertFalse([call for call in calls if call and call[0] == self.SWIFTC])


class StandaloneRunnerLifecycleTests(unittest.TestCase):
    def test_run_harness_cleans_up_after_keyboard_interrupt(self):
        class Harness:
            cleaned = 0

            def compile(self):
                return None

            def cleanup(self):
                Harness.cleaned += 1
                return ["cleanup error"]

        def interrupt(_harness):
            raise KeyboardInterrupt

        with mock.patch.object(runner, "run_cases", interrupt):
            failure, errors = runner.run_harness(Harness())

        self.assertIsInstance(failure, KeyboardInterrupt)
        self.assertEqual(errors, ["cleanup error"])
        self.assertEqual(Harness.cleaned, 1)

    def test_lock_errno_mapping_keeps_contention_specific(self):
        store = (runner.MACOS / "TubeShuffleTests/Domain/Library/"
                 "ExperimentalLocalLibraryStore.swift").read_text()
        self.assertIn("if code == EINTR && interruptedAttempts < 8", store)
        self.assertIn("if code == EWOULDBLOCK || code == EAGAIN "
                      "{ throw Failure.alreadyOwned }", store)
        self.assertIn("throw Failure.unavailable", store)
        self.assertNotIn(
            "flock(fd, LOCK_EX | LOCK_NB) == 0 else "
            "{ close(fd); throw Failure.alreadyOwned }",
            store)


class RootValidationDiagnosticSourceTests(unittest.TestCase):
    """Scoped structural checks for the temporary DEBUG-ROOT-A4F2 probe.

    These do not compile Swift. They pin the fixed literal tags and the
    existing failure events so the temporary diagnostic cannot silently widen
    into paths, identifiers, device/inode numbers, or extra stdout events.
    """

    TAGS = (
        "absolute",
        "original-lstat",
        "original-type",
        "original-uid",
        "original-mode",
        "original-dev",
        "original-ino",
        "inherited-fstat",
        "inherited-type",
        "inherited-uid",
        "inherited-mode",
        "inherited-dev",
        "inherited-ino",
        "inherited-identity-dev",
        "inherited-identity-ino",
        "base-lstat",
        "base-type",
        "base-canonical",
        "resolved-prefix",
        "resolved-basename",
    )

    @classmethod
    def setUpClass(cls):
        cls.source = (runner.MACOS / "tests/standalone_library_probe.swift").read_text()

    def test_each_fixed_reason_tag_is_a_literal_once(self):
        self.assertIn('rootFailureTag = "DEBUG-ROOT-A4F2:" + tag', self.source)
        for tag in self.TAGS:
            call = f'recordRootFailure("{tag}")'
            self.assertEqual(self.source.count(call), 1, tag)

    def test_record_calls_use_only_fixed_literal_tags(self):
        calls = [line.strip() for line in self.source.splitlines()
                 if "recordRootFailure(" in line
                 and "private static func" not in line]
        self.assertEqual(len(calls), len(self.TAGS))
        for line in calls:
            self.assertRegex(line, r'^recordRootFailure\("[a-z-]+"\)$')

    def test_reason_is_only_a_field_on_existing_failure_events(self):
        self.assertIn(
            'emit("error", failure: failureName(error), reason: rootReason(for: error))',
            self.source)
        self.assertEqual(self.source.count('\\"reason\\"'), 1)
        self.assertIn('fields.append("\\"reason\\":\\"\\(reason)\\"")',
                      self.source)
        for line in self.source.splitlines():
            if "emit(" in line and "failure:" in line:
                self.assertIn("reason:", line)

    def test_create_hold_caught_failure_uses_reason(self):
        create_hold = self.source.split('case "create-hold":', 1)[1].split(
            'case "open-success":', 1)[0]
        self.assertIn("createNew(arguments)", create_hold)
        self.assertIn("case .failure(let failure, let reason)", create_hold)
        self.assertIn(
            'emit("failed", failure: failure, reason: reason)', create_hold)

    def test_caught_open_failures_derive_reason_only_from_root_errors(self):
        self.assertEqual(
            self.source.count(
                "return .failure(failureName(error), rootReason(for: error))"),
            2)
        self.assertIn(
            "guard let usage = error as? ProbeUsage, case .root = usage "
            "else { return nil }",
            self.source)
        self.assertIn("defer { rootFailureTag = nil }", self.source)


if __name__ == "__main__":
    unittest.main()
