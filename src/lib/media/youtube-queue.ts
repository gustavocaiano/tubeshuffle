import type { VideoItem } from "@/stores/player-store";

export interface YouTubeQueuePlayer {
  loadPlaylist: (ids: string[], index: number, startSeconds: number) => void;
  cuePlaylist: (ids: string[], index: number, startSeconds: number) => void;
  playVideoAt: (index: number) => void;
  playVideo: () => void;
  pauseVideo: () => void;
  setLoop: (loop: boolean) => void;
  setShuffle: (shuffle: boolean) => void;
  getPlaylist: () => string[];
  getPlaylistIndex: () => number;
  getVideoUrl: () => string;
  getPlayerState: () => number;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlaybackRate: () => number;
}

interface QueueState {
  queue: VideoItem[];
  currentIndex: number;
  isPlaying: boolean;
}

interface QueueCallbacks {
  read: () => QueueState;
  select: (index: number, playing: boolean) => void;
  ended: (video: VideoItem) => void;
  resetProgress: (position: number) => void;
}

// The iframe caps ID lists at 200 and can ignore navigation at that boundary.
// Use smaller windows while retaining the complete app queue and global indexes.
const NATIVE_PLAYLIST_LIMIT = 100;

function sameQueue(a: VideoItem[], b: VideoItem[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.id === b[index].id && item.youtubeId === b[index].youtubeId,
    )
  );
}

function currentVideoId(player: YouTubeQueuePlayer): string | null {
  try {
    return new URL(player.getVideoUrl()).searchParams.get("v");
  } catch {
    return null;
  }
}

