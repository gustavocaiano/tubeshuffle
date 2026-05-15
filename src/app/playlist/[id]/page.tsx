"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Headphones, ImageOff, Music } from "lucide-react";
import { toast } from "sonner";
import { Navbar } from "@/components/layouts/Navbar";
import { VideoPlayer } from "@/components/playlist/VideoPlayer";
import { ShuffleControls } from "@/components/playlist/ShuffleControls";
import { PlaylistQueue } from "@/components/playlist/PlaylistQueue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn, formatDuration } from "@/lib/utils";
import { shuffleVideos } from "@/lib/shuffle/shuffle-service";
import { usePlayerStore, type VideoItem } from "@/stores/player-store";
import { playlistRepository } from "@/stores/playlist-store";
import { useUiPreferencesStore } from "@/stores/ui-preferences-store";
import type { ShufflePreset } from "@/types/playlist";

interface NowPlayingCardProps {
  currentVideo: VideoItem | null;
  hideThumbnails: boolean;
  focusMode: boolean;
  currentIndex: number;
  queueLength: number;
}

function FocusPlayerOverlay({
  currentVideo,
  hideThumbnails,
  currentIndex,
  queueLength,
}: Omit<NowPlayingCardProps, "focusMode">) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-[#080807]/95 p-5 text-center text-white backdrop-blur-2xl">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.12),transparent_42%),radial-gradient(circle_at_20%_80%,rgba(255,255,255,0.08),transparent_32%)]" />
      <div className="relative mx-auto flex max-w-3xl flex-col items-center gap-4">
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.07] px-3 py-1 text-xs font-medium text-white/55 shadow-sm">
          <Headphones className="h-3.5 w-3.5" />
          Audio focus · YouTube player active behind this screen
        </div>

        {currentVideo?.thumbnail && !hideThumbnails ? (
          <div className="relative h-24 w-24 overflow-hidden rounded-3xl border border-white/10 bg-white/10 shadow-2xl shadow-black/30 sm:h-32 sm:w-32">
            <Image
              src={currentVideo.thumbnail}
              alt=""
              fill
              className="object-cover"
              sizes="128px"
            />
          </div>
        ) : (
          <div className="flex h-24 w-24 items-center justify-center rounded-3xl border border-white/10 bg-gradient-to-br from-white/15 via-white/5 to-amber-500/10 shadow-2xl shadow-black/20 sm:h-32 sm:w-32">
            <ImageOff className="h-10 w-10 text-white/45" />
          </div>
        )}

        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-white/45">
            {queueLength > 0 && currentIndex >= 0
              ? `Track ${currentIndex + 1} of ${queueLength}`
              : "Ready"}
          </p>
          <h2 className="line-clamp-2 text-2xl font-black tracking-tight sm:text-4xl">
            {currentVideo?.title ?? "Shuffle to start listening"}
          </h2>
          {currentVideo ? (
            <p className="truncate text-sm text-white/55 sm:text-base">
              {currentVideo.channelTitle}
            </p>
          ) : null}
        </div>

        <p className="max-w-xl text-xs text-white/45 sm:text-sm">
          The rendered video is covered in Focus mode, while the YouTube iframe
          stays present for compliant playback control.
        </p>
      </div>
    </div>
  );
}

