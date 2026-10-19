import { create } from "zustand";

// Runtime-only state: neither progress nor browser media connections survive a reload.
interface PlaybackState {
  position: number;
  duration: number;
  seekTo: ((seconds: number) => void) | null;
  previous: (() => void) | null;
  disconnectMediaKeys: (() => void) | null;
  connectMediaKeys: (() => Promise<void>) | null;
  mediaKeysStatus: "idle" | "connecting" | "connected" | "unavailable";
}

export const usePlaybackStore = create<PlaybackState>()(() => ({
  position: 0,
  duration: 0,
  seekTo: null,
  previous: null,
  connectMediaKeys: null,
  disconnectMediaKeys: null,
  mediaKeysStatus: "idle",
}));
