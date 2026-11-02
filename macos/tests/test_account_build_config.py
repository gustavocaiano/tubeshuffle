#!/usr/bin/env python3
"""Offline structural regression checks; no Xcode or network required."""
from pathlib import Path
import plistlib
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

    def test_app_has_no_live_account_configuration_path(self):
        app = (ROOT / "TubeShuffle/App/TubeShuffleApp.swift").read_text()
        self.assertIn("@StateObject private var account = AccountViewModel()", app)
        for forbidden in ("TrustedAccountConfiguration", "SupabaseTemporaryAccount",
                          "TubeShuffleProjectOrigin", "TubeShufflePublishableKey",
                          "TUBESHUFFLE_EXPERIMENTAL_AUTH", "Bundle.main.infoDictionary"):
            self.assertNotIn(forbidden, app)


if __name__ == "__main__":
    unittest.main()
