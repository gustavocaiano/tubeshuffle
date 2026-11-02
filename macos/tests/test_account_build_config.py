#!/usr/bin/env python3
"""Offline structural regression checks; no Xcode or network required."""
from pathlib import Path
import plistlib
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AccountBuildConfigTests(unittest.TestCase):
    def test_plist_contains_only_callback_registration(self):
        plist = plistlib.loads((ROOT / "TubeShuffle/Resources/Info.plist").read_bytes())
        self.assertEqual(set(plist), {"CFBundleURLTypes"})
        self.assertEqual(plist["CFBundleURLTypes"][0]["CFBundleURLSchemes"],
                         ["com.tubeshuffle.playbacklab"])
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
                         r'if ProcessInfo\.processInfo\.arguments\.contains\("--local-oauth-diagnostic"\) \{\s+'
                         r'LocalOAuthDiagnosticOutput\.emit\(\.ready\)\s+'
                         r'return AccountViewModel\(factory: \{ try LocalOAuthDiagnosticService\(window: \$0\) \}\)\s+'
                         r'\}\s+#endif\s+return AccountViewModel\(\)')
        self.assertEqual(app.count('LocalOAuthDiagnosticService(window:'), 1)
        project = (ROOT / "TubeShuffle.xcodeproj/project.pbxproj").read_text()
        configs = re.findall(r'isa = XCBuildConfiguration; buildSettings = \{([^}]*)\}; name = (Debug|Release);', project)
        self.assertEqual(len(configs), 6)  # project, app and test target configurations
        for settings, name in configs:
            match = re.search(r'SWIFT_ACTIVE_COMPILATION_CONDITIONS = ("[^"]*"|[^;]*);', settings)
            conditions = match.group(1).strip('"').split() if match else []
            if name == "Release":
                self.assertNotIn("DEBUG", conditions)
                self.assertNotIn("LOCAL_OAUTH_DIAGNOSTIC", conditions)
            elif "PRODUCT_BUNDLE_IDENTIFIER = com.tubeshuffle.playbacklab;" in settings:
                self.assertIn("DEBUG", conditions)
                self.assertIn("LOCAL_OAUTH_DIAGNOSTIC", conditions)
        for forbidden in ("TubeShuffleProjectOrigin", "TubeShufflePublishableKey", "Bundle.main.infoDictionary"):
            self.assertNotIn(forbidden, app)

    def test_temporary_diagnostic_symbols_are_guarded(self):
        for relative in ("TubeShuffle/App/TubeShuffleApp.swift", "TubeShuffle/Account/TransientSupabaseAccount.swift",
                         "TubeShuffle/Account/TransientOAuthCallback.swift", "TubeShuffleTests/Account/TransientOAuthCallbackTests.swift",
                         "TubeShuffleTests/Account/TransientSupabaseAccountTests.swift"):
            stack = []
            for line in (ROOT / relative).read_text().splitlines():
                directive = line.strip()
                if directive.startswith("#if "):
                    stack.append(directive == "#if DEBUG && LOCAL_OAUTH_DIAGNOSTIC")
                elif directive == "#else":
                    stack[-1] = False
                elif directive == "#endif":
                    stack.pop()
                elif re.search(r'LocalOAuthDiagnostic(?:Configuration|Service|Output)|DiagnosticEvent|diagnosticSink|RejectionCategory|rejectionCategory|ParameterShape|rejectedFragmentShapes|diagnosticShapes|\[DEBUG-native-oauth\]', line):
                    self.assertIn(True, stack, f"unguarded diagnostic in {relative}: {line}")
            self.assertFalse(stack)


if __name__ == "__main__":
    unittest.main()
