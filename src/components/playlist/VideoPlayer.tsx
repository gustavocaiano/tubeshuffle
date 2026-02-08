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
  destroy: () => void;
}

interface YouTubeEvent {
  data: number;
  target: YouTubePlayer;
}

interface VideoPlayerProps {
  onVideoEnd?: () => void;
  onPlayStateChange?: (playing: boolean) => void;
}

export function VideoPlayer({ onVideoEnd, onPlayStateChange }: VideoPlayerProps) {
  const playerRef = useRef<YouTubePlayer | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const { currentVideo, isPlaying, volume, playNext } = usePlayerStore();

  const onPlayerStateChange = useCallback(
    (event: YouTubeEvent) => {
      if (event.data === window.YT?.PlayerState?.ENDED) {
        onVideoEnd?.();
        playNext();
      } else if (event.data === window.YT?.PlayerState?.PLAYING) {
        onPlayStateChange?.(true);
      } else if (event.data === window.YT?.PlayerState?.PAUSED) {
        onPlayStateChange?.(false);
      }
    },
    [onVideoEnd, onPlayStateChange, playNext]
  );

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
        playerRef.current.loadVideoById(currentVideo.youtubeId);
        playerRef.current.setVolume(volume);
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
          onStateChange: onPlayerStateChange,
        },
      });
    };

    if (window.YT?.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = initPlayer;
    }
  }, [currentVideo, onPlayerStateChange, volume]);

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
