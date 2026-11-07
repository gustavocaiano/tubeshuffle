import manifest from "@/config/macos-release.json";

export interface MacOSRelease {
  version: string;
  downloadURL: string;
  releaseNotesURL: string;
  sha256: string;
}

// Only a reviewed, versioned asset in this repository can become a download.
// The manifest stays null until distribution is separately approved.
// See macos/README.md, “Website download and release handoff”.
export function resolveMacOSRelease(value: unknown): MacOSRelease | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const { version, tag, fileName, sha256 } = value as Record<string, unknown>;
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version) ||
    typeof tag !== "string" ||
    !/^(?:macos-)?v?\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag) ||
    tag.replace(/^(?:macos-)?v?/, "") !== version ||
    typeof fileName !== "string" ||
    !/^TubeShuffle-[a-zA-Z0-9._-]+-arm64\.zip$/.test(fileName) ||
    typeof sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(sha256)
  ) {
    return null;
  }

  const releases = "https://github.com/gustavocaiano/tubeshuffle/releases";
  return {
    version,
    downloadURL: `${releases}/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`,
    releaseNotesURL: `${releases}/tag/${encodeURIComponent(tag)}`,
    sha256,
  };
}

export const macOSRelease = resolveMacOSRelease(manifest);
