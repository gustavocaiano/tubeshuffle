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
import { Music, MoreVertical, Trash2, RefreshCw, Shuffle } from "lucide-react";
import type { LocalPlaylist } from "@/types/playlist";

interface PlaylistCardProps {
  playlist: LocalPlaylist;
  onDelete: (id: string) => void;
  onSync: (id: string) => void;
}

export function PlaylistCard({ playlist, onDelete, onSync }: PlaylistCardProps) {
  return (
    <Card className="group overflow-hidden transition-shadow hover:shadow-lg">
      <div className="relative aspect-video overflow-hidden bg-muted">
        {playlist.thumbnail ? (
          <Image
            src={playlist.thumbnail}
            alt={playlist.title}
            fill
            className="object-cover transition-transform group-hover:scale-105"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
          />
        ) : (
          <div className="flex h-full items-center justify-center">
            <Music className="h-12 w-12 text-muted-foreground" />
          </div>
        )}
        <div className="absolute bottom-2 right-2">
          <Badge variant="secondary" className="bg-black/70 text-white">
            {playlist.videoCount} videos
          </Badge>
        </div>
      </div>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <Link
              href={`/playlist/${playlist.id}`}
              className="line-clamp-2 font-semibold hover:underline"
            >
              {playlist.title}
            </Link>
            {playlist.channelTitle && (
              <p className="mt-1 text-sm text-muted-foreground">
                {playlist.channelTitle}
              </p>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
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
                className="text-destructive"
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
            <Button size="sm" className="w-full">
              <Shuffle className="mr-2 h-4 w-4" />
              Shuffle & Play
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
