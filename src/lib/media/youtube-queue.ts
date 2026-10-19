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
  private playing = false;
  private pending = false;
  private startPosition = 0;
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

  sync(): void {
    const state = this.callbacks.read();
    const selected = state.queue[state.currentIndex];
    if (!selected) {
      this.cancelAdvance();
      this.player.pauseVideo();
      this.queue = [];
      this.index = -1;
      this.pending = false;
      this.expectedEnd = null;
      this.nativeTransitionAt = null;
      this.playing = false;
      this.callbacks.resetProgress(0);
      return;
    }

    const queueChanged = !sameQueue(this.queue, state.queue);
    const indexChanged = this.index !== state.currentIndex;
    if (queueChanged || indexChanged) {
      const wasPending = this.pending;
      this.cancelAdvance();
      const sameTrack =
        queueChanged && this.queue[this.index]?.id === selected.id;
      let time = 0;
      if (sameTrack) {
        if (this.pending) time = this.startPosition;
        else if (currentVideoId(this.player) === selected.youtubeId)
          time = this.player.getCurrentTime();
      }
      const start = Number.isFinite(time) ? Math.max(0, time) : 0;
      this.startPosition = start;
      this.queue = [...state.queue];
      this.index = state.currentIndex;
      this.playing = state.isPlaying;
      this.pending = true;
      this.endedIndex = null;
      this.expectedEnd = null;
      this.nativeTransitionAt = null;
      this.callbacks.resetProgress(start);
      if (queueChanged || !state.isPlaying || wasPending) {
        const ids = this.queue.map((video) => video.youtubeId);
        if (state.isPlaying) this.player.loadPlaylist(ids, this.index, start);
        else this.player.cuePlaylist(ids, this.index, start);
        this.player.setLoop(false);
        this.player.setShuffle(false);
      } else {
        this.player.playVideoAt(this.index);
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

    const nativeIndex = this.player.getPlaylistIndex();
    if (
      !this.pending &&
      nativeIndex !== this.index &&
      this.nativeTransitionAt === null
    ) {
      this.nativeTransitionAt = performance.now();
    }
    if (nativeIndex === this.index) this.nativeTransitionAt = null;
    if (
      (playerState === -1 || playerState === 3) &&
      nativeIndex === this.index
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
      ids.length !== this.queue.length ||
      ids.some((id, i) => id !== this.queue[i].youtubeId)
    )
      return;
    const index = this.player.getPlaylistIndex();
    const video = this.queue[index];
    if (!video || (this.pending && index !== this.index)) return;
    // Index and video URL are delivered separately by the iframe. Wait until
    // both describe the same track before accepting it as a native skip.
    if (currentVideoId(this.player) !== video.youtubeId) return;
    if (this.pending && playerState !== 1 && state.isPlaying) return;
    if (this.pending && playerState === 1 && !state.isPlaying) {
      this.player.pauseVideo();
      return;
    }

    const changed = index !== this.index;
    if (
      changed &&
      !this.pending &&
      index === this.index + 1 &&
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
    this.index = index;
    this.pending = false;
    this.playing = playerState === 1;
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
    if (state.currentIndex !== index || state.isPlaying !== this.playing) {
      this.callbacks.select(index, this.playing);
    }
  }

  dispose(): void {
    this.cancelAdvance();
  }

  private cancelAdvance(): void {
    if (this.advanceTimer !== null) clearTimeout(this.advanceTimer);
    this.advanceTimer = null;
  }
}
