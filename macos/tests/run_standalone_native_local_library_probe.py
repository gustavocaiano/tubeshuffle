#!/usr/bin/env python3
"""Compile and run only synthetic, disposable NativeLocalLibraryStore checks."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCES = [
    ROOT / "TubeShuffle/Domain/Library/LibrarySnapshot.swift",
    ROOT / "TubeShuffle/Domain/Transfer/RawJSONScanner.swift",
    ROOT / "TubeShuffle/Persistence/SwiftDataLibraryRepository.swift",
    ROOT / "TubeShuffle/Persistence/NativeLocalLibraryStore.swift",
    ROOT / "tests/standalone_native_local_library_probe.swift",
]


def event(process: subprocess.Popen[str]) -> dict:
    line = process.stdout.readline()
    if not line:
        raise AssertionError(f"probe ended early: {process.stderr.read()}")
    return json.loads(line)


def run(binary: Path, mode: str, root: Path) -> None:
    result = subprocess.run([str(binary), mode, str(root)], text=True, capture_output=True, timeout=45)
    assert result.returncode == 0, result.stderr or result.stdout
    assert json.loads(result.stdout.splitlines()[-1])["event"] == "ok", result.stdout


def main() -> None:
    fixture = Path(tempfile.mkdtemp(prefix="tubeshuffle-native-store-", dir="/private/tmp"))
    build = Path(tempfile.mkdtemp(prefix="tubeshuffle-native-store-build-", dir="/private/tmp"))
    os.chmod(fixture, 0o700)
    try:
        binary = build / "probe"
        compile_result = subprocess.run(
            ["xcrun", "swiftc", "-swift-version", "5", *map(str, SOURCES), "-o", str(binary)],
            text=True, capture_output=True, timeout=180,
        )
        assert compile_result.returncode == 0, compile_result.stderr

        exercise = fixture / "exercise"
        lock = fixture / "lock"
        exercise.mkdir(mode=0o700)
        lock.mkdir(mode=0o700)
        run(binary, "exercise", exercise)

        holder = subprocess.Popen([str(binary), "create-hold", str(lock)], text=True,
                                  stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert event(holder) == {"event": "holding", "value": "create"}
        run(binary, "contend", lock)
        assert holder.stdin is not None
        holder.stdin.write("exit\n")
        holder.stdin.flush()
        assert holder.wait(timeout=20) == 0, holder.stderr.read()
        run(binary, "open", lock)
        print("standalone native local library probe: ok")
    finally:
        shutil.rmtree(fixture, ignore_errors=True)
        shutil.rmtree(build, ignore_errors=True)


if __name__ == "__main__":
    main()
