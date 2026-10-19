import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPlayer } from "@/components/playlist/VideoPlayer";
import { PlaybackControls } from "@/components/playlist/PlaybackControls";
import { usePlayerStore, type VideoItem } from "@/stores/player-store";
import { usePlaybackStore } from "@/stores/playback-store";

vi.mock("@/lib/media/silent-audio", () => ({
  createSilentAudioUrl: () => "blob:test-silence",
}));

const videos: VideoItem[] = ["one", "two"].map((id) => ({
  id,
  youtubeId: id,
  title: id,
  channelTitle: "Artist",
  thumbnail: "",
  duration: 200,
}));
let nativeIds: string[];
let nativeIndex: number;
let mounts: HTMLElement[];
let handlers: Map<MediaSessionAction, MediaSessionActionHandler>;
let events: Record<
  string,
  (event: { data?: number; target: typeof player }) => void
>;
const player = {
  playVideo: vi.fn(),
  pauseVideo: vi.fn(),
  loadPlaylist: vi.fn((ids: string[], index: number) => {
    nativeIds = ids;
    nativeIndex = index;
  }),
  cuePlaylist: vi.fn((ids: string[], index: number) => {
    nativeIds = ids;
    nativeIndex = index;
  }),
  playVideoAt: vi.fn((index: number) => {
    nativeIndex = index;
  }),
  setLoop: vi.fn(),
  setShuffle: vi.fn(),
  getPlaylist: vi.fn(() => nativeIds),
  getPlaylistIndex: vi.fn(() => nativeIndex),
  getVideoUrl: vi.fn(
    () => `https://www.youtube.com/watch?v=${nativeIds[nativeIndex]}`,
  ),
  getPlayerState: vi.fn(() => 1),
  setVolume: vi.fn(),
  getCurrentTime: vi.fn(() => 30),
  getDuration: vi.fn(() => 200),
  getPlaybackRate: vi.fn(() => 1),
  seekTo: vi.fn(),
  destroy: vi.fn(),
};

