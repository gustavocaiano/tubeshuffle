"use client";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Shuffle } from "lucide-react";
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
}> = [
  {
    value: "RANDOM",
    label: "Normal",
  },
  {
    value: "SMART",
    label: "Smart",
  },
];

export function ShuffleControls({
  currentPreset,
  excludeWatched,
  onShuffle,
  onExcludeWatchedChange,
  isShuffling,
}: ShuffleControlsProps) {
  return (
    <div className="space-y-4 rounded-3xl border border-white/10 bg-white/[0.045] p-4 text-white shadow-2xl shadow-black/25 backdrop-blur-xl">
      <div className="flex flex-col gap-4">
        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">Shape your queue</h3>
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
                    "min-h-11 rounded-xl px-3 py-2 text-left transition-colors disabled:pointer-events-none disabled:opacity-60",
                    active
                      ? "bg-white text-black shadow-sm"
                      : "text-white/50 hover:bg-white/5 hover:text-white",
                  )}
                  aria-pressed={active}
                >
                  <span className="block text-sm font-semibold">
                    {mode.label}
                  </span>
                  <span
                    className={cn(
                      "mt-1 block text-xs",
                      active ? "text-black/60" : "text-white/45",
                    )}
                  >
                    {mode.value === "RANDOM"
                      ? "Every track, a surprise"
                      : "A smoother energy flow"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <Button
          onClick={() => onShuffle(currentPreset)}
          disabled={isShuffling}
          className="min-h-11 w-full rounded-full bg-white text-black hover:bg-white/90"
        >
          <Shuffle className="mr-2 h-4 w-4" />
          {isShuffling ? "Shuffling..." : "Reshuffle queue"}
        </Button>

        <div className="flex items-center justify-between gap-4 border-t border-white/10 pt-4">
          <div>
            <Label htmlFor="exclude-watched" className="text-sm">
              Skip watched
            </Label>
            <p className="mt-1 text-xs text-white/45">
              Leave completed tracks out of your next shuffle.
            </p>
          </div>
          <Switch
            id="exclude-watched"
            checked={excludeWatched}
            onCheckedChange={onExcludeWatchedChange}
          />
        </div>

        <div className="flex justify-center rounded-xl bg-white/[0.04] p-3 ring-1 ring-white/10">
          <KeyboardShortcutsDialog />
        </div>
      </div>
    </div>
  );
}
