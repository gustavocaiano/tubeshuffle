#!/usr/bin/env python3
"""Offline structural regression checks; no Xcode or network required."""
from pathlib import Path
import plistlib
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AccountBuildConfigTests(unittest.TestCase):
    def test_plist_contains_only_callback_registration_and_app_icon(self):
        plist = plistlib.loads((ROOT / "TubeShuffle/Resources/Info.plist").read_bytes())
        self.assertEqual(set(plist), {"CFBundleURLTypes", "CFBundleIconFile"})
        self.assertEqual(plist["CFBundleIconFile"], "AppIcon")
        self.assertEqual(plist["CFBundleURLTypes"], [{
            "CFBundleURLName": "com.tubeshuffle.playbacklab.auth",
            "CFBundleURLSchemes": ["com.tubeshuffle.playbacklab"],
        }])
        self.assertNotIn("$(", repr(plist))

    def test_project_has_no_account_config_build_phase_or_settings(self):
        project = (ROOT / "TubeShuffle.xcodeproj/project.pbxproj").read_text()
        self.assertEqual(project.count("INFOPLIST_FILE = TubeShuffle/Resources/Info.plist"), 2)
        for forbidden in ("TUBESHUFFLE_PROJECT_ORIGIN", "TUBESHUFFLE_PUBLISHABLE_KEY",
                          "ValidatedAccountInfo", "validate-account-config", "TUBESHUFFLE_EXPERIMENTAL_AUTH"):
            self.assertNotIn(forbidden, project)
        self.assertFalse((ROOT / "scripts/validate-account-config.sh").exists())

    def test_app_requires_local_debug_and_explicit_opt_in(self):
        app = (ROOT / "TubeShuffle/App/TubeShuffleApp.swift").read_text()
        initializer = re.search(r'@StateObject private var account: AccountViewModel = \{(.*?)\n    \}\(\)', app, re.S)
        self.assertIsNotNone(initializer)
        self.assertRegex(initializer.group(1),
                         r'#if DEBUG && LOCAL_OAUTH_DIAGNOSTIC\s+'
                         r'if ProcessInfo\.processInfo\.arguments\.contains\("--local-two-account-diagnostic"\) \{\s+'
                         r'return AccountViewModel\(twoAccountDiagnostic: TwoAccountDiagnosticModel\(\)\)\s+\}\s+'
                         r'if ProcessInfo\.processInfo\.arguments\.contains\("--local-oauth-diagnostic"\) \{\s+'
                         r'return AccountViewModel\(factory: \{ try LocalOAuthDiagnosticService\(window: \$0\) \}\)\s+'
                         r'\}\s+#endif\s+return AccountViewModel\(\)')
        self.assertEqual(app.count('LocalOAuthDiagnosticService(window:'), 1)
        project = (ROOT / "TubeShuffle.xcodeproj/project.pbxproj").read_text()
        configs = re.findall(r'isa = XCBuildConfiguration; buildSettings = \{([^}]*)\}; name = (Debug|Release);', project)
        self.assertEqual(len(configs), 6)  # project, app and test target configurations
        target_configs = set()
        for settings, name in configs:
            match = re.search(r'SWIFT_ACTIVE_COMPILATION_CONDITIONS = ("[^"]*"|[^;]*);', settings)
            conditions = match.group(1).strip('"').split() if match else []
            if name == "Release":
                self.assertNotIn("DEBUG", conditions)
                self.assertNotIn("LOCAL_OAUTH_DIAGNOSTIC", conditions)
            bundle = re.search(r'PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);', settings)
            if bundle and bundle.group(1) in ("com.tubeshuffle.playbacklab", "com.tubeshuffle.playbacklab.tests"):
                target = bundle.group(1)
                self.assertNotIn((target, name), target_configs)
                target_configs.add((target, name))
            if name == "Debug" and bundle and bundle.group(1) in ("com.tubeshuffle.playbacklab", "com.tubeshuffle.playbacklab.tests"):
                self.assertIn("DEBUG", conditions)
                self.assertIn("LOCAL_OAUTH_DIAGNOSTIC", conditions)
        self.assertEqual(target_configs, {(target, name) for target in
                         ("com.tubeshuffle.playbacklab", "com.tubeshuffle.playbacklab.tests")
                         for name in ("Debug", "Release")})
        for forbidden in ("TubeShuffleProjectOrigin", "TubeShufflePublishableKey", "Bundle.main.infoDictionary"):
            self.assertNotIn(forbidden, app)

    def test_retained_diagnostic_types_and_references_are_guarded(self):
        account = (ROOT / "TubeShuffle/Account/TransientSupabaseAccount.swift").read_text()
        for declaration in ("enum LocalOAuthDiagnosticConfiguration", "final class LocalOAuthDiagnosticService"):
            self.assertEqual(account.count(declaration), 1)
        expected = {
            "TubeShuffle/Account/TransientSupabaseAccount.swift": {
                "LocalOAuthDiagnosticConfiguration", "LocalOAuthDiagnosticService"},
            "TubeShuffle/App/TubeShuffleApp.swift": {"LocalOAuthDiagnosticService"},
            "TubeShuffleTests/Account/TransientSupabaseAccountTests.swift": {
                "LocalOAuthDiagnosticConfiguration", "LocalOAuthDiagnosticConfigurationTests"},
        }
        pattern = re.compile(r'\bLocalOAuthDiagnostic(?:ConfigurationTests|Configuration|Service)\b')
        for relative, required in expected.items():
            stack = []
            found = set()
            for line in (ROOT / relative).read_text().splitlines():
                directive = line.strip()
                if directive.startswith("#if "):
                    stack.append(directive == "#if DEBUG && LOCAL_OAUTH_DIAGNOSTIC")
                elif directive.startswith("#elseif ") or directive == "#else":
                    self.assertTrue(stack, f"unmatched {directive} in {relative}")
                    stack[-1] = False
                elif directive == "#endif":
                    self.assertTrue(stack, f"unmatched #endif in {relative}")
                    stack.pop()
                else:
                    symbols = set(pattern.findall(line))
                    if symbols:
                        found.update(symbols)
                        self.assertIn(True, stack, f"unguarded diagnostic in {relative}: {line}")
            self.assertFalse(stack, f"unclosed conditional in {relative}")
            self.assertTrue(required <= found, f"missing expected diagnostic symbols in {relative}")

    def test_removed_probe_symbols_stay_removed(self):
        forbidden = re.compile(r'\b(?:LocalOAuthDiagnosticOutput|DiagnosticEvent|diagnosticSink|'
                               r'RejectionCategory|rejectionCategory|ParameterShape|'
                               r'rejectedFragmentShapes|diagnosticShapes)\b|\[DEBUG-native-oauth\]')
        sources = list((ROOT / "TubeShuffle").rglob("*.swift")) + list((ROOT / "TubeShuffleTests").rglob("*.swift"))
        self.assertTrue(sources)
        for source in sources:
            self.assertIsNone(forbidden.search(source.read_text()), str(source))

    def test_two_account_diagnostic_is_debug_guarded_and_targeted(self):
        project = (ROOT / "TubeShuffle.xcodeproj/project.pbxproj").read_text()
        paths = ("TubeShuffle/Account/TwoAccountReadOnlyDiagnostic.swift",
                 "TubeShuffleTests/Account/TwoAccountReadOnlyDiagnosticTests.swift")
        objects = dict(re.findall(r'^\s*([A-F0-9]{24}) = \{(.*?)\};', project, re.M))
        targets = {}
        for obj in objects.values():
            match = re.search(r'isa = PBXNativeTarget;.*?buildPhases = \(([^)]*)\);.*?name = (TubeShuffle(?:Tests)?);', obj)
            if match:
                targets[match.group(2)] = re.findall(r'[A-F0-9]{24}', match.group(1))
        self.assertEqual(set(targets), {"TubeShuffle", "TubeShuffleTests"})
        source_phases = {}
        for target, phases in targets.items():
            sources = [objects[p] for p in phases if 'isa = PBXSourcesBuildPhase;' in objects[p]]
            self.assertEqual(len(sources), 1)
            source_phases[target] = set(re.findall(r'[A-F0-9]{24}', sources[0]))
        for path in paths:
            text = (ROOT / path).read_text().strip()
            self.assertTrue(text.startswith('#if DEBUG && LOCAL_OAUTH_DIAGNOSTIC\n'), path)
            self.assertTrue(text.endswith('\n#endif'), path)
            depth = 0
            for line in text.splitlines():
                directive = line.strip()
                if directive.startswith('#if '):
                    depth += 1
                elif directive == '#endif':
                    depth -= 1
                    self.assertGreaterEqual(depth, 0, path)
                elif depth == 1:
                    self.assertFalse(directive == '#else' or directive.startswith('#elseif '), path)
                if depth == 0:
                    self.assertEqual(directive, '#endif', path)
            self.assertEqual(depth, 0, path)
            refs = [key for key, obj in objects.items() if f'path = {path};' in obj]
            self.assertEqual(len(refs), 1, path)
            builds = [key for key, obj in objects.items()
                      if 'isa = PBXBuildFile;' in obj and f'fileRef = {refs[0]};' in obj]
            self.assertEqual(len(builds), 1, path)
            target = 'TubeShuffle' if path.startswith('TubeShuffle/') else 'TubeShuffleTests'
            other = 'TubeShuffleTests' if target == 'TubeShuffle' else 'TubeShuffle'
            self.assertIn(builds[0], source_phases[target])
            self.assertNotIn(builds[0], source_phases[other])


if __name__ == "__main__":
    unittest.main()