function NowPlayingCard({
  currentVideo,
  hideThumbnails,
  focusMode,
  currentIndex,
  queueLength,
}: NowPlayingCardProps) {
  if (!currentVideo) {
    return (
      <div className="rounded-3xl border border-dashed border-white/10 bg-white/[0.045] p-6 text-center text-white">
        <Music className="mx-auto mb-3 h-8 w-8 text-white/45" />
        <p className="font-medium">Shuffle to start listening</p>
        <p className="mt-1 text-sm text-white/45">
          Your next track will appear here.
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] p-4 text-white shadow-2xl shadow-black/20 backdrop-blur",
        focusMode && "flex min-h-[220px] flex-col justify-center p-6"
      )}
    >
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.06] via-transparent to-amber-500/10" />
      <div className="relative flex gap-4">
        <div
          className={cn(
            "relative shrink-0 overflow-hidden rounded-2xl bg-white/10",
            focusMode ? "h-28 w-28 sm:h-36 sm:w-36" : "h-20 w-20"
          )}
        >
          {currentVideo.thumbnail && !hideThumbnails ? (
            <Image
              src={currentVideo.thumbnail}
              alt=""
              fill
              className="object-cover"
              sizes={focusMode ? "144px" : "80px"}
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-white/15 via-white/5 to-amber-500/10">
              {hideThumbnails ? (
                <ImageOff className="h-8 w-8 text-white/55" />
              ) : (
                <Headphones className="h-8 w-8 text-white/55" />
              )}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge className="rounded-full border-white/15 bg-white/10 text-white hover:bg-white/10">
              Now playing
            </Badge>
            {queueLength > 0 && currentIndex >= 0 && (
              <span className="text-xs text-white/45">
                {currentIndex + 1} / {queueLength}
              </span>
            )}
          </div>
          <h2
            className={cn(
              "line-clamp-2 font-bold tracking-tight",
              focusMode ? "text-2xl md:text-4xl" : "text-xl"
            )}
          >
            {currentVideo.title}
          </h2>
          <p className="mt-2 truncate text-sm text-white/55">
            {currentVideo.channelTitle}
          </p>
          {currentVideo.duration > 0 && (
            <p className="mt-3 text-xs uppercase tracking-[0.2em] text-white/40">
              {formatDuration(currentVideo.duration)} · YouTube playback
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PlaylistPage() {
  const params = useParams();
  const playlistId = params.id as string;

  const [shufflePreset, setShufflePreset] = useState<ShufflePreset>("RANDOM");
  const [excludeWatched, setExcludeWatched] = useState(false);

  const { setQueue, currentVideo, queue, currentIndex } = usePlayerStore();
  const { focusMode, hideThumbnails } = useUiPreferencesStore();

  const playlistQuery = useQuery({
    queryKey: ["playlist", playlistId],
    queryFn: () => playlistRepository.getPlaylist(playlistId),
    enabled: Boolean(playlistId),
  });

  const shuffleMutation = useMutation({
    mutationFn: async ({
      preset,
      shouldExcludeWatched,
    }: {
      preset: ShufflePreset;
      shouldExcludeWatched: boolean;
    }) => {
      const data = playlistQuery.data;
      if (!data) return [];

      let videosToShuffle = data.videos;

      if (shouldExcludeWatched) {
        const watchedIds = await playlistRepository.getCompletedVideoIds(playlistId);
        videosToShuffle = videosToShuffle.filter((video) => !watchedIds.has(video.id));
      }

      return shuffleVideos(videosToShuffle, preset);
    },
    onSuccess: (shuffledVideos) => {
      const bundle = playlistQuery.data;
      if (bundle && shuffledVideos.length > 0) {
        const queueVideos = shuffledVideos.map((v) => ({
          id: v.id,
          youtubeId: v.youtubeId,
          title: v.title,
          channelTitle: v.channelTitle,
          thumbnail: v.thumbnail,
          duration: v.duration,
        }));
        setQueue(queueVideos, bundle.playlist.id, bundle.playlist.title);
        toast.success(`Shuffled ${shuffledVideos.length} videos`);
      } else if (bundle && shuffledVideos.length === 0) {
        toast.error("No videos available with the current filters.");
      }
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const recordPlayMutation = useMutation({
    mutationFn: (input: { playlistId: string; videoId: string; completed: boolean }) =>
      playlistRepository.recordPlay({ ...input, watchedSeconds: 0 }),
  });

  const handleShuffle = useCallback(
    (preset: ShufflePreset) => {
      setShufflePreset(preset);
      shuffleMutation.mutate({ preset, shouldExcludeWatched: excludeWatched });
    },
    [excludeWatched, shuffleMutation]
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
      const playlist = playlistQuery.data.playlist;
      const { playlistId: currentPlaylistId, queue } = usePlayerStore.getState();

      if (currentPlaylistId === playlist.id && queue.length > 0) {
        return;
      }

      handleShuffle("RANDOM");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistQuery.data?.playlist.id]);

  const playlist = playlistQuery.data?.playlist;
  const showAmbientThumbnail = Boolean(currentVideo?.thumbnail && !hideThumbnails);

  return (
    <div className="flex min-h-screen flex-col bg-[#080807] text-white">
      <Navbar />

      <main className="relative flex-1 overflow-hidden">
        <div className="pointer-events-none absolute inset-x-0 top-0 h-[620px] overflow-hidden opacity-90">
          {showAmbientThumbnail ? (
            <div
              className="absolute inset-x-8 top-8 h-[440px] scale-110 rounded-[4rem] bg-cover bg-center opacity-30 blur-3xl saturate-150"
              style={{ backgroundImage: `url(${currentVideo?.thumbnail})` }}
            />
          ) : (
            <div className="absolute left-1/2 top-16 h-96 w-96 -translate-x-1/2 rounded-full bg-white/10 blur-3xl" />
          )}
          <div className="absolute inset-0 bg-gradient-to-b from-[#080807]/10 via-[#080807]/75 to-[#080807]" />
        </div>

        <div className="container relative mx-auto px-4 py-6">
          <div className="mb-6 flex items-center gap-4">
            <Link href="/dashboard">
              <Button
                variant="ghost"
                size="icon"
                className="text-white/70 hover:bg-white/10 hover:text-white"
                aria-label="Back to dashboard"
              >
                <ArrowLeft className="h-5 w-5" />
              </Button>
            </Link>
            {playlistQuery.isLoading ? (
              <div>
                <Skeleton className="h-7 w-64 bg-white/10" />
                <Skeleton className="mt-1 h-4 w-40 bg-white/10" />
              </div>
            ) : playlist ? (
              <div className="min-w-0 flex-1">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  {focusMode && (
                    <Badge className="rounded-full border-white/15 bg-white/10 text-white hover:bg-white/10">
                      <Headphones className="mr-1 h-3 w-3" />
                      Focus mode
                    </Badge>
                  )}
                  {hideThumbnails && (
                    <Badge className="rounded-full border-white/15 bg-white/5 text-white/70 hover:bg-white/10">
                      <ImageOff className="mr-1 h-3 w-3" />
                      No artwork
                    </Badge>
                  )}
                </div>
                <h1 className="truncate text-2xl font-bold tracking-tight md:text-3xl">
                  {playlist.title}
                </h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-white/55">
                  {playlist.channelTitle && <span>{playlist.channelTitle}</span>}
                  <span>·</span>
                  <span>{playlistQuery.data?.videos.length ?? 0} videos</span>
                  <a
                    href={`https://youtube.com/playlist?list=${playlist.youtubeId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 hover:text-white"
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
                <Skeleton className="aspect-video w-full rounded-3xl bg-white/10" />
              </div>
              <div>
                <Skeleton className="h-[500px] rounded-3xl bg-white/10" />
              </div>
            </div>
          ) : playlist && (playlistQuery.data?.videos.length ?? 0) > 0 ? (
            <div
              className={cn(
                "grid gap-6",
                focusMode ? "xl:grid-cols-[minmax(0,1fr)_390px]" : "lg:grid-cols-3"
              )}
            >
              <div className={cn("space-y-4", !focusMode && "lg:col-span-2")}>
                <div className="rounded-[2rem] border border-white/10 bg-white/[0.045] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl">
                  {focusMode ? (
                    <div className="space-y-4">
                      <VideoPlayer
                        compact
                        onVideoEnd={handleVideoEnd}
                        className="rounded-2xl"
                        overlay={
                          <FocusPlayerOverlay
                            currentVideo={currentVideo}
                            hideThumbnails={hideThumbnails}
                            currentIndex={currentIndex}
                            queueLength={queue.length}
                          />
                        }
                      />
                      <NowPlayingCard
                        currentVideo={currentVideo}
                        hideThumbnails={hideThumbnails}
                        focusMode={focusMode}
                        currentIndex={currentIndex}
                        queueLength={queue.length}
                      />
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <VideoPlayer onVideoEnd={handleVideoEnd} />
                      <NowPlayingCard
                        currentVideo={currentVideo}
                        hideThumbnails={hideThumbnails}
                        focusMode={focusMode}
                        currentIndex={currentIndex}
                        queueLength={queue.length}
                      />
                    </div>
                  )}
                </div>

                <ShuffleControls
                  currentPreset={shufflePreset}
                  excludeWatched={excludeWatched}
                  onShuffle={handleShuffle}
                  onExcludeWatchedChange={setExcludeWatched}
                  isShuffling={shuffleMutation.isPending}
                />
              </div>

              <div className="flex min-h-[420px] min-w-0 flex-col rounded-[2rem] border border-white/10 bg-white/[0.045] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl">
                <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">Queue</h2>
                    {queue.length > 0 && currentIndex >= 0 && (
                      <p className="text-xs text-white/45">
                        Track {currentIndex + 1} of {queue.length}
                      </p>
                    )}
                  </div>
                  <Badge className="rounded-full border-white/15 bg-white/10 text-white hover:bg-white/10">
                    {queue.length} videos
                  </Badge>
                </div>
                <PlaylistQueue compact={focusMode} fill />
              </div>
            </div>
          ) : playlist ? (
            <div className="flex flex-col items-center justify-center rounded-[2rem] border border-white/10 bg-white/[0.045] py-20 text-center shadow-2xl shadow-black/30 backdrop-blur">
              <Music className="mb-4 h-12 w-12 text-white/45" />
              <h2 className="text-xl font-semibold">This playlist has no videos</h2>
              <p className="mt-2 text-white/55">
                The playlist might be empty or all videos are unavailable.
              </p>
              <Link href="/dashboard" className="mt-6">
                <Button
                  variant="outline"
                  className="rounded-full border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
                >
                  Back to Dashboard
                </Button>
              </Link>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
