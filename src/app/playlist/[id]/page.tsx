"use client";

import { useEffect, useState, useCallback } from "react";
import { useSession } from "next-auth/react";
import { useRouter, useParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { usePlayerStore } from "@/stores/player-store";
import { Navbar } from "@/components/layouts/Navbar";
import { VideoPlayer } from "@/components/playlist/VideoPlayer";
import { ShuffleControls } from "@/components/playlist/ShuffleControls";
import { PlaylistQueue } from "@/components/playlist/PlaylistQueue";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, ExternalLink, Music } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";
import type { ShufflePreset } from "@/types/playlist";

export default function PlaylistPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const params = useParams();
  const playlistId = params.id as string;

  const [shufflePreset, setShufflePreset] = useState<ShufflePreset>("RANDOM");
  const [excludeWatched, setExcludeWatched] = useState(false);

  const { setQueue, currentVideo } = usePlayerStore();

  useEffect(() => {
    if (status === "unauthenticated") {
      router.push("/login");
    }
  }, [status, router]);

  const profileQuery = trpc.user.getProfile.useQuery(undefined, {
    enabled: !!session,
  });

  const playlistQuery = trpc.playlist.get.useQuery(
    { id: playlistId },
    { enabled: !!session && !!playlistId }
  );

  const shuffleMutation = trpc.playlist.shuffle.useMutation({
    onSuccess: (shuffledVideos) => {
      const playlist = playlistQuery.data;
      if (playlist && shuffledVideos.length > 0) {
        const queueVideos = shuffledVideos.map((v) => ({
          id: v.id,
          youtubeId: v.youtubeId,
          title: v.title,
          channelTitle: v.channelTitle,
          thumbnail: v.thumbnail,
          duration: v.duration,
        }));
        setQueue(queueVideos, playlist.id, playlist.title);
        toast.success(`Shuffled ${shuffledVideos.length} videos`);
      }
    },
    onError: (error) => {
      toast.error(error.message);
    },
  });

  const recordPlayMutation = trpc.playlist.recordPlay.useMutation();

  const handleShuffle = useCallback(
    (preset: ShufflePreset) => {
      setShufflePreset(preset);
      shuffleMutation.mutate({
        playlistId,
        preset,
        excludeWatched,
      });
    },
    [playlistId, excludeWatched, shuffleMutation]
  );

  const handleVideoEnd = useCallback(() => {
    if (currentVideo && playlistId) {
      recordPlayMutation.mutate({
        playlistId,
        videoId: currentVideo.id,
        completed: true,
      });
    }
  }, [currentVideo, playlistId, recordPlayMutation]);

  // Auto-shuffle on first load
  useEffect(() => {
    if (playlistQuery.data && playlistQuery.data.videos.length > 0) {
      const playlist = playlistQuery.data;
      const { playlistId: currentPlaylistId, queue } = usePlayerStore.getState();
      
      // Don't auto-shuffle if we're already playing this playlist with a queue
      if (currentPlaylistId === playlist.id && queue.length > 0) {
        return;
      }
      
      // Auto-shuffle only on first visit or when switching playlists
      handleShuffle("RANDOM");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistQuery.data?.id]);

  if (status === "loading" || status === "unauthenticated") {
    return null;
  }

  const playlist = playlistQuery.data;
  const isPremium = profileQuery.data?.subscription === "PREMIUM";

  return (
    <div className="flex min-h-screen flex-col">
      <Navbar />

      <main className="flex-1">
        <div className="container mx-auto px-4 py-6">
          {/* Back + Title */}
          <div className="mb-6 flex items-center gap-4">
            <Link href="/dashboard">
              <Button variant="ghost" size="icon">
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            {playlistQuery.isLoading ? (
              <div>
                <Skeleton className="h-7 w-64" />
                <Skeleton className="mt-1 h-4 w-40" />
              </div>
            ) : playlist ? (
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-2xl font-bold">
                  {playlist.title}
                </h1>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {playlist.channelTitle && (
                    <span>{playlist.channelTitle}</span>
                  )}
                  <span>·</span>
                  <span>{playlist.videos.length} videos</span>
                  <a
                    href={`https://youtube.com/playlist?list=${playlist.youtubeId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-foreground"
                  >
                    <ExternalLink className="h-3 w-3" />
                    YouTube
                  </a>
                </div>
              </div>
            ) : (
              <div>
                <h1 className="text-2xl font-bold">Playlist not found</h1>
              </div>
            )}
          </div>

          {playlistQuery.isLoading ? (
            <div className="grid gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Skeleton className="aspect-video w-full rounded-xl" />
              </div>
              <div>
                <Skeleton className="h-[500px] rounded-xl" />
              </div>
            </div>
          ) : playlist && playlist.videos.length > 0 ? (
            <div className="grid gap-6 lg:grid-cols-3">
              {/* Player + Controls */}
              <div className="space-y-4 lg:col-span-2">
                <VideoPlayer onVideoEnd={handleVideoEnd} />

                {/* Now Playing */}
                {currentVideo && (
                  <div className="rounded-lg border p-4">
                    <p className="text-xs font-medium uppercase text-muted-foreground">
                      Now Playing
                    </p>
                    <p className="mt-1 font-semibold">{currentVideo.title}</p>
                    <p className="text-sm text-muted-foreground">
                      {currentVideo.channelTitle}
                    </p>
                  </div>
                )}

                <ShuffleControls
                  isPremium={isPremium}
                  currentPreset={shufflePreset}
                  excludeWatched={excludeWatched}
                  onShuffle={handleShuffle}
                  onExcludeWatchedChange={setExcludeWatched}
                  isShuffling={shuffleMutation.isPending}
                />
              </div>

              {/* Queue */}
              <div className="rounded-xl border p-4">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="font-semibold">Queue</h2>
                  <Badge variant="secondary">
                    {usePlayerStore.getState().queue.length} videos
                  </Badge>
                </div>
                <PlaylistQueue />
              </div>
            </div>
          ) : playlist ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <Music className="mb-4 h-12 w-12 text-muted-foreground" />
              <h2 className="text-xl font-semibold">
                This playlist has no videos
              </h2>
              <p className="mt-2 text-muted-foreground">
                The playlist might be empty or all videos are unavailable.
              </p>
              <Link href="/dashboard" className="mt-6">
                <Button variant="outline">Back to Dashboard</Button>
              </Link>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
