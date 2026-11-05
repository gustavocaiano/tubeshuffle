#!/bin/zsh
# Explicit owner-run UI rehearsal. No production profile, library or login.
set -euo pipefail
script_directory=${0:A:h}
project_directory=${script_directory:h}
rehearsal_directory=$(mktemp -d -t tubeshuffle-ui)
chmod 700 "$rehearsal_directory"
print -r -- "UI rehearsal files: $rehearsal_directory"
print -r -- "Building the current checkout; build log: $rehearsal_directory/build.log"
xcodebuild -project "$project_directory/TubeShuffle.xcodeproj" -scheme TubeShuffle \
  -configuration Debug -destination 'platform=macOS,arch=arm64' \
  -derivedDataPath "$rehearsal_directory/derived" \
  -onlyUsePackageVersionsFromResolvedFile ONLY_ACTIVE_ARCH=YES CODE_SIGNING_ALLOWED=NO \
  build > "$rehearsal_directory/build.log" 2>&1
print -r -- "Opening the in-memory demo. Account access is disabled; playback starts only when you choose it."
print -r -- "For transfer checks, save the demo JSON and create the new library only inside: $rehearsal_directory"
open -n "$rehearsal_directory/derived/Build/Products/Debug/TubeShuffle.app" --args --ui-fixture