function ready() {
  act(() => {
    events.onReady({ target: player });
    events.onStateChange({ target: player, data: 1 });
  });
}
function action(
  action: MediaSessionAction,
  details: Partial<MediaSessionActionDetails> = {},
) {
  act(() => handlers.get(action)?.({ action, ...details }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  player.getCurrentTime.mockReturnValue(30);
  player.getDuration.mockReturnValue(200);
  handlers = new Map();
  mounts = [];
  nativeIds = [];
  nativeIndex = 0;
  Object.defineProperty(navigator, "mediaSession", {
    configurable: true,
    value: {
      setActionHandler: vi.fn((action, handler) =>
        handler ? handlers.set(action, handler) : handlers.delete(action),
      ),
      setPositionState: vi.fn(),
      metadata: null,
      playbackState: "none",
    },
  });
  window.YT = {
    Player: class {
      constructor(mount: HTMLElement, config: { events: typeof events }) {
        mounts.push(mount);
        events = config.events;
        return player;
      }
    } as unknown as typeof window.YT.Player,
    PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0, BUFFERING: 3, CUED: 5 },
  };
  usePlayerStore.getState().setQueue(videos, "playlist", "Playlist");
});
afterEach(() => {
  cleanup();
  usePlayerStore.getState().clearQueue();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("YouTube playback and system actions", () => {
  it("creates a fresh iframe mount during Strict Mode effect replay", () => {
    render(
      <React.StrictMode>
        <VideoPlayer />
      </React.StrictMode>,
    );
    expect(mounts).toHaveLength(2);
    expect(mounts[0].isConnected).toBe(false);
    expect(mounts[1].isConnected).toBe(true);
    ready();
    expect(player.loadPlaylist).toHaveBeenCalledWith(["one", "two"], 0, 0);
  });

  it("shows paused playback when the browser blocks autoplay", () => {
    render(<VideoPlayer />);
    ready();
    act(() => events.onAutoplayBlocked({ target: player }));
    expect(usePlayerStore.getState().isPlaying).toBe(false);
  });

  it("waits for the iframe to be ready before sending commands", () => {
    render(<VideoPlayer />);
    act(() => usePlayerStore.getState().setVolume(60));
    expect(player.setVolume).not.toHaveBeenCalled();
    ready();
    expect(player.setVolume).toHaveBeenCalledWith(60);
  });

  it("publishes progress, seeks within the track, and skips through the queue", () => {
    render(<VideoPlayer />);
    ready();
    act(() => vi.advanceTimersByTime(500));
    expect(usePlaybackStore.getState().position).toBe(30);
    expect(handlers.has("seekforward")).toBe(false);
    expect(handlers.has("seekbackward")).toBe(false);
    action("seekto", { seekTime: 999 });
    expect(player.seekTo).toHaveBeenLastCalledWith(200, true);
    action("nexttrack");
    expect(usePlayerStore.getState().currentIndex).toBe(1);
    expect(player.playVideoAt).toHaveBeenCalledWith(1);
    expect(usePlaybackStore.getState().position).toBe(0);
  });

  it("restarts after five seconds and otherwise goes to the previous track", () => {
    render(<VideoPlayer />);
    ready();
    action("nexttrack");
    act(() => events.onStateChange({ target: player, data: 1 }));
    action("previoustrack");
    expect(player.seekTo).toHaveBeenLastCalledWith(0, true);
    expect(usePlayerStore.getState().currentIndex).toBe(1);
    player.getCurrentTime.mockReturnValue(2);
    action("previoustrack");
    expect(usePlayerStore.getState().currentIndex).toBe(0);
  });

  it("preserves the player when switching presentation and clearing the queue", () => {
    const view = render(<VideoPlayer />);
    ready();
    view.rerender(<VideoPlayer overlay={<div>Focus</div>} />);
    expect(player.destroy).not.toHaveBeenCalled();
    expect(player.playVideoAt).not.toHaveBeenCalled();
    act(() => usePlayerStore.getState().clearQueue());
    expect(player.pauseVideo).toHaveBeenCalled();
    act(() =>
      usePlayerStore.getState().setQueue(videos, "playlist", "Playlist"),
    );
    expect(player.destroy).not.toHaveBeenCalled();
  });

  it("connects media keys only on request and releases the silent connection", async () => {
    const audio = {
      src: "blob:test-silence",
      loop: false,
      play: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn(),
      removeAttribute: vi.fn(),
      load: vi.fn(),
    };
    const revoke = vi.fn();
    vi.stubGlobal(
      "Audio",
      class {
        constructor() {
          return audio;
        }
      },
    );
    vi.stubGlobal("URL", { revokeObjectURL: revoke });
    const view = render(<VideoPlayer />);
    expect(audio.play).not.toHaveBeenCalled();
    await act(async () => {
      await usePlaybackStore.getState().connectMediaKeys?.();
    });
    expect(usePlaybackStore.getState().mediaKeysStatus).toBe("connected");
    act(() => usePlayerStore.getState().setPlaying(false));
    expect(audio.pause).toHaveBeenCalled();
    act(() => usePlayerStore.getState().setPlaying(true));
    expect(audio.play).toHaveBeenCalledTimes(2);
    view.unmount();
    expect(revoke).toHaveBeenCalledWith("blob:test-silence");
    expect(audio.load).toHaveBeenCalled();
    expect(usePlaybackStore.getState().mediaKeysStatus).toBe("idle");
  });

  it("reports a denied media connection without breaking playback", async () => {
    vi.stubGlobal(
      "Audio",
      class {
        play = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
        pause = vi.fn();
        removeAttribute = vi.fn();
        load = vi.fn();
        src = "blob:test-silence";
      },
    );
    vi.stubGlobal("URL", { revokeObjectURL: vi.fn() });
    render(<VideoPlayer />);
    await act(async () => {
      await usePlaybackStore.getState().connectMediaKeys?.();
    });
    expect(usePlaybackStore.getState().mediaKeysStatus).toBe("unavailable");
    expect(usePlayerStore.getState().isPlaying).toBe(true);
  });

  it("clears system handlers and runtime controls on unmount", () => {
    const view = render(<VideoPlayer />);
    ready();
    view.unmount();
    expect(handlers.size).toBe(0);
    expect(navigator.mediaSession.playbackState).toBe("none");
    expect(usePlaybackStore.getState().seekTo).toBeNull();
    expect(player.destroy).toHaveBeenCalledOnce();
  });

  it("does not hijack Space on a focused button or shortcuts while typing", () => {
    render(
      <>
        <VideoPlayer />
        <button>Other control</button>
        <input aria-label="Search" />
      </>,
    );
    ready();
    const before = usePlayerStore.getState().isPlaying;
    fireEvent.keyDown(screen.getByRole("button"), { key: " " });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "k" });
    expect(usePlayerStore.getState().isPlaying).toBe(before);
    fireEvent.keyDown(document.body, { key: "k" });
    expect(usePlayerStore.getState().isPlaying).toBe(!before);
  });
});

describe("shared progress control", () => {
  it("renders safely before a track has been selected", () => {
    usePlayerStore.getState().clearQueue();
    render(<PlaybackControls />);
    expect(
      (
        screen.getByRole("slider", {
          name: "Playback position",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });

  it("formats YouTube's fractional seconds as a stable clock", () => {
    usePlaybackStore.setState({
      position: 61.75,
      duration: 200.8,
      seekTo: vi.fn(),
    });
    render(<PlaybackControls />);
    expect(
      screen
        .getByRole("slider", { name: "Playback position" })
        .getAttribute("aria-valuetext"),
    ).toBe("1:01 of 3:20");
  });

  it("previews a seek, commits on release, and discards it when the track changes", () => {
    const seekTo = vi.fn();
    usePlaybackStore.setState({ position: 30, duration: 200, seekTo });
    render(<PlaybackControls stage />);
    const slider = screen.getByRole("slider", { name: "Playback position" });
    fireEvent.change(slider, { target: { value: "90" } });
    expect(seekTo).not.toHaveBeenCalled();
    fireEvent.pointerUp(slider);
    expect(seekTo).toHaveBeenCalledWith(90);
    fireEvent.change(slider, { target: { value: "120" } });
    act(() => usePlayerStore.getState().playNext());
    fireEvent.pointerUp(slider);
    expect(seekTo).toHaveBeenCalledTimes(1);
  });
});