// YouTube owns the native playlist; the app owns its ordering and editing.
// Acknowledging native selection before notifying the store prevents feedback
// loops and double skips when YouTube advances itself after ENDED.
export class YouTubeQueueController {
  private queue: VideoItem[] = [];
  private index = -1;
  private loadedQueue: VideoItem[] = [];
  private loadedIndex = -1;
  private playlistOffset = 0;
  private nativeQueue: VideoItem[] = [];
  private playing = false;
  private pending = false;
  private endedIndex: number | null = null;
  private expectedEnd: number | null = null;
  private nativeTransitionAt: number | null = null;
  private advanceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private player: YouTubeQueuePlayer,
    private callbacks: QueueCallbacks,
  ) {}

  get isTransitioning(): boolean {
    return this.pending;
  }

  sync(forceReload = false): void {
    const state = this.callbacks.read();
    const selected = state.queue[state.currentIndex];
    if (!selected) {
      this.cancelAdvance();
      this.player.pauseVideo();
      this.queue = [];
      this.index = -1;
      this.loadedQueue = [];
      this.loadedIndex = -1;
      this.playlistOffset = 0;
      this.nativeQueue = [];
      this.pending = false;
      this.expectedEnd = null;
      this.nativeTransitionAt = null;
      this.playing = false;
      this.callbacks.resetProgress(0);
      return;
    }

    const queueChanged = !sameQueue(this.queue, state.queue);
    const indexChanged = this.index !== state.currentIndex;
    const sameTrack =
      queueChanged &&
      this.queue[this.index]?.id === selected.id &&
      this.queue[this.index]?.youtubeId === selected.youtubeId;
    if (sameTrack && !forceReload) {
      // YouTube has no in-place playlist edit API. Keep the active media
      // untouched and apply the latest order on the next track transition.
      if (this.endedIndex === this.index) this.endedIndex = state.currentIndex;
      this.queue = [...state.queue];
      this.index = state.currentIndex;
    } else if (queueChanged || indexChanged || forceReload) {
      const wasPending = this.pending;
      this.cancelAdvance();
      this.queue = [...state.queue];
      this.index = state.currentIndex;
      this.playing = state.isPlaying;
      this.pending = true;
      this.endedIndex = null;
      this.expectedEnd = null;
      this.nativeTransitionAt = null;
      this.callbacks.resetProgress(0);
      if (
        !sameQueue(this.loadedQueue, this.queue) ||
        !state.isPlaying ||
        wasPending ||
        forceReload ||
        this.index < this.playlistOffset ||
        this.index >= this.playlistOffset + this.nativeQueue.length ||
        this.atWindowEdge(this.index)
      ) {
        this.loadedQueue = [...this.queue];
        this.loadedIndex = this.index;
        this.playlistOffset = Math.max(
          0,
          Math.min(
            this.index - NATIVE_PLAYLIST_LIMIT / 2,
            this.queue.length - NATIVE_PLAYLIST_LIMIT,
          ),
        );
        this.nativeQueue = this.queue.slice(
          this.playlistOffset,
          this.playlistOffset + NATIVE_PLAYLIST_LIMIT,
        );
        const ids = this.nativeQueue.map((video) => video.youtubeId);
        const nativeIndex = this.index - this.playlistOffset;
        if (state.isPlaying) this.player.loadPlaylist(ids, nativeIndex, 0);
        else this.player.cuePlaylist(ids, nativeIndex, 0);
        this.player.setLoop(false);
        this.player.setShuffle(false);
      } else {
        this.loadedIndex = this.index;
        this.player.playVideoAt(this.index - this.playlistOffset);
      }
      return;
    }

    if (this.playing !== state.isPlaying) {
      this.playing = state.isPlaying;
      if (state.isPlaying) this.player.playVideo();
      else this.player.pauseVideo();
    }
  }

  observe(playerState: number): void {
    const state = this.callbacks.read();
    if (!this.queue.length || !sameQueue(this.queue, state.queue)) return;

    const playlistIndex = this.player.getPlaylistIndex();
    const nativeIndex =
      playlistIndex < 0 ? -1 : playlistIndex + this.playlistOffset;
    if (
      !this.pending &&
      nativeIndex !== this.loadedIndex &&
      this.nativeTransitionAt === null
    ) {
      this.nativeTransitionAt = performance.now();
    }
    if (nativeIndex === this.loadedIndex) this.nativeTransitionAt = null;
    if (
      (playerState === -1 || playerState === 3) &&
      nativeIndex === this.loadedIndex
    ) {
      // Buffering/seeking on the current track invalidates its projected end.
      this.expectedEnd = null;
    }

    if (playerState === 0) {
      if (this.pending || this.endedIndex === this.index) return;
      this.endedIndex = this.index;
      this.callbacks.ended(this.queue[this.index]);
      if (this.index === this.queue.length - 1) {
        this.playing = false;
        this.callbacks.select(this.index, false);
      } else if (
        !sameQueue(this.loadedQueue, this.queue) ||
        this.loadedIndex === this.playlistOffset + this.nativeQueue.length - 1
      ) {
        this.callbacks.select(this.index + 1, true);
      } else {
        // Normally YouTube advances itself. Recover if it stays at ENDED;
        // never increment an already advanced native or app selection.
        const endedIndex = this.index;
        this.advanceTimer = setTimeout(() => {
          this.advanceTimer = null;
          if (this.player.getPlayerState() !== 0) return;
          const latest = this.callbacks.read();
          if (
            latest.isPlaying &&
            latest.currentIndex === endedIndex &&
            sameQueue(this.queue, latest.queue)
          ) {
            this.callbacks.select(endedIndex + 1, true);
          }
        }, 1500);
      }
      return;
    }

    if (playerState !== 1 && playerState !== 2 && playerState !== 5) return;
    const ids = this.player.getPlaylist();
    if (
      ids.length !== this.nativeQueue.length ||
      ids.some((id, i) => id !== this.nativeQueue[i].youtubeId)
    )
      return;
    if (playlistIndex < 0 || playlistIndex >= this.nativeQueue.length) return;
    const index = nativeIndex;
    const video = this.loadedQueue[index];
    if (!video || (this.pending && index !== this.loadedIndex)) return;
    // Index and video URL are delivered separately by the iframe. Wait until
    // both describe the same track before accepting it as a native skip.
    if (currentVideoId(this.player) !== video.youtubeId) return;
    if (this.pending && playerState !== 1 && state.isPlaying) return;
    if (this.pending && playerState === 1 && !state.isPlaying) {
      this.player.pauseVideo();
      return;
    }

    const changed = index !== this.loadedIndex;
    // Native navigation briefly reports PAUSED/CUED for its new index before
    // it starts. Do not turn that loading state into a paused replacement queue.
    if (
      changed &&
      (!sameQueue(this.loadedQueue, this.queue) || this.atWindowEdge(index)) &&
      state.isPlaying &&
      playerState !== 1
    )
      return;
    if (
      changed &&
      !this.pending &&
      index === this.loadedIndex + 1 &&
      this.endedIndex !== this.index &&
      this.expectedEnd !== null
    ) {
      const transitionAt = this.nativeTransitionAt ?? performance.now();
      // YouTube omits ENDED between native playlist items. Use the previous
      // playing clock and the START of the transition, excluding load time,
      // to distinguish natural completion from an early native skip.
      if (transitionAt >= this.expectedEnd - 200) {
        this.endedIndex = this.index;
        this.callbacks.ended(this.queue[this.index]);
      }
    }
    this.expectedEnd = null;
    this.nativeTransitionAt = null;
    this.pending = false;
    this.playing = playerState === 1;
    if (changed && !sameQueue(this.loadedQueue, this.queue)) {
      // Interpret native next/previous against the edited app queue rather
      // than selecting an obsolete neighbor from YouTube's loaded snapshot.
      const delta = index - this.loadedIndex;
      const target =
        Math.abs(delta) === 1
          ? this.index + delta
          : this.queue.findIndex((item) => item.id === video.id);
      this.cancelAdvance();
      if (target >= 0 && target < this.queue.length && target !== this.index) {
        this.callbacks.select(target, this.playing);
      } else {
        this.callbacks.select(this.index, false);
        this.sync(true);
      }
      return;
    }
    this.loadedIndex = index;
    // While an edit is deferred, the app and native indexes can differ even
    // though they still refer to the same playing occurrence.
    if (sameQueue(this.loadedQueue, this.queue)) this.index = index;
    if (changed) {
      this.cancelAdvance();
      this.callbacks.resetProgress(0);
    }
    if (playerState === 1) {
      this.endedIndex = null;
      const duration = this.player.getDuration();
      const position = this.player.getCurrentTime();
      const rate = this.player.getPlaybackRate();
      if (
        duration > 0 &&
        Number.isFinite(duration) &&
        Number.isFinite(position) &&
        rate > 0 &&
        Number.isFinite(rate)
      ) {
        this.expectedEnd =
          performance.now() + (Math.max(0, duration - position) / rate) * 1000;
      }
    }
    if (state.currentIndex !== this.index || state.isPlaying !== this.playing) {
      this.callbacks.select(this.index, this.playing);
    }
    if (changed && this.atWindowEdge(index)) {
      // Recenter at a track transition so native next/previous remain available
      // at either window edge without reloading a track already in progress.
      this.sync(true);
    }
  }

  dispose(): void {
    this.cancelAdvance();
  }

  private atWindowEdge(index: number): boolean {
    return (
      (index === this.playlistOffset && index > 0) ||
      (index === this.playlistOffset + this.nativeQueue.length - 1 &&
        index < this.queue.length - 1)
    );
  }

  private cancelAdvance(): void {
    if (this.advanceTimer !== null) clearTimeout(this.advanceTimer);
    this.advanceTimer = null;
  }
}
