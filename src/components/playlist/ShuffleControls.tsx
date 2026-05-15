"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Headphones,
  ImageOff,
  Pause,
  Play,
  Shuffle,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { usePlayerStore } from "@/stores/player-store";
import { useUiPreferencesStore } from "@/stores/ui-preferences-store";
import { cn } from "@/lib/utils";
import type { ShufflePreset } from "@/types/playlist";
import { KeyboardShortcutsDialog } from "@/components/playlist/KeyboardShortcutsDialog";

interface ShuffleControlsProps {
  currentPreset: ShufflePreset;
  excludeWatched: boolean;
  onShuffle: (preset: ShufflePreset) => void;
  onExcludeWatchedChange: (value: boolean) => void;
  isShuffling: boolean;
}

const modes: Array<{
  value: ShufflePreset;
  label: string;
  description: string;
}> = [
  {
    value: "RANDOM",
    label: "Normal",
    description: "Pure random order",
  },
  {
    value: "SMART",
    label: "Smart",
    description: "Spaces out repeat artists",
  },
];

export function ShuffleControls({
  currentPreset,
  excludeWatched,
  onShuffle,
  onExcludeWatchedChange,
  isShuffling,
}: ShuffleControlsProps) {
  const { isPlaying, togglePlay, playNext, playPrevious, currentVideo } =
    usePlayerStore();
  const {
    hideThumbnails,
    focusMode,
    setHideThumbnails,
    setFocusMode,
  } = useUiPreferencesStore();

  return (
    <div className="space-y-4 rounded-3xl border border-white/10 bg-white/[0.045] p-4 text-white shadow-2xl shadow-black/25 backdrop-blur-xl">
      <div className="flex items-center justify-center gap-3">
        <Button
          variant="outline"
          size="icon"
          className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
          onClick={playPrevious}
          disabled={!currentVideo}
          aria-label="Previous track"
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          className="h-12 w-12 bg-white text-black shadow-[0_0_24px_rgba(255,255,255,0.18)] hover:bg-white/90"
          onClick={togglePlay}
          disabled={!currentVideo}
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <Pause className="h-5 w-5" />
          ) : (
            <Play className="h-5 w-5" />
          )}
        </Button>
        <Button
          variant="outline"
          size="icon"
          className="border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
          onClick={playNext}
          disabled={!currentVideo}
          aria-label="Next track"
        >
          <SkipForward className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-4">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Shuffle mode</h3>
            <span className="text-xs text-white/45">2 honest choices</span>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-2xl bg-black/30 p-1 ring-1 ring-white/10">
            {modes.map((mode) => {
              const active = currentPreset === mode.value;
              return (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => onShuffle(mode.value)}
                  disabled={isShuffling}
                  className={cn(
                    "rounded-xl px-3 py-2 text-left transition-all disabled:pointer-events-none disabled:opacity-60",
                    active
                      ? "bg-white text-black shadow-sm"
                      : "text-white/50 hover:bg-white/5 hover:text-white"
                  )}
                  aria-pressed={active}
                >
                  <span className="block text-sm font-semibold">{mode.label}</span>
                  <span className="block text-xs">{mode.description}</span>
                </button>
              );
            })}
          </div>
        </div>

        <Button
          onClick={() => onShuffle(currentPreset)}
          disabled={isShuffling}
          className="w-full rounded-full bg-white text-black hover:bg-white/90"
        >
          <Shuffle className="mr-2 h-4 w-4" />
          {isShuffling ? "Shuffling..." : "Re-shuffle"}
        </Button>

        <div className="grid gap-3 border-t border-white/10 pt-3 sm:grid-cols-3">
          <div className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.055] px-3 py-2 ring-1 ring-white/10">
            <Label htmlFor="exclude-watched" className="text-sm">
              Exclude watched
            </Label>
            <Switch
              id="exclude-watched"
              checked={excludeWatched}
              onCheckedChange={onExcludeWatchedChange}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.055] px-3 py-2 ring-1 ring-white/10">
            <Label
              htmlFor="focus-mode"
              className="inline-flex items-center gap-2 text-sm"
            >
              <Headphones className="h-4 w-4" />
              Focus
            </Label>
            <Switch
              id="focus-mode"
              checked={focusMode}
              onCheckedChange={setFocusMode}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.055] px-3 py-2 ring-1 ring-white/10">
            <Label
              htmlFor="hide-thumbnails"
              className="inline-flex items-center gap-2 text-sm"
            >
              <ImageOff className="h-4 w-4" />
              No art
            </Label>
            <Switch
              id="hide-thumbnails"
              checked={hideThumbnails}
              onCheckedChange={setHideThumbnails}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 rounded-xl bg-white/[0.04] p-3 text-xs text-white/45 ring-1 ring-white/10 sm:flex-row sm:items-center sm:justify-between">
          <span>
            Focus covers the rendered video with a calm audio screen while
            keeping the YouTube player active underneath.
          </span>
          <KeyboardShortcutsDialog />
        </div>
      </div>
    </div>
  );
}
