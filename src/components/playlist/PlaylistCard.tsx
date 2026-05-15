"use client";

import Link from "next/link";
import Image from "next/image";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ImageOff, Music, MoreVertical, Trash2, RefreshCw, Shuffle } from "lucide-react";
import { useUiPreferencesStore } from "@/stores/ui-preferences-store";
import type { LocalPlaylist } from "@/types/playlist";

interface PlaylistCardProps {
  playlist: LocalPlaylist;
  onDelete: (id: string) => void;
  onSync: (id: string) => void;
}

export function PlaylistCard({ playlist, onDelete, onSync }: PlaylistCardProps) {
  const hideThumbnails = useUiPreferencesStore((state) => state.hideThumbnails);

  return (
    <Card className="group overflow-hidden rounded-[1.75rem] border-white/10 bg-white/[0.055] text-white shadow-2xl shadow-black/20 transition-all duration-300 hover:-translate-y-1 hover:border-white/20 hover:bg-white/[0.08] hover:shadow-black/40">
      <div className="relative aspect-video overflow-hidden bg-white/10">
        {playlist.thumbnail && !hideThumbnails ? (
          <Image
            src={playlist.thumbnail}
            alt={playlist.title}
            fill
            className="object-cover transition-transform group-hover:scale-105"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
        ) : (
          <div className="flex h-full items-center justify-center bg-gradient-to-br from-white/15 via-white/5 to-amber-500/10">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-white/10 bg-black/40 shadow-sm backdrop-blur">
              {hideThumbnails ? (
                <ImageOff className="h-8 w-8 text-white/45" />
              ) : (
                <Music className="h-8 w-8 text-white/45" />
              )}
            </div>
          </div>
        )}
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-black/80 via-black/20 to-transparent" />
        <div className="absolute bottom-2 right-2">
          <Badge className="rounded-full border-white/15 bg-black/70 text-white hover:bg-black/70">
            {playlist.videoCount} videos
          </Badge>
        </div>
      </div>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <Link
              href={`/playlist/${playlist.id}`}
              className="line-clamp-2 font-semibold tracking-tight text-white hover:text-white/80"
            >
              {playlist.title}
            </Link>
            {playlist.channelTitle && (
              <p className="mt-1 text-sm text-white/50">
                {playlist.channelTitle}
              </p>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-white/70 hover:bg-white/10 hover:text-white"
              >
                <MoreVertical className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href={`/playlist/${playlist.id}`}>
                  <Shuffle className="mr-2 h-4 w-4" />
                  Shuffle & Play
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSync(playlist.id)}>
                <RefreshCw className="mr-2 h-4 w-4" />
                Sync with YouTube
              </DropdownMenuItem>
              <DropdownMenuItem
                className="text-red-300 focus:text-red-200"
                onClick={() => onDelete(playlist.id)}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="mt-3 flex items-center gap-2">
          <Link href={`/playlist/${playlist.id}`} className="flex-1">
            <Button
              size="sm"
              className="w-full rounded-full bg-white text-black hover:bg-white/90"
            >
              <Shuffle className="mr-2 h-4 w-4" />
              Shuffle & Play
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
