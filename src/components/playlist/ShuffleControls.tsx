"use client";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Shuffle,
  SkipBack,
  SkipForward,
  Play,
  Pause,
  Volume2,
  Lock,
} from "lucide-react";
import { usePlayerStore } from "@/stores/player-store";
import type { ShufflePreset } from "@/types/playlist";

interface ShuffleControlsProps {
  isPremium: boolean;
  currentPreset: ShufflePreset;
  excludeWatched: boolean;
  onShuffle: (preset: ShufflePreset) => void;
  onExcludeWatchedChange: (value: boolean) => void;
  isShuffling: boolean;
}

export function ShuffleControls({
  isPremium,
  currentPreset,
  excludeWatched,
  onShuffle,
  onExcludeWatchedChange,
  isShuffling,
}: ShuffleControlsProps) {
  const { isPlaying, togglePlay, playNext, playPrevious, currentVideo } =
    usePlayerStore();

  return (
    <div className="space-y-4">
      {/* Playback Controls */}
      <div className="flex items-center justify-center gap-3">
        <Button
          variant="outline"
          size="icon"
          onClick={playPrevious}
          disabled={!currentVideo}
        >
          <SkipBack className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          className="h-12 w-12"
          onClick={togglePlay}
          disabled={!currentVideo}
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
          onClick={playNext}
          disabled={!currentVideo}
        >
          <SkipForward className="h-4 w-4" />
        </Button>
      </div>

      {/* Shuffle Controls */}
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium">Shuffle Mode</h3>
          <Select
            value={currentPreset}
            onValueChange={(value) => onShuffle(value as ShufflePreset)}
            disabled={isShuffling}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="RANDOM">Random</SelectItem>
              <SelectItem value="SMART" disabled={!isPremium}>
                <span className="flex items-center gap-1">
                  Smart {!isPremium && <Lock className="h-3 w-3" />}
                </span>
              </SelectItem>
              <SelectItem value="DISCOVERY" disabled={!isPremium}>
                <span className="flex items-center gap-1">
                  Discovery {!isPremium && <Lock className="h-3 w-3" />}
                </span>
              </SelectItem>
              <SelectItem value="ENERGY" disabled={!isPremium}>
                <span className="flex items-center gap-1">
                  Energy {!isPremium && <Lock className="h-3 w-3" />}
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button
          onClick={() => onShuffle(currentPreset)}
          disabled={isShuffling}
          className="w-full"
        >
          <Shuffle className="mr-2 h-4 w-4" />
          {isShuffling ? "Shuffling..." : "Re-shuffle"}
        </Button>

        {/* Exclude Watched (Premium) */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Label htmlFor="exclude-watched" className="text-sm">
              Exclude watched
            </Label>
            {!isPremium && (
              <Badge variant="outline" className="text-xs">
                Premium
              </Badge>
            )}
          </div>
          <Switch
            id="exclude-watched"
            checked={excludeWatched}
            onCheckedChange={onExcludeWatchedChange}
            disabled={!isPremium}
          />
        </div>
      </div>
    </div>
  );
}
