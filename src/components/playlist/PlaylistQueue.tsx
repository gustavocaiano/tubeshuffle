"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, formatDuration } from "@/lib/utils";
import { usePlayerStore } from "@/stores/player-store";
import { Play, Music } from "lucide-react";
import Image from "next/image";

export function PlaylistQueue() {
  const { queue, currentIndex, playVideo, isPlaying } = usePlayerStore();

  if (queue.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Music className="mb-3 h-10 w-10 text-muted-foreground" />
        <p className="text-sm font-medium">No videos in queue</p>
        <p className="text-xs text-muted-foreground">
          Shuffle a playlist to start playing
        </p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-screen">
      <div className="space-y-1 pr-4">
        {queue.map((video, index) => (
          <button
            key={`${video.id}-${index}`}
            onClick={() => playVideo(index)}
            className={cn(
              "flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-accent",
              index === currentIndex && "bg-accent"
            )}
          >
            <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded bg-muted">
              {video.thumbnail ? (
                <Image
                  src={video.thumbnail}
                  alt={video.title}
                  fill
                  className="object-cover"
                  sizes="80px"
                />
              ) : (
                <div className="flex h-full items-center justify-center">
                  <Music className="h-4 w-4 text-muted-foreground" />
                </div>
              )}
              {index === currentIndex && isPlaying && (
                <div className="absolute inset-0 flex iltems-center justify-center bg-black/40">
                  <Play className="h-4 w-4 fill-white text-white" />
                </div>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <p
                className={cn(
                  "line-clamp-2 text-sm",
                  index === currentIndex && "font-medium"
                )}
              >
                {video.title}
              </p>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="truncate">{video.channelTitle}</span>
                {video.duration > 0 && (
                  <>
                    <span>·</span>
                    <span>{formatDuration(video.duration)}</span>
                  </>
                )}
              </div>
            </div>

            <span className="shrink-0 text-xs text-muted-foreground">
              {index + 1}
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
