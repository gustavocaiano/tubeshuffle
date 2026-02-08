"use client";

import { useEffect, useRef, useCallback } from "react";
import { usePlayerStore } from "@/stores/player-store";

// YouTube IFrame API types
declare global {
  interface Window {
    YT: {
      Player: new (
        elementId: string,
        config: {
          height: string;
          width: string;
          videoId: string;
          playerVars: Record<string, number | string>;
          events: Record<string, (event: YouTubeEvent) => void>;
        }
      ) => YouTubePlayer;
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
      };
    };
    onYouTubeIframeAPIReady: () => void;
  }
}

interface YouTubePlayer {
  playVideo: () => void;
  pauseVideo: () => void;
  loadVideoById: (videoId: string) => void;
  setVolume: (volume: number) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  seekTo?: (seconds: number, allowSeekAhead: boolean) => void;
  destroy: () => void;
}

interface YouTubeEvent {
  data?: number;
  target: YouTubePlayer;
}

interface VideoPlayerProps {
  onVideoEnd?: () => void;
  onPlayStateChange?: (playing: boolean) => void;
}

export function VideoPlayer({ onVideoEnd, onPlayStateChange }: VideoPlayerProps) {
  const playerRef = useRef<YouTubePlayer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const {
    currentVideo,
    isPlaying,
    volume,
    playNext,
    playPrevious,
    setPlaying,
  } = usePlayerStore();
  const currentVideoIdRef = useRef<string | null>(null);
  const onVideoEndRef = useRef(onVideoEnd);
  const onPlayStateChangeRef = useRef(onPlayStateChange);
  const playNextRef = useRef(playNext);
  const volumeRef = useRef(volume);

  useEffect(() => {
    onVideoEndRef.current = onVideoEnd;
  }, [onVideoEnd]);

  useEffect(() => {
    onPlayStateChangeRef.current = onPlayStateChange;
  }, [onPlayStateChange]);

  useEffect(() => {
    playNextRef.current = playNext;
  }, [playNext]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  const onPlayerStateChange = useCallback((event: YouTubeEvent) => {
    if (event.data === window.YT?.PlayerState?.ENDED) {
      onVideoEndRef.current?.();
      playNextRef.current();
    } else if (event.data === window.YT?.PlayerState?.PLAYING) {
      onPlayStateChangeRef.current?.(true);
    } else if (event.data === window.YT?.PlayerState?.PAUSED) {
      onPlayStateChangeRef.current?.(false);
    }
  }, []);

  const handlePreviousAction = useCallback(() => {
    const player = playerRef.current;
    if (player?.seekTo) {
      const currentTime = player.getCurrentTime();
      if (Number.isFinite(currentTime) && currentTime > 5) {
        player.seekTo(0, true);
        return;
      }
    }
    playPrevious();
  }, [playPrevious]);

  const handleNextAction = useCallback(() => {
    playNext();
  }, [playNext]);

  // Load YouTube IFrame API
  useEffect(() => {
    if (typeof window !== "undefined" && !window.YT) {
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(tag);
    }
  }, []);

  // Initialize or update player
  useEffect(() => {
    if (!currentVideo) return;

    const initPlayer = () => {
      if (playerRef.current) {
        if (currentVideoIdRef.current !== currentVideo.youtubeId) {
          playerRef.current.loadVideoById(currentVideo.youtubeId);
          currentVideoIdRef.current = currentVideo.youtubeId;
        }
        return;
      }

      playerRef.current = new window.YT.Player("youtube-player", {
        height: "100%",
        width: "100%",
        videoId: currentVideo.youtubeId,
        playerVars: {
          autoplay: 1,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
        },
        events: {
          onReady: (event: YouTubeEvent) => {
            event.target.setVolume(volumeRef.current);
          },
          onStateChange: onPlayerStateChange,
        },
      });
      currentVideoIdRef.current = currentVideo.youtubeId;
    };

    if (window.YT?.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = initPlayer;
    }
  }, [currentVideo?.youtubeId, onPlayerStateChange]);

  // Sync play/pause state
  useEffect(() => {
    if (!playerRef.current) return;
    if (isPlaying) {
      playerRef.current.playVideo();
    } else {
      playerRef.current.pauseVideo();
    }
  }, [isPlaying]);

  // Sync volume
  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.setVolume(volume);
    }
  }, [volume]);

  // Media Session actions (system media keys)
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    const mediaSession = navigator.mediaSession;
    const setHandler = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
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
    setHandler("seekbackward", handlePreviousAction);
    setHandler("seekforward", handleNextAction);

    return () => {
      setHandler("play", null);
      setHandler("pause", null);
      setHandler("previoustrack", null);
      setHandler("nexttrack", null);
      setHandler("seekbackward", null);
      setHandler("seekforward", null);
    };
  }, [setPlaying, handlePreviousAction, handleNextAction]);

  // Media Session metadata
  useEffect(() => {
    if (!currentVideo || typeof navigator === "undefined" || !navigator.mediaSession) {
      return;
    }

    navigator.mediaSession.metadata = new MediaMetadata({
      title: currentVideo.title,
      artist: currentVideo.channelTitle,
      artwork: currentVideo.thumbnail ? [{ src: currentVideo.thumbnail }] : [],
    });
  }, [currentVideo]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.mediaSession) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  // Keyboard shortcuts for media control
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Ignore if user is typing in an input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        return;
      }

      switch (e.key.toLowerCase()) {
        case 'k': // Play/pause
        case ' ': // Spacebar also toggles play/pause
          e.preventDefault();
          setPlaying(!isPlaying);
          break;
        case 'j': // Previous (or restart if >5s)
          e.preventDefault();
          handlePreviousAction();
          break;
        case 'l': // Next
          e.preventDefault();
          handleNextAction();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => window.removeEventListener('keydown', handleKeyPress);
  }, [isPlaying, setPlaying, handlePreviousAction, handleNextAction]);

  if (!currentVideo) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-xl bg-muted">
        <p className="text-muted-foreground">
          Select a video or shuffle to start playing
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="aspect-video w-full overflow-hidden rounded-xl bg-black">
      <div id="youtube-player" className="h-full w-full" />
    </div>
  );
}
