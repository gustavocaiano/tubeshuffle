import { describe, expect, it } from "vitest";
import { resolveMacOSRelease } from "@/lib/macos-release";

const release = {
  version: "0.1.0",
  tag: "macos-v0.1.0",
  fileName: "TubeShuffle-0.1.0-macos-arm64.zip",
  sha256: "a".repeat(64),
};

describe("macOS download publication", () => {
  it.each([null, undefined, {}, [], "https://example.com/app.zip"])(
    "does not offer a download for absent or incomplete release metadata: %j",
    (value) => expect(resolveMacOSRelease(value)).toBeNull(),
  );

  it("pins the download and notes to the same version in this repository", () => {
    expect(resolveMacOSRelease(release)).toEqual({
      version: "0.1.0",
      downloadURL:
        "https://github.com/gustavocaiano/tubeshuffle/releases/download/macos-v0.1.0/TubeShuffle-0.1.0-macos-arm64.zip",
      releaseNotesURL:
        "https://github.com/gustavocaiano/tubeshuffle/releases/tag/macos-v0.1.0",
      sha256: release.sha256,
    });
  });

  it.each([
    { version: "preview" },
    { tag: "latest" },
    { tag: "macos-v0.2.0" },
    { tag: "../another-repo" },
    { fileName: "https://example.com/app.zip" },
    { fileName: "../TubeShuffle-0.1.0-arm64.zip" },
    { fileName: "TubeShuffle-0.1.0-arm64.dmg" },
    { fileName: "TubeShuffle-0.1.0-x86_64.zip" },
    { sha256: "" },
    { sha256: "g".repeat(64) },
  ])("keeps invalid release metadata unavailable: %j", (change) => {
    expect(resolveMacOSRelease({ ...release, ...change })).toBeNull();
  });
});
