#!/usr/bin/env python3
"""Build/test and package an isolated Apple Silicon local candidate. Never deploys."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
MACOS = ROOT / "macos"


def run(arguments: list[str], log: Path, timeout: int = 900) -> None:
    with log.open("ab") as output:
        result = subprocess.run(arguments, cwd=ROOT, stdout=output, stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}); inspect {log}")


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def source_hashes() -> dict[str, str]:
    suffixes = {".swift", ".plist", ".entitlements", ".pbxproj", ".resolved", ".jpg", ".py", ".sh"}
    sources = sorted(p for p in MACOS.rglob("*")
                     if p.is_file() and p.suffix in suffixes and "__pycache__" not in p.parts)
    return {str(p.relative_to(ROOT)): sha256(p) for p in sources}


def main() -> None:
    initial_sources = source_hashes()
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    parent = ROOT / "build"
    parent.mkdir(exist_ok=True)
    delivery = Path(tempfile.mkdtemp(prefix="tubeshuffle-delivery-", dir=parent))
    os.chmod(delivery, 0o700)
    print(f"Delivery workspace: {delivery}", flush=True)
    product = delivery / "TubeShuffle Local"
    product.mkdir()
    derived = delivery / "derived"
    common = ["xcodebuild", "-project", str(MACOS / "TubeShuffle.xcodeproj"), "-scheme", "TubeShuffle",
              "-destination", "platform=macOS,arch=arm64", "-derivedDataPath", str(derived),
              "-clonedSourcePackagesDirPath", str(delivery / "packages"),
              "-onlyUsePackageVersionsFromResolvedFile", "ONLY_ACTIVE_ARCH=YES", "CODE_SIGNING_ALLOWED=NO"]
    run(common + ["-configuration", "Debug", "test"], delivery / "tests.log")
    print("Hosted tests completed; building Release.", flush=True)
    run(common + ["-configuration", "Release", "build"], delivery / "build.log")
    if source_hashes() != initial_sources:
        raise RuntimeError(f"Native sources changed during validation; no candidate packaged. Logs kept in {delivery}")
    app = product / "TubeShuffle.app"
    run(["ditto", str(derived / "Build/Products/Release/TubeShuffle.app"), str(app)], delivery / "package.log")
    # This new copy alone is signed. No certificate, notarization or public identity is claimed.
    run(["codesign", "--force", "--sign", "-", "--timestamp=none", "--options", "runtime",
         "--entitlements", str(MACOS / "TubeShuffle/Resources/TubeShuffle.entitlements"), str(app)], delivery / "signing.log")
    run(["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)], delivery / "signing.log")
    with (app / "Contents/Info.plist").open("rb") as handle:
        info = plistlib.load(handle)
    assert info["CFBundleIdentifier"] == "com.tubeshuffle.playbacklab"
    assert info["CFBundleURLTypes"][0]["CFBundleURLSchemes"] == ["com.tubeshuffle.playbacklab"]
    entitlement_result = subprocess.run(["codesign", "-d", "--entitlements", ":-", str(app)], capture_output=True, check=True)
    entitlements = plistlib.loads(entitlement_result.stdout)
    expected = plistlib.loads((MACOS / "TubeShuffle/Resources/TubeShuffle.entitlements").read_bytes())
    assert entitlements == expected, "Packaged entitlements differ from the source"
    binary = app / "Contents/MacOS/TubeShuffle"
    architectures = subprocess.check_output(["lipo", "-archs", str(binary)], text=True).strip()
    assert architectures == "arm64", architectures
    manifest = {
        "kind": "local-candidate", "architecture": architectures, "minimumMacOS": info.get("LSMinimumSystemVersion"),
        "head": head,
        "workingTreeChanged": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()),
        "binarySHA256": sha256(binary), "signing": "ad-hoc hardened runtime; not Developer ID; not notarized",
        "entitlements": entitlements, "testsLog": str(delivery / "tests.log"), "buildLog": str(delivery / "build.log"),
        "sourceSHA256": initial_sources,
        "sourcesUnchangedDuringBuild": True,
        "limits": ["No production deployment or library access", "Live account and provider configuration require validation", "YouTube policy and distribution approval remain open"]
    }
    (product / "build-info.json").write_text(json.dumps(manifest, indent=2) + "\n")
    for name, arguments in [("Open Demo.command", " --args --ui-fixture"), ("Open TubeShuffle.command", "")]:
        launcher = product / name
        launcher.write_text('#!/bin/zsh\nset -euo pipefail\nopen -n "${0:A:h}/TubeShuffle.app"' + arguments + '\n')
        launcher.chmod(0o700)
    (product / "READ ME.txt").write_text(
        "TubeShuffle — local Apple Silicon candidate\n\n"
        "Requires macOS 14 or later. Keep this folder together.\n"
        "Open Demo.command: in-memory examples, fresh preferences, account disabled.\n"
        "Open TubeShuffle.command: ordinary app; no automatic library or account login.\n"
        "Library files creates/opens local libraries and exports/imports JSON.\n"
        "Use only a new disposable library until the transfer/reopen check is accepted.\n"
        "Account > Load setup JSON explicitly loads public configuration for review.\n"
        "Use this configuration and Google sign-in are separate actions.\n\n"
        "The browser remains available. Its IndexedDB and this app's SwiftData library\n"
        "are separate; there is no automatic content, queue or history synchronization.\n"
        "JSON transfer copies supported records into a fresh empty native library.\n"
        "Orphan history omissions are disclosed; queue/preferences are not transferred.\n\n"
        "This build is locally ad-hoc signed, not Developer ID signed or notarized.\n"
        "It is not a publicly approved release. Do not disable Gatekeeper globally.\n"
        "Live account/security and YouTube policy acceptance remain separate gates.\n"
    )
    archive = delivery / "TubeShuffle-local-arm64.zip"
    run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(product), str(archive)], delivery / "package.log")
    (delivery / "SHA256SUMS").write_text(f"{sha256(archive)}  {archive.name}\n")
    print(json.dumps({"app": str(app), "archive": str(archive), "checksum": str(delivery / 'SHA256SUMS'), "manifest": str(product / 'build-info.json')}), flush=True)


if __name__ == "__main__":
    main()
