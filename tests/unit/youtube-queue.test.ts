import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { YouTubeQueueController } from "@/lib/media/youtube-queue";
import type { VideoItem } from "@/stores/player-store";

const videos: VideoItem[] = ["one", "two", "three"].map((id) => ({
  id,
  youtubeId: id,
  title: id,
  channelTitle: "Artist",
  thumbnail: "",
  duration: 200,
}));

function harness(queue = videos, playing = true) {
  let state = { queue, currentIndex: 0, isPlaying: playing };
  let nativeIds = queue.map((video) => video.youtubeId);
  let nativeIndex = 0;
  let nativeState = playing ? 1 : 5;
  const player = {
    loadPlaylist:
      vi.fn<(ids: string[], index: number, start: number) => void>(),
    cuePlaylist: vi.fn<(ids: string[], index: number, start: number) => void>(),
    playVideoAt: vi.fn(),
    playVideo: vi.fn(),
    pauseVideo: vi.fn(),
    setLoop: vi.fn(),
    setShuffle: vi.fn(),
    getCurrentTime: vi.fn(() => 42),
    getDuration: vi.fn(() => 200),
    getPlaybackRate: vi.fn(() => 1),
    getPlaylist: vi.fn(() => nativeIds),
    getPlaylistIndex: vi.fn(() => nativeIndex),
    getPlayerState: vi.fn(() => nativeState),
    getVideoUrl: vi.fn(
      () => `https://www.youtube.com/watch?v=${nativeIds[nativeIndex]}`,
    ),
  };
  const ended = vi.fn();
  const resetProgress = vi.fn();
  const select = vi.fn((index: number, isPlaying: boolean) => {
    state = { ...state, currentIndex: index, isPlaying };
    controller.sync();
  });
  const controller = new YouTubeQueueController(player, {
    read: () => state,
    select,
    ended,
    resetProgress,
  });
  function native(
    index: number,
    playerState = 1,
    ids = state.queue.map((video) => video.youtubeId),
  ) {
    nativeIds = ids;
    nativeIndex = index;
    nativeState = playerState;
    controller.observe(playerState);
  }
  function update(patch: Partial<typeof state>) {
    state = { ...state, ...patch };
    controller.sync();
  }
  controller.sync();
  native(0, nativeState);
  return {
    player,
    controller,
    native,
    update,
    state: () => state,
    ended,
    resetProgress,
    select,
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("YouTube queue mirroring", () => {
  it("loads the complete ordered queue and disables YouTube shuffle and looping", () => {
    const h = harness();
    expect(h.player.loadPlaylist).toHaveBeenCalledWith(
      ["one", "two", "three"],
      0,
      0,
    );
    expect(h.player.setShuffle).toHaveBeenCalledWith(false);
    expect(h.player.setLoop).toHaveBeenCalledWith(false);
  });

  it("accepts native next and previous without issuing another track command", () => {
    const h = harness();
    h.native(1);
    expect(h.state().currentIndex).toBe(1);
    h.native(0);
    expect(h.state().currentIndex).toBe(0);
    expect(h.player.playVideoAt).not.toHaveBeenCalled();
    expect(h.player.loadPlaylist).toHaveBeenCalledOnce();
    expect(h.ended).not.toHaveBeenCalled();
  });

  it("records an ended track once and lets YouTube advance once", () => {
    const h = harness();
    h.native(0, 0);
    h.native(0, 0);
    expect(h.ended).toHaveBeenCalledExactlyOnceWith(videos[0]);
    h.native(1);
    vi.advanceTimersByTime(2000);
    expect(h.state().currentIndex).toBe(1);
    expect(h.player.playVideoAt).not.toHaveBeenCalled();
  });

  it("records native auto-advance when YouTube omits ENDED between playlist items", () => {
    const h = harness();
    h.player.getCurrentTime.mockReturnValue(199.8);
    h.native(0, 1);
    vi.advanceTimersByTime(250);
    h.native(1, -1);
    h.native(1, 3);
    h.player.getCurrentTime.mockReturnValue(0);
    h.native(1, 1);
    expect(h.ended).toHaveBeenCalledExactlyOnceWith(videos[0]);
    expect(h.state().currentIndex).toBe(1);
    expect(h.player.playVideoAt).not.toHaveBeenCalled();
  });

  it("does not count an early native skip as completed even if the next video loads slowly", () => {
    const h = harness();
    h.player.getCurrentTime.mockReturnValue(199);
    h.native(0, 1);
    vi.advanceTimersByTime(100);
    h.native(1, 3);
    vi.advanceTimersByTime(3000);
    h.player.getCurrentTime.mockReturnValue(0);
    h.native(1, 1);
    expect(h.ended).not.toHaveBeenCalled();
  });

  it("recognizes background auto-advance using the previous playback clock", () => {
    const h = harness();
    vi.advanceTimersByTime(158000);
    h.native(1, -1);
    h.player.getCurrentTime.mockReturnValue(0);
    h.native(1, 1);
    expect(h.ended).toHaveBeenCalledExactlyOnceWith(videos[0]);
  });

  it("recovers an ended playlist that did not advance, without double skipping", () => {
    const h = harness();
    h.native(0, 0);
    vi.advanceTimersByTime(1500);
    expect(h.state().currentIndex).toBe(1);
    expect(h.player.playVideoAt).toHaveBeenCalledExactlyOnceWith(1);
    h.native(1);
    vi.advanceTimersByTime(2000);
    expect(h.state().currentIndex).toBe(1);
  });

  it("stops at the end of the queue instead of looping", () => {
    const h = harness();
    h.native(2);
    h.native(2, 0);
    expect(h.ended).toHaveBeenCalledExactlyOnceWith(videos[2]);
    expect(h.state().isPlaying).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(h.state().currentIndex).toBe(2);
    expect(h.player.playVideoAt).not.toHaveBeenCalled();
  });

  it("preserves position and pause when reordering the current track", () => {
    const h = harness(videos, false);
    h.update({ queue: [videos[1], videos[0], videos[2]], currentIndex: 1 });
    expect(h.player.cuePlaylist).toHaveBeenLastCalledWith(
      ["two", "one", "three"],
      1,
      42,
    );
    expect(h.player.loadPlaylist).not.toHaveBeenCalled();
    h.native(1, 5);
    expect(h.state().isPlaying).toBe(false);
  });

  it("refreshes added and removed tracks while keeping a retained track's position", () => {
    const h = harness();
    h.update({ queue: [videos[0], videos[2]] });
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["one", "three"],
      0,
      42,
    );
    h.native(0);
    h.update({ queue: [videos[2]], currentIndex: 0 });
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(["three"], 0, 0);
  });

  it("ignores stale index and URL updates while an app selection is loading", () => {
    const h = harness();
    h.update({ currentIndex: 2 });
    h.native(1);
    expect(h.select).not.toHaveBeenCalled();
    h.player.getVideoUrl.mockReturnValueOnce(
      "https://www.youtube.com/watch?v=two",
    );
    h.native(2);
    expect(h.controller.isTransitioning).toBe(true);
    h.native(2);
    expect(h.controller.isTransitioning).toBe(false);
    expect(h.state().currentIndex).toBe(2);
  });

  it("resends the playlist for a second selection made before the first is acknowledged", () => {
    const h = harness();
    h.update({ currentIndex: 1 });
    h.update({ currentIndex: 2 });
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["one", "two", "three"],
      2,
      0,
    );
    h.native(1);
    expect(h.controller.isTransitioning).toBe(true);
    h.native(2);
    expect(h.controller.isTransitioning).toBe(false);
    expect(h.state().currentIndex).toBe(2);
  });

  it("retains the requested position through successive paused queue edits", () => {
    const h = harness(videos, false);
    h.update({ queue: [videos[0], videos[2]] });
    h.update({ queue: [videos[0], videos[2], videos[1]] });
    expect(h.player.cuePlaylist).toHaveBeenLastCalledWith(
      ["one", "three", "two"],
      0,
      42,
    );
  });

  it("keeps a user pause made during loading when YouTube starts the new track", () => {
    const h = harness();
    h.update({ currentIndex: 1 });
    h.update({ isPlaying: false });
    h.native(1);
    expect(h.player.pauseVideo).toHaveBeenCalled();
    expect(h.state().isPlaying).toBe(false);
    h.native(1, 2);
    expect(h.controller.isTransitioning).toBe(false);
  });

  it("uses occurrence indexes for repeated videos and starts the next occurrence at zero", () => {
    const h = harness([videos[0], videos[0], videos[1]]);
    h.update({ currentIndex: 1 });
    expect(h.player.playVideoAt).toHaveBeenCalledWith(1);
    expect(h.resetProgress).toHaveBeenLastCalledWith(0);
    h.native(1);
    expect(h.state().currentIndex).toBe(1);
  });

  it("does not truncate long shuffled queues", () => {
    const queue = Array.from({ length: 500 }, (_, i) => ({
      ...videos[0],
      id: String(i),
      youtubeId: String(i),
    }));
    const h = harness(queue);
    expect(h.player.loadPlaylist.mock.calls[0][0]).toHaveLength(500);
    h.native(499);
    expect(h.state().currentIndex).toBe(499);
  });

  it("cancels deferred advancement when clearing or leaving the player", () => {
    const h = harness();
    h.native(0, 0);
    h.update({ queue: [], currentIndex: -1, isPlaying: false });
    vi.advanceTimersByTime(2000);
    expect(h.state().currentIndex).toBe(-1);
    const other = harness();
    other.native(0, 0);
    other.controller.dispose();
    vi.advanceTimersByTime(2000);
    expect(other.select).not.toHaveBeenCalled();
  });
});
