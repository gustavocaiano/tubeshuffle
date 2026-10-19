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
    loadPlaylist: vi.fn<(ids: string[], index: number, start: number) => void>(
      (ids) => {
        nativeIds = ids.slice(0, 200);
      },
    ),
    cuePlaylist: vi.fn<(ids: string[], index: number, start: number) => void>(
      (ids) => {
        nativeIds = ids.slice(0, 200);
      },
    ),
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
  function native(index: number, playerState = 1, ids = nativeIds) {
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

  it("leaves paused media untouched when reordering the current track", () => {
    const h = harness(videos, false);
    h.update({ queue: [videos[1], videos[0], videos[2]], currentIndex: 1 });
    expect(h.player.cuePlaylist).toHaveBeenCalledOnce();
    expect(h.player.loadPlaylist).not.toHaveBeenCalled();
    h.native(0, 5, ["one", "two", "three"]);
    expect(h.state().currentIndex).toBe(1);
    expect(h.state().isPlaying).toBe(false);
    h.update({ isPlaying: true });
    expect(h.player.playVideo).toHaveBeenCalledOnce();
    expect(h.player.loadPlaylist).not.toHaveBeenCalled();
  });

  it("defers upcoming queue edits without reloading or resetting progress", () => {
    const h = harness();
    h.player.loadPlaylist.mockClear();
    h.resetProgress.mockClear();
    h.update({ queue: [videos[0], videos[2]] });
    h.native(0, 1, ["one", "two", "three"]);
    expect(h.controller.isTransitioning).toBe(false);
    expect(h.player.loadPlaylist).not.toHaveBeenCalled();
    expect(h.player.cuePlaylist).not.toHaveBeenCalled();
    expect(h.player.playVideoAt).not.toHaveBeenCalled();
    expect(h.resetProgress).not.toHaveBeenCalled();
    h.update({ queue: [videos[2]], currentIndex: 0 });
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(["three"], 0, 0);
  });

  it("loads the latest appended queue only when the user skips", () => {
    const h = harness(videos.slice(0, 2));
    h.update({ queue: videos });
    expect(h.player.loadPlaylist).toHaveBeenCalledOnce();
    h.update({ currentIndex: 1 });
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["one", "two", "three"],
      1,
      0,
    );
    h.native(1);
    expect(h.state().currentIndex).toBe(1);
  });

  it("uses the edited next track when native next targets an obsolete neighbor", () => {
    const h = harness();
    h.update({ queue: [videos[0], videos[2], videos[1]] });
    h.native(1, 1, ["one", "two", "three"]);
    expect(h.state().currentIndex).toBe(1);
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["one", "three", "two"],
      1,
      0,
    );
    expect(h.ended).not.toHaveBeenCalled();
    h.native(1);
    expect(h.controller.isTransitioning).toBe(false);
  });

  it("uses the edited previous track after the playing occurrence moves", () => {
    const h = harness();
    h.native(1);
    h.update({ queue: [videos[2], videos[0], videos[1]], currentIndex: 2 });
    h.native(1, 1, ["one", "two", "three"]);
    expect(h.state().currentIndex).toBe(2);
    expect(h.player.loadPlaylist).toHaveBeenCalledOnce();
    h.native(0, 1, ["one", "two", "three"]);
    expect(h.state().currentIndex).toBe(1);
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["three", "one", "two"],
      1,
      0,
    );
  });

  it("waits through transient native pause while an edited queue advances", () => {
    const h = harness();
    h.update({ queue: [videos[0], videos[2], videos[1]] });
    h.native(1, 2, ["one", "two", "three"]);
    h.native(1, 3, ["one", "two", "three"]);
    expect(h.state().isPlaying).toBe(true);
    expect(h.player.cuePlaylist).not.toHaveBeenCalled();
    h.native(1, 1, ["one", "two", "three"]);
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["one", "three", "two"],
      1,
      0,
    );
    h.native(1);
    expect(h.state().isPlaying).toBe(true);
  });

  it("advances to an appended track when the loaded native playlist ends", () => {
    const h = harness([videos[0]]);
    h.update({ queue: [videos[0], videos[1]] });
    h.native(0, 0, ["one"]);
    expect(h.ended).toHaveBeenCalledExactlyOnceWith(videos[0]);
    expect(h.state().currentIndex).toBe(1);
    expect(h.state().isPlaying).toBe(true);
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["one", "two"],
      1,
      0,
    );
    h.native(0, 0, ["one"]);
    h.native(1);
    vi.advanceTimersByTime(2000);
    expect(h.ended).toHaveBeenCalledOnce();
    expect(h.state().currentIndex).toBe(1);
  });

  it("records completion and applies edits when native auto-advance omits ENDED", () => {
    const h = harness();
    h.player.getCurrentTime.mockReturnValue(199.8);
    h.native(0);
    h.update({ queue: [videos[0], videos[2]] });
    vi.advanceTimersByTime(250);
    h.native(1, -1, ["one", "two", "three"]);
    h.player.getCurrentTime.mockReturnValue(0);
    h.native(1, 1, ["one", "two", "three"]);
    expect(h.ended).toHaveBeenCalledExactlyOnceWith(videos[0]);
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      ["one", "three"],
      1,
      0,
    );
    h.native(1);
    expect(h.state().currentIndex).toBe(1);
    expect(h.ended).toHaveBeenCalledOnce();
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

  it("does not reload for successive edits while the selected track is still loading", () => {
    const h = harness(videos, false);
    h.update({ currentIndex: 1 });
    h.update({ queue: [videos[0], videos[1]] });
    h.update({ queue: [videos[0], videos[1], videos[2], videos[0]] });
    expect(h.player.cuePlaylist).toHaveBeenCalledTimes(2);
    expect(h.player.cuePlaylist).toHaveBeenLastCalledWith(
      ["one", "two", "three"],
      1,
      0,
    );
    h.native(1, 5, ["one", "two", "three"]);
    expect(h.controller.isTransitioning).toBe(false);
    expect(h.state().currentIndex).toBe(1);
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

  it("follows native playback when YouTube caps a long queue at 200 tracks", () => {
    const queue = Array.from({ length: 500 }, (_, i) => ({
      ...videos[0],
      id: String(i),
      youtubeId: String(i),
    }));
    const h = harness(queue);
    expect(h.controller.isTransitioning).toBe(false);
    h.native(1);
    expect(h.state().currentIndex).toBe(1);
    expect(h.state().queue).toHaveLength(500);
  });

  it("maps selections, native next, and previous through a window's offset", () => {
    const queue = Array.from({ length: 500 }, (_, i) => ({
      ...videos[0],
      id: String(i),
      youtubeId: String(i),
    }));
    const h = harness(queue);
    h.update({ currentIndex: 250 });
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      queue.slice(200, 300).map((v) => v.youtubeId),
      50,
      0,
    );
    h.native(50);
    expect(h.controller.isTransitioning).toBe(false);
    h.native(51);
    expect(h.state().currentIndex).toBe(251);
    h.native(50);
    expect(h.state().currentIndex).toBe(250);
    h.update({ currentIndex: 251 });
    expect(h.player.playVideoAt).toHaveBeenLastCalledWith(51);
    h.native(51);
    h.native(0);
    expect(h.state().currentIndex).toBe(200);
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      queue.slice(150, 250).map((v) => v.youtubeId),
      50,
      0,
    );
    h.native(50);
    h.native(49);
    expect(h.state().currentIndex).toBe(199);
  });

  it.each([true, false])(
    "follows automatic advancement in a long queue with an ENDED event: %s",
    (emitsEnded) => {
      const queue = Array.from({ length: 500 }, (_, i) => ({
        ...videos[0],
        id: String(i),
        youtubeId: String(i),
      }));
      const h = harness(queue);
      h.update({ currentIndex: 250 });
      h.native(50);
      h.player.getCurrentTime.mockReturnValue(199.8);
      h.native(50);
      vi.advanceTimersByTime(250);
      if (emitsEnded) h.native(50, 0);
      h.native(51, -1);
      h.native(51, 3);
      h.player.getCurrentTime.mockReturnValue(0);
      h.native(51);
      vi.advanceTimersByTime(2000);
      expect(h.state().currentIndex).toBe(251);
      expect(h.state().isPlaying).toBe(true);
      expect(h.ended).toHaveBeenCalledExactlyOnceWith(queue[250]);
      expect(h.player.playVideoAt).not.toHaveBeenCalled();
    },
  );

  it("recenters the native window at its edge so the full queue stays navigable", () => {
    const queue = Array.from({ length: 500 }, (_, i) => ({
      ...videos[0],
      id: String(i),
      youtubeId: String(i),
    }));
    const h = harness(queue);
    h.native(99, 2);
    expect(h.state().isPlaying).toBe(true);
    expect(h.player.cuePlaylist).not.toHaveBeenCalled();
    h.native(99);
    expect(h.state().currentIndex).toBe(99);
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      queue.slice(49, 149).map((v) => v.youtubeId),
      50,
      0,
    );
    h.native(50);
    h.native(51);
    expect(h.state().currentIndex).toBe(100);
    h.update({ currentIndex: 499 });
    expect(h.player.loadPlaylist).toHaveBeenLastCalledWith(
      queue.slice(400).map((v) => v.youtubeId),
      99,
      0,
    );
    h.native(99);
    expect(h.controller.isTransitioning).toBe(false);
    expect(h.state().currentIndex).toBe(499);
  });

  it("keeps queue additions deferred in long queues and applies them on native next", () => {
    const queue = Array.from({ length: 500 }, (_, i) => ({
      ...videos[0],
      id: String(i),
      youtubeId: String(i),
    }));
    const h = harness(queue);
    h.update({ queue: [...queue, videos[1]] });
    expect(h.player.loadPlaylist).toHaveBeenCalledOnce();
    h.native(1);
    expect(h.state().currentIndex).toBe(1);
    expect(h.state().queue).toHaveLength(501);
    h.native(1);
    expect(h.controller.isTransitioning).toBe(false);
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
