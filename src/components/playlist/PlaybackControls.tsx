"use client";

import { useState } from "react";
import { Pause, Play, SkipBack, SkipForward, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePlayerStore } from "@/stores/player-store";
import { usePlaybackStore } from "@/stores/playback-store";
import { cn, formatDuration } from "@/lib/utils";

export function PlaybackControls({ stage = false }: { stage?: boolean }) {
  const currentVideo = usePlayerStore((state) => state.currentVideo);
  const isPlaying = usePlayerStore((state) => state.isPlaying);
  const volume = usePlayerStore((state) => state.volume);
  const position = usePlaybackStore((state) => state.position);
  const duration = usePlaybackStore((state) => state.duration);
  const seekTo = usePlaybackStore((state) => state.seekTo);
  const previous = usePlaybackStore((state) => state.previous);
  const [scrub, setScrub] = useState<{
    trackId: string;
    position: number;
  } | null>(null);
  const total = duration || currentVideo?.duration || 0;
  const shownPosition =
    scrub && scrub.trackId === currentVideo?.id ? scrub.position : position;
  const value = Math.min(shownPosition, total);
  const elapsedLabel = formatDuration(Math.floor(value));
  const durationLabel = formatDuration(Math.floor(total));

  function commitSeek() {
    if (scrub && scrub.trackId === currentVideo?.id) seekTo?.(scrub.position);
    setScrub(null);
  }

  return (
    <div className={cn("space-y-2", stage && "mx-auto w-full max-w-2xl")}>
      <div className="flex items-center gap-3">
        <span className="w-12 text-right text-xs tabular-nums text-white/60">
          {elapsedLabel}
        </span>
        <input
          type="range"
          min={0}
          max={total || 1}
          step={1}
          value={value}
          disabled={!currentVideo || !seekTo || duration <= 0}
          aria-label="Playback position"
          aria-valuetext={`${elapsedLabel} of ${durationLabel}`}
          onChange={(event) => {
            if (currentVideo)
              setScrub({
                trackId: currentVideo.id,
                position: Number(event.target.value),
              });
          }}
          onPointerUp={commitSeek}
          onPointerCancel={() => setScrub(null)}
          onKeyUp={commitSeek}
          onBlur={commitSeek}
          className="h-10 min-w-0 flex-1 cursor-pointer accent-white disabled:cursor-default disabled:opacity-40"
        />
        <span className="w-12 text-xs tabular-nums text-white/60">
          {durationLabel}
        </span>
      </div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <div />
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            className="size-11 rounded-full text-white/75 hover:bg-white/10 hover:text-white"
            onClick={() => previous?.()}
            disabled={!currentVideo || !previous}
            aria-label="Previous track"
          >
            <SkipBack className="size-5" />
          </Button>
          <Button
            className="size-14 rounded-full bg-white text-black transition-transform hover:bg-white/90 active:scale-[0.96] motion-reduce:transition-none"
            size="icon"
            onClick={() => usePlayerStore.getState().togglePlay()}
            disabled={!currentVideo}
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? (
              <Pause className="size-6" fill="currentColor" />
            ) : (
              <Play className="ml-0.5 size-6" fill="currentColor" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-11 rounded-full text-white/75 hover:bg-white/10 hover:text-white"
            onClick={() => usePlayerStore.getState().playNext()}
            disabled={!currentVideo}
            aria-label="Next track"
          >
            <SkipForward className="size-5" />
          </Button>
        </div>
        <label className="ml-auto hidden max-w-28 items-center gap-2 sm:flex">
          <Volume2
            className="size-4 shrink-0 text-white/50"
            aria-hidden="true"
          />
          <input
            type="range"
            min={0}
            max={100}
            value={volume}
            onChange={(event) =>
              usePlayerStore.getState().setVolume(Number(event.target.value))
            }
            aria-label="Volume"
            className="h-10 w-full min-w-0 cursor-pointer accent-white"
          />
        </label>
      </div>
    </div>
  );
}
