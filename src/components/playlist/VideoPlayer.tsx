"use client";

import { useEffect, useRef, useCallback, type ReactNode } from "react";
import { usePlayerStore, type VideoItem } from "@/stores/player-store";
import { cn } from "@/lib/utils";
import { usePlaybackStore } from "@/stores/playback-store";
import { useUiPreferencesStore } from "@/stores/ui-preferences-store";
import { createSilentAudioUrl } from "@/lib/media/silent-audio";
import {
  YouTubeQueueController,
  type YouTubeQueuePlayer,
} from "@/lib/media/youtube-queue";

// YouTube IFrame API types
declare global {
  interface Window {
    YT: {
      Player: new (
        element: string | HTMLElement,
        config: {
          height: string;
          width: string;
          videoId: string;
          playerVars: Record<string, number | string>;
          events: Record<string, (event: YouTubeEvent) => void>;
        },
      ) => YouTubePlayer;
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
      };
    };
    onYouTubeIframeAPIReady: () => void;
  }
}

interface YouTubePlayer extends YouTubeQueuePlayer {
  setVolume: (volume: number) => void;
  getDuration: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  destroy: () => void;
}

interface YouTubeEvent {
  data?: number;
  target: YouTubePlayer;
}

function updateMediaPosition(state?: MediaPositionState) {
  try {
    navigator.mediaSession?.setPositionState?.(state);
  } catch {
    // Position state is optional, even in browsers supporting media actions.
  }
}

interface VideoPlayerProps {
  onVideoEnd?: (video: VideoItem) => void;
  onPlayStateChange?: (playing: boolean) => void;
  compact?: boolean;
  className?: string;
  overlay?: ReactNode;
}

