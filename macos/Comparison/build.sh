#!/bin/sh
set -eu
cd "$(dirname "$0")"
out="${1:-/tmp/tubeshuffle-comparison}"
app="$out/Direct Playback Comparison.app"
mkdir -p "$app/Contents/MacOS"
cp Info.plist "$app/Contents/Info.plist"
xcrun swiftc -swift-version 5 -target "$(uname -m)-apple-macosx13.0" -framework AppKit -framework WebKit QueueState.swift main.swift -o "$app/Contents/MacOS/Comparison"
codesign --force --sign - --entitlements entitlements.plist "$app"
printf 'Built: %s\n' "$app"
