#!/usr/bin/env python3
"""Compile/run only the pure synthetic PlaylistAPIImport contract checks."""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCES = [
    ROOT / "TubeShuffle/Domain/Library/LibrarySnapshot.swift",
    ROOT / "TubeShuffle/Domain/DTO/APIModels.swift",
    ROOT / "TubeShuffle/Domain/Transfer/RawJSONScanner.swift",
    ROOT / "TubeShuffle/Domain/Transfer/TransferV1.swift",
    ROOT / "TubeShuffle/Domain/Library/PlaylistAPIImport.swift",
    ROOT / "tests/playlist_api_import_synthetic.swift",
]


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="tubeshuffle-api-import-", dir="/private/tmp") as build:
        binary = Path(build) / "probe"
        compiled = subprocess.run(["xcrun", "swiftc", "-swift-version", "5", *map(str, SOURCES), "-o", str(binary)],
                                 text=True, capture_output=True, timeout=180)
        assert compiled.returncode == 0, compiled.stderr
        run = subprocess.run([str(binary)], text=True, capture_output=True, timeout=30)
        assert run.returncode == 0, run.stderr or run.stdout
        assert run.stdout.strip() == "PlaylistAPIImport synthetic checks passed", run.stdout
        print(run.stdout, end="")


if __name__ == "__main__":
    main()
