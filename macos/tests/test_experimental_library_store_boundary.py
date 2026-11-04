#!/usr/bin/env python3
"""Offline structural checks for the quarantined experimental library store.

These checks need neither Xcode nor network access. They verify project
membership and the absence of a production entry point or Application Support
path; they are not a Swift compile, a runtime test, or durability evidence.
"""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]

STORE = "TubeShuffleTests/Domain/Library/ExperimentalLocalLibraryStore.swift"
STORE_TESTS = "TubeShuffleTests/Domain/Library/LocalLibraryStoreTests.swift"
OLD_STORE = "TubeShuffle/Persistence/LocalLibraryStore.swift"
READER = "TubeShuffle/Persistence/SwiftDataLibraryRepository.swift"
PROBE = "tests/standalone_library_probe.swift"
RUNNER = "tests/run_standalone_library_store_probe.py"


def objects(project):
    return dict(re.findall(r'^\s*([A-F0-9]{24})(?: /\*.*?\*/)? = \{(.*?)\};', project, re.M))


def source_phases(objects):
    targets = {}
    for value in objects.values():
        match = re.search(
            r'isa = PBXNativeTarget;.*?buildPhases = \(([^)]*)\);.*?name = (TubeShuffle(?:Tests)?);',
            value)
        if match:
            targets[match.group(2)] = re.findall(r'[A-F0-9]{24}', match.group(1))
    phases = {}
    for target, build_phases in targets.items():
        sources = [objects[phase] for phase in build_phases
                   if 'isa = PBXSourcesBuildPhase;' in objects[phase]]
        if sources:
            assert len(sources) == 1, target
            phases[target] = set(re.findall(r'[A-F0-9]{24}', sources[0]))
    return phases


def file_reference(objects, build_file):
    match = re.search(r'fileRef = ([A-F0-9]{24});', objects[build_file])
    return match.group(1) if match else None


def source_path(objects, build_file):
    reference = file_reference(objects, build_file)
    if not reference:
        return None
    match = re.search(r'path = ([^;]+);', objects[reference])
    return match.group(1) if match else None


