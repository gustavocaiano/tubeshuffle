"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  ExternalLink,
  Headphones,
  ImageOff,
  Minimize2,
  Music,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { toast } from "sonner";
import { Navbar } from "@/components/layouts/Navbar";
import { VideoPlayer } from "@/components/playlist/VideoPlayer";
import { ShuffleControls } from "@/components/playlist/ShuffleControls";
import { PlaylistQueue } from "@/components/playlist/PlaylistQueue";
import { DailySuggestions } from "@/components/playlist/DailySuggestions";
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

interface FullWindowPlayerProps {
  currentVideo: VideoItem | null;
  hideThumbnails: boolean;
  currentIndex: number;
  queueLength: number;
  onClose: () => void;
}

function FullWindowPlayer({
  currentVideo,
  hideThumbnails,
  currentIndex,
  queueLength,
  onClose,
}: FullWindowPlayerProps) {
  const { isPlaying, togglePlay, playNext, playPrevious } = usePlayerStore();
  const showArtwork = Boolean(currentVideo?.thumbnail && !hideThumbnails);

  return (
    <div className="group/full-player fixed inset-0 z-[100] overflow-hidden bg-[#080807] text-white">
      {showArtwork ? (
        <div
          className="pointer-events-none absolute inset-[-12%] bg-cover bg-center opacity-35 blur-[120px] saturate-150"
          style={{ backgroundImage: `url(${currentVideo?.thumbnail})` }}
        />
      ) : (
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_12%,rgba(255,255,255,0.16),transparent_34%),radial-gradient(circle_at_12%_78%,rgba(245,158,11,0.14),transparent_30%),radial-gradient(circle_at_88%_70%,rgba(255,255,255,0.08),transparent_32%)]" />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/20 via-[#080807]/45 to-black/80" />

      <div className="pointer-events-none relative z-10 flex h-screen flex-col items-center justify-center px-6 text-center">
        <div className="mb-8 flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.06] px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.28em] text-white/45 backdrop-blur-xl">
          Stage
          {queueLength > 0 && currentIndex >= 0 ? (
            <span className="normal-case tracking-normal text-white/35">
              {currentIndex + 1} / {queueLength}
            </span>
          ) : null}
        </div>

        {showArtwork ? (
          <div className="relative h-64 w-64 overflow-hidden rounded-[2rem] border border-white/10 bg-white/10 shadow-2xl shadow-black/60 sm:h-80 sm:w-80 lg:h-96 lg:w-96">
            <Image
              src={currentVideo!.thumbnail}
              alt=""
              fill
              className="object-cover"
              sizes="(max-width: 640px) 256px, (max-width: 1024px) 320px, 384px"
              priority
            />
          </div>
        ) : (
          <div className="flex h-64 w-64 items-center justify-center rounded-[2rem] border border-white/10 bg-white/[0.07] shadow-2xl shadow-black/60 backdrop-blur-xl sm:h-80 sm:w-80 lg:h-96 lg:w-96">
            <Music className="h-20 w-20 text-white/45" />
          </div>
        )}

        <div className="mt-10 max-w-5xl space-y-3">
          <h1 className="line-clamp-2 text-4xl font-black tracking-tight drop-shadow-2xl sm:text-6xl lg:text-7xl">
            {currentVideo?.title ?? "Shuffle to start listening"}
          </h1>
          <p className="text-lg font-medium text-white/60 sm:text-2xl">
            {currentVideo?.channelTitle ?? "Your full-window player is ready"}
          </p>
        </div>
      </div>

      <div className="absolute inset-0 z-20 grid grid-cols-3">
        <button
          type="button"
          onClick={playPrevious}
          className="group/zone flex cursor-pointer items-center justify-start pl-6 outline-none transition-colors hover:bg-gradient-to-r hover:from-black/25 hover:to-transparent focus-visible:bg-gradient-to-r focus-visible:from-black/25 focus-visible:to-transparent sm:pl-16"
          aria-label="Previous track"
        >
          <span className="flex h-20 w-20 scale-75 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white opacity-0 shadow-2xl shadow-black/40 backdrop-blur-xl transition-all duration-300 group-hover/zone:scale-100 group-hover/zone:opacity-100 group-focus-visible/zone:scale-100 group-focus-visible/zone:opacity-100 sm:h-24 sm:w-24">
            <SkipBack className="h-10 w-10 sm:h-12 sm:w-12" />
          </span>
        </button>

        <button
          type="button"
          onClick={togglePlay}
          className="group/zone flex cursor-pointer items-center justify-center outline-none transition-colors hover:bg-black/10 focus-visible:bg-black/10"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          <span className="flex h-24 w-24 scale-75 items-center justify-center rounded-full border border-white/15 bg-white/15 text-white opacity-0 shadow-2xl shadow-black/50 backdrop-blur-xl transition-all duration-300 group-hover/zone:scale-100 group-hover/zone:opacity-100 group-focus-visible/zone:scale-100 group-focus-visible/zone:opacity-100 sm:h-32 sm:w-32">
            {isPlaying ? (
              <Pause className="h-12 w-12 sm:h-16 sm:w-16" />
            ) : (
              <Play className="h-12 w-12 sm:h-16 sm:w-16" />
            )}
          </span>
        </button>

        <button
          type="button"
          onClick={playNext}
          className="group/zone flex cursor-pointer items-center justify-end pr-6 outline-none transition-colors hover:bg-gradient-to-l hover:from-black/25 hover:to-transparent focus-visible:bg-gradient-to-l focus-visible:from-black/25 focus-visible:to-transparent sm:pr-16"
          aria-label="Next track"
        >
          <span className="flex h-20 w-20 scale-75 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white opacity-0 shadow-2xl shadow-black/40 backdrop-blur-xl transition-all duration-300 group-hover/zone:scale-100 group-hover/zone:opacity-100 group-focus-visible/zone:scale-100 group-focus-visible/zone:opacity-100 sm:h-24 sm:w-24">
            <SkipForward className="h-10 w-10 sm:h-12 sm:w-12" />
          </span>
        </button>
      </div>

      <button
        type="button"
        onClick={onClose}
        className="absolute right-5 top-5 z-30 flex h-11 w-11 items-center justify-center rounded-full border border-white/10 bg-white/10 text-white opacity-0 shadow-2xl shadow-black/40 backdrop-blur-xl transition-all hover:bg-white/15 hover:opacity-100 focus-visible:opacity-100 group-hover/full-player:opacity-100"
        aria-label="Exit stage player"
      >
        <Minimize2 className="h-5 w-5" />
      </button>

      <p className="pointer-events-none absolute bottom-5 left-1/2 z-30 -translate-x-1/2 text-xs text-white/35 opacity-0 transition-opacity group-hover/full-player:opacity-100">
        Hover to control · Esc to exit
      </p>
    </div>
  );
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
          Focus
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
              {formatDuration(currentVideo.duration)}
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
  const { focusMode, hideThumbnails, fullWindowMode, setFullWindowMode } =
    useUiPreferencesStore();

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

  useEffect(() => {
    if (!fullWindowMode) return;

    const previousOverflow = document.body.style.overflow;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setFullWindowMode(false);
      }
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [fullWindowMode, setFullWindowMode]);

  const playlist = playlistQuery.data?.playlist;
  const showAmbientThumbnail = Boolean(currentVideo?.thumbnail && !hideThumbnails);

  return (
    <div className="flex min-h-screen flex-col bg-[#080807] text-white">
      <Navbar />

      {fullWindowMode ? (
        <FullWindowPlayer
          currentVideo={currentVideo}
          hideThumbnails={hideThumbnails}
          currentIndex={currentIndex}
          queueLength={queue.length}
          onClose={() => setFullWindowMode(false)}
        />
      ) : null}

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
                      Focus
                    </Badge>
                  )}
                  {hideThumbnails && (
                    <Badge className="rounded-full border-white/15 bg-white/5 text-white/70 hover:bg-white/10">
                      <ImageOff className="mr-1 h-3 w-3" />
                      No art
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
            <>
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

                <div className="flex h-[calc(100vh-7rem)] min-h-[360px] min-w-0 flex-col rounded-[2rem] border border-white/10 bg-white/[0.045] p-4 shadow-2xl shadow-black/30 backdrop-blur-xl lg:sticky lg:top-20">
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
                  <PlaylistQueue
                    compact={focusMode}
                    fill
                    sourcePlaylistYoutubeId={playlist.youtubeId}
                  />
                </div>
              </div>

              <DailySuggestions
                playlistId={playlist.id}
                playlistTitle={playlist.title}
                videos={playlistQuery.data?.videos ?? []}
              />
            </>
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
