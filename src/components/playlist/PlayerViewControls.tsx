"use client";

import { Headphones, Maximize2, Video } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useUiPreferencesStore } from "@/stores/ui-preferences-store";
import { cn } from "@/lib/utils";

export function PlayerViewControls() {
  const {
    focusMode,
    hideThumbnails,
    setFocusMode,
    setHideThumbnails,
    setFullWindowMode,
  } = useUiPreferencesStore();
  let viewDescription =
    "Watch the video, or choose Focus for a quieter listening view.";
  if (focusMode)
    viewDescription =
      "Just the music and your queue. Switch to Video to watch.";
  if (hideThumbnails)
    viewDescription =
      "Artwork is off. Enjoy a clean player with your queue close by.";

  return (
    <div className="@container/views mb-5 min-w-0 space-y-3">
      <div className="flex flex-col gap-3 @min-[30rem]/views:flex-row @min-[30rem]/views:items-center @min-[30rem]/views:justify-between">
        <div
          className="inline-flex rounded-xl bg-black/30 p-1 ring-1 ring-white/10 @min-[30rem]/views:shrink-0"
          role="group"
          aria-label="Player view"
        >
          {[
            {
              label: "Video",
              icon: Video,
              active: !focusMode && !hideThumbnails,
            },
            {
              label: "Focus",
              icon: Headphones,
              active: focusMode || hideThumbnails,
            },
          ].map(({ label, icon: Icon, active }) => (
            <button
              key={label}
              type="button"
              aria-pressed={active}
              onClick={() => {
                setFocusMode(label === "Focus");
                if (label === "Video") setHideThumbnails(false);
              }}
              className={cn(
                "inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white @min-[30rem]/views:flex-none",
                active
                  ? "bg-white text-black shadow-sm"
                  : "text-white/60 hover:text-white",
              )}
            >
              <Icon className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-h-11 items-center gap-2">
            <Label htmlFor="show-artwork" className="text-sm text-white/65">
              Artwork
            </Label>
            <Switch
              id="show-artwork"
              checked={!hideThumbnails}
              onCheckedChange={(value) => {
                setHideThumbnails(!value);
                if (!value) setFocusMode(true);
              }}
            />
          </div>
          <Button
            id="enter-stage"
            variant="outline"
            className="min-h-11 rounded-xl border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
            onClick={() => setFullWindowMode(true)}
          >
            <Maximize2 className="size-4" />
            Stage
          </Button>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-white/50">{viewDescription}</p>
    </div>
  );
}