class ExperimentalLibraryStoreBoundaryTests(unittest.TestCase):
    def setUp(self):
        self.project = (ROOT / "TubeShuffle.xcodeproj/project.pbxproj").read_text()
        self.objects = objects(self.project)
        self.phases = source_phases(self.objects)

    def assert_target_only(self, path, target):
        references = [key for key, value in self.objects.items()
                      if f'path = {path};' in value]
        self.assertEqual(len(references), 1, path)
        builds = [key for key, value in self.objects.items()
                  if 'isa = PBXBuildFile;' in value and f'fileRef = {references[0]};' in value]
        self.assertEqual(len(builds), 1, path)
        other = "TubeShuffleTests" if target == "TubeShuffle" else "TubeShuffle"
        self.assertIn(builds[0], self.phases[target], path)
        self.assertNotIn(builds[0], self.phases[other], path)

    def assert_test_target_only(self, path):
        self.assert_target_only(path, "TubeShuffleTests")

    def test_experimental_store_and_its_tests_are_test_target_only(self):
        for path in (STORE, STORE_TESTS):
            self.assertTrue((ROOT / path).is_file(), path)
            self.assert_test_target_only(path)
        self.assertFalse((ROOT / OLD_STORE).exists())
        self.assertNotIn(f'path = {OLD_STORE};', self.project)

    def test_app_target_has_no_test_sources(self):
        for build_file in self.phases["TubeShuffle"]:
            path = source_path(self.objects, build_file)
            if path is not None:
                self.assertFalse(path.startswith("TubeShuffleTests/"), path)

    def test_experimental_store_has_no_production_entry_or_support_path(self):
        store = (ROOT / STORE).read_text()
        self.assertNotIn("static func production", store)
        self.assertNotIn("production(", store)
        self.assertIsNone(re.search(r'application.?support', store, re.I))
        self.assertIn(
            "#if !TUBESHUFFLE_STANDALONE_LIBRARY_PROBE\n"
            "@testable import TubeShuffle\n"
            "#endif",
            store)
        self.assertIn("static func testing(", store)

    def test_lock_errno_mapping_is_specific(self):
        store = (ROOT / STORE).read_text()
        self.assertIn("code == EINTR", store)
        self.assertIn("code == EWOULDBLOCK", store)
        self.assertIn("code == EAGAIN", store)
        self.assertIn("throw Failure.unavailable", store)
        self.assertIn("interruptedAttempts < 8", store)
        self.assertNotIn(
            "flock(fd, LOCK_EX | LOCK_NB) == 0 else { close(fd); throw Failure.alreadyOwned }",
            store)

    def test_injection_hooks_are_debug_only_and_ordered(self):
        store = (ROOT / STORE).read_text()
        before_hook = store.index("try Self.beforeContainerConstructionForTesting?()")
        assignment = store.index("owner.container = try ModelContainer")
        after_hook = store.index("try Self.afterContainerAssignedForTesting?()")
        self.assertLess(before_hook, assignment)
        self.assertLess(assignment, after_hook)
        for hook in (before_hook, after_hook):
            guard_start = store.rfind("#if DEBUG", 0, hook)
            guard_end = store.find("#endif", hook)
            self.assertGreaterEqual(guard_start, 0)
            self.assertLess(guard_start, hook)
            self.assertGreater(guard_end, hook)
        self.assertIn("static var beforeContainerConstructionForTesting", store)
        self.assertIn("static var afterContainerAssignedForTesting", store)

    def test_committed_reader_remains_app_target_only(self):
        # The committed reader/models are app-target code. They are compiled
        # alongside the standalone helper only by the probe script, and are not
        # moved, quarantined, or referenced by the experimental store.
        self.assertTrue((ROOT / READER).is_file(), READER)
        self.assert_target_only(READER, "TubeShuffle")
        self.assertNotEqual(READER, STORE)
        self.assertNotIn("SwiftDataLibraryRepository", (ROOT / STORE).read_text())

    def test_standalone_probe_is_not_a_project_target_member(self):
        helper = ROOT / PROBE
        orchestrator = ROOT / RUNNER
        self.assertTrue(helper.is_file())
        self.assertTrue(orchestrator.is_file())
        helper_text = helper.read_text()
        runner_text = orchestrator.read_text()
        self.assertIn("#if !TUBESHUFFLE_STANDALONE_LIBRARY_PROBE", helper_text)
        self.assertIn("lstat(arguments.root", helper_text)
        self.assertIn("fstat(arguments.rootFD", helper_text)
        self.assertIn("same-user process racing", helper_text)
        # Preflight and incomplete/invalid paths assert both hooks are untouched.
        self.assertIn("preflight-no-constructor", helper_text)
        self.assertIn("open-fail-no-constructor", helper_text)
        self.assertIn("before-container", helper_text)
        # Both sides use a fixed canonical /private/tmp base, not env lookup.
        self.assertIn('private static let temporaryBase = "/private/tmp"', helper_text)
        self.assertNotIn("NSTemporaryDirectory", helper_text)
        self.assertIn('MACOS_TEMP_BASE = Path("/private/tmp")', runner_text)
        self.assertNotIn("gettempdir", runner_text)
        self.assertIn("tempfile.mkdtemp", runner_text)
        # Monotonic, bounded hold budget larger than every parent wait.
        self.assertIn("DispatchTime.now().uptimeNanoseconds", helper_text)
        self.assertIn("private static let holdBudgetSeconds: UInt64 = 120", helper_text)
        # Abnormal termination must prove aliveness, then signal termination.
        self.assertIn("holder.is_alive()", runner_text)
        self.assertIn("code == -signal.SIGKILL", runner_text)
        # Uncertain reap/taint retains owned trees and reports sanitized paths.
        self.assertIn("child was not definitively reaped", runner_text)
        self.assertIn("retaining owned temp trees", runner_text)
        self.assertIn("spawn/compile ownership uncertain", runner_text)
        self.assertIn('return f"<temp>/{Path(path).name}"', runner_text)
        # Compiler helpers use managed process groups, never bare run().
        self.assertIn("start_new_session=True", runner_text)
        self.assertIn("os.killpg", runner_text)
        self.assertIn("except BaseException", runner_text)
        self.assertNotIn("subprocess.run(", runner_text)
        # Children/compilers get a private scratch dir, not inherited temp env.
        self.assertIn('self.scratch = self._temporary(', runner_text)
        self.assertIn('env["TMPDIR"] = scratch', runner_text)
        self.assertIn('env["TEMP"] = scratch', runner_text)
        self.assertIn('env["TMP"] = scratch', runner_text)
        self.assertIn("env=env", runner_text)
        self.assertNotIn("env=os.environ", runner_text)
        # Compiler ownership is tainted before Popen and cleared only after
        # direct reap plus confirmed-absent group.
        self.assertIn("previously_tainted = self.tainted", runner_text)
        self.assertIn("process group was still populated after parent exit", runner_text)
        self.assertIn("self._reap_direct(process)", runner_text)
        self.assertNotIn(PROBE, self.project)
        self.assertNotIn(RUNNER, self.project)

    def test_app_sources_do_not_reference_the_experimental_store(self):
        forbidden = re.compile(r'\b(?:Experimental)?LocalLibraryStore\b')
        sources = list((ROOT / "TubeShuffle").rglob("*.swift"))
        self.assertTrue(sources)
        for source in sources:
            self.assertIsNone(forbidden.search(source.read_text()), str(source))

    def test_process_lifetime_ownership_is_not_released_early(self):
        store = (ROOT / STORE).read_text()
        self.assertIn(
            "private static var owners: [String: ExperimentalLocalLibraryStore] = [:]",
            store)
        for forbidden in ("LOCK_UN", "owners.remove", "owners.removeAll", "container = nil"):
            self.assertNotIn(forbidden, store)


if __name__ == "__main__":
    unittest.main()