export function VideoPlayer({
  onVideoEnd,
  onPlayStateChange,
  compact = false,
  className,
  overlay,
}: VideoPlayerProps) {
  const hideThumbnails = useUiPreferencesStore((state) => state.hideThumbnails);
  const playerRef = useRef<YouTubePlayer | null>(null);
  const playerHostRef = useRef<HTMLDivElement>(null);
  const {
    currentVideo,
    isPlaying,
    volume,
    playNext,
    playPrevious,
    setPlaying,
  } = usePlayerStore();
  const queueControllerRef = useRef<YouTubeQueueController | null>(null);
  const onVideoEndRef = useRef(onVideoEnd);
  const onPlayStateChangeRef = useRef(onPlayStateChange);
  const readyRef = useRef(false);
  const mediaAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    onVideoEndRef.current = onVideoEnd;
  }, [onVideoEnd]);

  useEffect(() => {
    onPlayStateChangeRef.current = onPlayStateChange;
  }, [onPlayStateChange]);

  useEffect(
    () => usePlayerStore.subscribe(() => queueControllerRef.current?.sync()),
    [],
  );

  const onPlayerStateChange = useCallback((event: YouTubeEvent) => {
    if (event.target !== playerRef.current || event.data === undefined) return;
    queueControllerRef.current?.observe(event.data);
  }, []);

  const handlePreviousAction = useCallback(() => {
    const player = playerRef.current;
    if (
      readyRef.current &&
      player &&
      !queueControllerRef.current?.isTransitioning
    ) {
      const currentTime = player.getCurrentTime();
      if (Number.isFinite(currentTime) && currentTime > 5) {
        player.seekTo(0, true);
        usePlaybackStore.setState({ position: 0 });
        return;
      }
    }
    if (
      usePlayerStore.getState().currentIndex <= 0 &&
      readyRef.current &&
      player
    ) {
      player.seekTo(0, true);
      usePlaybackStore.setState({ position: 0 });
    }
    playPrevious();
  }, [playPrevious]);

  const handleNextAction = useCallback(() => {
    playNext();
  }, [playNext]);

  const seekTo = useCallback((seconds: number) => {
    const player = playerRef.current;
    if (
      !readyRef.current ||
      !player ||
      queueControllerRef.current?.isTransitioning ||
      !Number.isFinite(seconds)
    )
      return;
    const duration = player.getDuration();
    if (!Number.isFinite(duration) || duration <= 0) return;
    const position = Math.max(0, Math.min(seconds, duration));
    player.seekTo(position, true);
    usePlaybackStore.setState({ position });
  }, []);

  // Some browsers route the session to YouTube's frame. A user-activated,
  // silent top-level element can make the page's own handlers routable.
  useEffect(() => {
    let disposed = false;
    async function connectMediaKeys() {
      if (!navigator.mediaSession) {
        usePlaybackStore.setState({ mediaKeysStatus: "unavailable" });
        return;
      }
      usePlaybackStore.setState({ mediaKeysStatus: "connecting" });
      if (!mediaAudioRef.current) {
        const audio = new Audio(createSilentAudioUrl());
        audio.loop = true;
        mediaAudioRef.current = audio;
      }
      try {
        await mediaAudioRef.current.play();
        if (disposed) return;
        usePlaybackStore.setState({ mediaKeysStatus: "connected" });
        if (!usePlayerStore.getState().isPlaying)
          mediaAudioRef.current?.pause();
      } catch {
        if (!disposed)
          usePlaybackStore.setState({ mediaKeysStatus: "unavailable" });
      }
    }
    function disconnectMediaKeys() {
      const audio = mediaAudioRef.current;
      if (audio) {
        audio.pause();
        URL.revokeObjectURL(audio.src);
        audio.removeAttribute("src");
        audio.load();
        mediaAudioRef.current = null;
      }
      usePlaybackStore.setState({ mediaKeysStatus: "idle" });
    }
    usePlaybackStore.setState({
      seekTo,
      previous: handlePreviousAction,
      connectMediaKeys,
      disconnectMediaKeys,
    });
    return () => {
      disposed = true;
      disconnectMediaKeys();
      usePlaybackStore.setState({
        position: 0,
        duration: 0,
        seekTo: null,
        previous: null,
        connectMediaKeys: null,
        disconnectMediaKeys: null,
        mediaKeysStatus: "idle",
      });
    };
  }, [seekTo, handlePreviousAction]);

  useEffect(() => {
    const audio = mediaAudioRef.current;
    if (!audio || usePlaybackStore.getState().mediaKeysStatus !== "connected")
      return;
    if (isPlaying) {
      audio.play().catch(() => {
        if (mediaAudioRef.current === audio) {
          usePlaybackStore.setState({ mediaKeysStatus: "unavailable" });
        }
      });
    } else {
      audio.pause();
    }
  }, [isPlaying]);

  // Keep all player views and the OS timeline on the same clock.
  useEffect(() => {
    const timer = window.setInterval(() => {
      const player = playerRef.current;
      if (
        !readyRef.current ||
        !player ||
        !usePlayerStore.getState().currentVideo
      )
        return;
      queueControllerRef.current?.observe(player.getPlayerState());
      if (queueControllerRef.current?.isTransitioning) return;
      const duration = player.getDuration();
      const currentTime = player.getCurrentTime();
      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        !Number.isFinite(currentTime)
      )
        return;
      const position = Math.max(0, Math.min(currentTime, duration));
      usePlaybackStore.setState({ position, duration });
      updateMediaPosition({ duration, position, playbackRate: 1 });
    }, 500);
    return () => window.clearInterval(timer);
  }, []);

  // Load YouTube IFrame API
  useEffect(() => {
    if (
      !window.YT?.Player &&
      !document.querySelector(
        'script[src="https://www.youtube.com/iframe_api"]',
      )
    ) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
    }
  }, []);

  // Initialize or update player
  useEffect(() => {
    if (!currentVideo) return;

    const initPlayer = () => {
      if (playerRef.current) return;

      const host = playerHostRef.current;
      if (!host) return;
      // YouTube replaces its mount node. Keep React's host intact so remounts
      // (including Strict Mode) always have a fresh target.
      const mount = document.createElement("div");
      host.replaceChildren(mount);
      playerRef.current = new window.YT.Player(mount, {
        height: "100%",
        width: "100%",
        videoId: currentVideo.youtubeId,
        playerVars: {
          autoplay: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event: YouTubeEvent) => {
            if (event.target !== playerRef.current) return;
            readyRef.current = true;
            event.target.setVolume(usePlayerStore.getState().volume);
            queueControllerRef.current = new YouTubeQueueController(
              event.target,
              {
                read: usePlayerStore.getState,
                select: (index, playing) => {
                  const state = usePlayerStore.getState();
                  const video = state.queue[index];
                  if (!video) return;
                  usePlayerStore.setState({
                    currentIndex: index,
                    currentVideo: video,
                    isPlaying: playing,
                  });
                  if (state.isPlaying !== playing)
                    onPlayStateChangeRef.current?.(playing);
                },
                ended: (video) => onVideoEndRef.current?.(video),
                resetProgress: (position) => {
                  usePlaybackStore.setState({ position, duration: 0 });
                  updateMediaPosition();
                },
              },
            );
            queueControllerRef.current.sync();
          },
          onStateChange: onPlayerStateChange,
          onAutoplayBlocked: () => setPlaying(false),
        },
      });
    };

    if (window.YT?.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = initPlayer;
    }
  }, [currentVideo, onPlayerStateChange, setPlaying]);

  useEffect(() => {
    return () => {
      queueControllerRef.current?.dispose();
      queueControllerRef.current = null;
      playerRef.current?.destroy();
      playerRef.current = null;
      readyRef.current = false;
      window.onYouTubeIframeAPIReady = () => {};
    };
  }, []);

  // Sync volume
  useEffect(() => {
    if (readyRef.current && playerRef.current) {
      playerRef.current.setVolume(volume);
    }
  }, [volume]);

  // Media Session actions (system media keys)
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    const mediaSession = navigator.mediaSession;
    const setHandler = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler | null,
    ) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        // Some browsers don't support all actions.
      }
    };

    setHandler("play", () => setPlaying(true));
    setHandler("pause", () => setPlaying(false));
    setHandler("previoustrack", handlePreviousAction);
    setHandler("nexttrack", handleNextAction);
    // Keep compact system surfaces focused on changing songs. The seek bar
    // still supports absolute seeking through seekto.
    setHandler("seekbackward", null);
    setHandler("seekforward", null);
    setHandler("seekto", (details) => {
      if (details.seekTime !== undefined) seekTo(details.seekTime);
    });

    return () => {
      setHandler("play", null);
      setHandler("pause", null);
      setHandler("previoustrack", null);
      setHandler("nexttrack", null);
      setHandler("seekbackward", null);
      setHandler("seekforward", null);
      setHandler("seekto", null);
      mediaSession.metadata = null;
      mediaSession.playbackState = "none";
      updateMediaPosition();
    };
  }, [setPlaying, handlePreviousAction, handleNextAction, seekTo]);

  // Media Session metadata
  useEffect(() => {
    if (!navigator.mediaSession || typeof MediaMetadata === "undefined") {
      return;
    }

    navigator.mediaSession.metadata = currentVideo
      ? new MediaMetadata({
          title: currentVideo.title,
          artist: currentVideo.channelTitle,
          artwork:
            currentVideo.thumbnail && !hideThumbnails
              ? [{ src: currentVideo.thumbnail }]
              : [],
        })
      : null;
  }, [currentVideo, hideThumbnails]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    let playbackState: MediaSessionPlaybackState = "none";
    if (currentVideo) playbackState = isPlaying ? "playing" : "paused";
    navigator.mediaSession.playbackState = playbackState;
  }, [currentVideo, isPlaying]);

  // Keyboard shortcuts for media control
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (
        e.defaultPrevented ||
        e.altKey ||
        e.ctrlKey ||
        e.metaKey ||
        target.closest(
          'input, textarea, select, [contenteditable="true"], [role="dialog"]:not([data-stage-player]), [role="slider"]',
        )
      ) {
        return;
      }

      if (
        e.key === " " &&
        target.closest('button, a, [role="button"], [role="switch"]')
      )
        return;
      switch (e.key.toLowerCase()) {
        case "k": // Play/pause
        case " ": // Spacebar also toggles play/pause
          e.preventDefault();
          setPlaying(!isPlaying);
          break;
        case "j": // Previous (or restart if >5s)
          e.preventDefault();
          handlePreviousAction();
          break;
        case "l": // Next
          e.preventDefault();
          handleNextAction();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyPress);
    return () => window.removeEventListener("keydown", handleKeyPress);
  }, [isPlaying, setPlaying, handlePreviousAction, handleNextAction]);

  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-2xl shadow-black/20",
        compact && "min-h-[200px]",
        className,
      )}
    >
      <div
        className="absolute inset-0 z-0"
        inert={Boolean(overlay) || !currentVideo}
      >
        <div ref={playerHostRef} className="h-full w-full" />
      </div>
      {!currentVideo && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#10100f] p-6 text-center text-white/55">
          Select a video or shuffle to start playing
        </div>
      )}
      {overlay ? <div className="absolute inset-0 z-10">{overlay}</div> : null}
    </div>
  );
}
