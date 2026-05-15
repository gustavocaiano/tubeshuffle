"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatDuration } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player-store";
import { useUiPreferencesStore } from "@/stores/ui-preferences-store";
import {
  ArrowDown,
  ArrowUp,
  ListPlus,
  MoreHorizontal,
  Music,
  Play,
  Trash2,
} from "lucide-react";

interface PlaylistQueueProps {
  compact?: boolean;
  fill?: boolean;
}

export function PlaylistQueue({ compact = false, fill = false }: PlaylistQueueProps) {
  const {
    queue,
    currentIndex,
    playVideo,
    isPlaying,
    removeFromQueue,
    moveQueueItem,
    playNextFromQueue,
  } = usePlayerStore();
  const hideThumbnails = useUiPreferencesStore((state) => state.hideThumbnails);
  const activeItemRef = useRef<HTMLDivElement | null>(null);
  const lastManualScrollRef = useRef(0);

  useEffect(() => {
    if (Date.now() - lastManualScrollRef.current < 1500) return;
    activeItemRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [currentIndex]);

  if (queue.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center py-12 text-center",
          fill && "min-h-0 flex-1"
        )}
      >
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10">
          <Music className="h-6 w-6 text-white/45" />
        </div>
        <p className="text-sm font-medium">No videos in queue</p>
        <p className="text-xs text-white/45">
          Shuffle a playlist to start playing
        </p>
      </div>
    );
  }

  const scrollAreaClassName = fill
    ? "min-h-0 flex-1"
    : compact
      ? "h-[28rem]"
      : "h-[calc(100vh-16rem)] min-h-[360px]";

  return (
    <ScrollArea
      className={scrollAreaClassName}
      onWheelCapture={() => {
        lastManualScrollRef.current = Date.now();
      }}
      onTouchStartCapture={() => {
        lastManualScrollRef.current = Date.now();
      }}
    >
      <div className="space-y-1.5 pr-4">
        {queue.map((video, index) => {
          const active = index === currentIndex;
          return (
            <div
              key={`${video.id}-${index}`}
              ref={active ? activeItemRef : undefined}
              className={cn(
                "group relative flex items-center gap-2 rounded-2xl border border-transparent p-1.5 text-white transition-all",
                active
                  ? "border-white/20 bg-white/10 shadow-sm"
                  : "hover:border-white/10 hover:bg-white/[0.055]",
                !active && "opacity-80 hover:opacity-100"
              )}
            >
              {active && (
                <div className="absolute inset-y-3 left-0 w-1 rounded-full bg-white" />
              )}

              <button
                type="button"
                onClick={() => playVideo(index)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1.5 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-white/20 focus-visible:ring-offset-0"
              >
                <div className="relative h-14 w-20 shrink-0 overflow-hidden rounded-xl bg-white/10">
                  {video.thumbnail && !hideThumbnails ? (
                    <Image
                      src={video.thumbnail}
                      alt={video.title}
                      fill
                      className="object-cover"
                      sizes="80px"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center bg-gradient-to-br from-white/15 via-white/5 to-amber-500/10">
                      <Music className="h-5 w-5 text-white/45" />
                    </div>
                  )}
                  {active && isPlaying && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/45">
                      <div className="flex h-6 items-end gap-0.5" aria-hidden="true">
                        <span className="h-3 w-1 animate-pulse rounded-full bg-white" />
                        <span className="h-5 w-1 animate-pulse rounded-full bg-white [animation-delay:120ms]" />
                        <span className="h-4 w-1 animate-pulse rounded-full bg-white [animation-delay:240ms]" />
                      </div>
                      <Play className="sr-only" />
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p
                    className={cn(
                      "line-clamp-2 text-sm leading-snug",
                      active ? "font-semibold text-white" : "text-white/80"
                    )}
                  >
                    {video.title}
                  </p>
                  <div className="mt-1 flex items-center gap-2 text-xs text-white/45">
                    <span className="truncate">{video.channelTitle}</span>
                    {video.duration > 0 && (
                      <>
                        <span>·</span>
                        <span>{formatDuration(video.duration)}</span>
                      </>
                    )}
                  </div>
                </div>

                <span className="hidden shrink-0 rounded-full bg-white/10 px-2 py-1 text-xs text-white/45 sm:block">
                  {index + 1}
                </span>
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-white/55 opacity-70 transition-opacity hover:bg-white/10 hover:text-white group-hover:opacity-100"
                    aria-label={`Queue actions for ${video.title}`}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    disabled={active}
                    onClick={() => playNextFromQueue(index)}
                  >
                    <ListPlus className="mr-2 h-4 w-4" />
                    Play next
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={index === 0}
                    onClick={() => moveQueueItem(index, index - 1)}
                  >
                    <ArrowUp className="mr-2 h-4 w-4" />
                    Move up
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    disabled={index === queue.length - 1}
                    onClick={() => moveQueueItem(index, index + 1)}
                  >
                    <ArrowDown className="mr-2 h-4 w-4" />
                    Move down
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-red-300 focus:text-red-200"
                    onClick={() => removeFromQueue(index)}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
