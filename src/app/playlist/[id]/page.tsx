"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, Music } from "lucide-react";
import { toast } from "sonner";
import { Navbar } from "@/components/layouts/Navbar";
import { VideoPlayer } from "@/components/playlist/VideoPlayer";
import { PlaybackControls } from "@/components/playlist/PlaybackControls";
import { PlayerViewControls } from "@/components/playlist/PlayerViewControls";
import { StagePlayer } from "@/components/playlist/StagePlayer";
import { ShuffleControls } from "@/components/playlist/ShuffleControls";
import { PlaylistQueue } from "@/components/playlist/PlaylistQueue";
import { DailySuggestions } from "@/components/playlist/DailySuggestions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { shuffleVideos } from "@/lib/shuffle/shuffle-service";
import { usePlayerStore, type VideoItem } from "@/stores/player-store";
import { playlistRepository, type LocalPlaylistBundle } from "@/stores/playlist-store";
import { useUiPreferencesStore } from "@/stores/ui-preferences-store";
import type { ShufflePreset } from "@/types/playlist";
import { BrowserStorageNotice } from "@/components/BrowserStorageNotice";
import { useBrowserStorage, isStorageGenerationCurrent } from "@/hooks/use-browser-storage";
import { QueryReadError } from "@/components/QueryReadError";

interface ShuffleInvocation {
  generation: number;
  requestId: number;
  routePlaylistId: string;
  bundle: LocalPlaylistBundle;
  preset: ShufflePreset;
  shouldExcludeWatched: boolean;
}

function ListeningView({
  currentVideo,
  hideThumbnails,
}: {
  currentVideo: VideoItem | null;
  hideThumbnails: boolean;
}) {
  return (
    <div className="relative flex h-full min-h-64 flex-col items-center justify-center gap-4 bg-[#10100f] px-6 py-6 text-center">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(255,255,255,0.06),transparent_70%)]" />
      {currentVideo?.thumbnail && !hideThumbnails && (
        <div className="relative size-28 shrink-0 overflow-hidden rounded-2xl shadow-xl shadow-black/30 outline outline-white/10 sm:size-32">
          <Image
            src={currentVideo.thumbnail}
            alt=""
            fill
            sizes="160px"
            className="object-cover"
          />
        </div>
      )}
      <div className="relative max-w-2xl space-y-3">
        <p className="text-xs font-medium uppercase tracking-[0.2em] text-white/45">
          Now playing
        </p>
        <h2
          title={currentVideo?.title}
          className="line-clamp-3 text-balance text-2xl font-bold tracking-tight sm:text-3xl"
        >
          {currentVideo?.title ?? "Choose a track to start listening"}
        </h2>
        <p className="text-sm text-white/55">{currentVideo?.channelTitle}</p>
      </div>
    </div>
  );
}

export default function PlaylistPage() {
  const params = useParams();
  const playlistId = params.id as string;
  return <PlaylistView key={playlistId} playlistId={playlistId} />;
}

function PlaylistView({ playlistId }: { playlistId: string }) {
  const storage = useBrowserStorage();
  const [shufflePreset, setShufflePreset] = useState<ShufflePreset>("RANDOM");
  const [excludeWatched, setExcludeWatched] = useState(false);

  const { setQueue, currentVideo, queue, currentIndex, playlistId: queuePlaylistId } = usePlayerStore();
  const { focusMode, hideThumbnails } = useUiPreferencesStore();

  // Hook-level mutation callbacks can run after unmount or a route change.
  // Track the mounted instance, active playlist, and newest invocation so
  // superseded requests cannot touch the shared player store or toasts.
  const shuffleRequestIdRef = useRef(0);
  const mountedRef = useRef(false);
  const routePlaylistIdRef = useRef(playlistId);
  const autoShuffleKeyRef = useRef<string | null>(null);
  const canUsePlaylistRef = useRef(false);

  useLayoutEffect(() => {
    mountedRef.current = true;

    if (routePlaylistIdRef.current !== playlistId) {
      routePlaylistIdRef.current = playlistId;
      // Any request from the previous route is stale even if navigation
      // returns to the same playlist before the request settles.
      shuffleRequestIdRef.current += 1;
      autoShuffleKeyRef.current = null;
    }

    return () => {
      mountedRef.current = false;
      canUsePlaylistRef.current = false;
    };
  }, [playlistId]);

  const isCurrentShuffle = useCallback(
    (request: ShuffleInvocation) =>
      isStorageGenerationCurrent(request.generation) &&
      mountedRef.current &&
      canUsePlaylistRef.current &&
      routePlaylistIdRef.current === request.routePlaylistId &&
      request.bundle.playlist.id === routePlaylistIdRef.current &&
      request.requestId === shuffleRequestIdRef.current,
    [],
  );

  const playlistQuery = useQuery({
    queryKey: ["playlist", playlistId, storage.generation],
    retry: false,
    queryFn: () => playlistRepository.getPlaylist(playlistId),
    networkMode: "always",
    enabled: Boolean(playlistId) && (storage.phase === "unknown" || storage.phase === "ready"),
    refetchOnMount: "always",
  });
  const showReadError = playlistQuery.isError || (playlistQuery.isPending && playlistQuery.errorUpdatedAt > 0);

  const canUsePlaylist = storage.phase === "ready" && playlistQuery.isSuccess && playlistQuery.isFetchedAfterMount && playlistQuery.data?.playlist.id === playlistId;
  useLayoutEffect(() => {
    canUsePlaylistRef.current = canUsePlaylist;
    if (!canUsePlaylist) {
      shuffleRequestIdRef.current += 1;
      autoShuffleKeyRef.current = null;
    }
  }, [canUsePlaylist, playlistId]);

  const shuffleMutation = useMutation({
    networkMode: "always",
    mutationFn: async ({
      bundle,
      preset,
      shouldExcludeWatched,
    }: ShuffleInvocation) => {
      let videosToShuffle = bundle.videos;

      if (shouldExcludeWatched) {
        const watchedIds = await playlistRepository.getCompletedVideoIds(
          bundle.playlist.id,
        );
        videosToShuffle = videosToShuffle.filter(
          (video) => !watchedIds.has(video.id),
        );
      }

      return shuffleVideos(videosToShuffle, preset);
    },
    onSuccess: (shuffledVideos, request) => {
      if (!isCurrentShuffle(request)) return;

      const { bundle } = request;

      if (shuffledVideos.length > 0) {
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
      } else {
        toast.error("No videos available with the current filters.");
      }
    },
    onError: (error: Error, request) => {
      if (!isCurrentShuffle(request)) return;
      toast.error(error.message);
    },
  });

  const recordPlayMutation = useMutation({
    mutationFn: (input: {
      generation: number;
      playlistId: string;
      videoId: string;
      completed: boolean;
    }) => {
      const { generation, ...event } = input;
      return playlistRepository.recordPlay({ ...event, watchedSeconds: 0 }, generation);
    },
  });

  const handleShuffle = useCallback(
    (preset: ShufflePreset) => {
      setShufflePreset(preset);

      const bundle = playlistQuery.data;
      if (!isStorageGenerationCurrent(storage.generation) || !bundle || !canUsePlaylistRef.current || bundle.playlist.id !== playlistId || routePlaylistIdRef.current !== playlistId) return;

      shuffleMutation.mutate({
        generation: storage.generation,
        requestId: ++shuffleRequestIdRef.current,
        routePlaylistId: playlistId,
        bundle,
        preset,
        shouldExcludeWatched: excludeWatched,
      });
    },
    [excludeWatched, playlistId, playlistQuery.data, shuffleMutation, storage.generation],
  );

  const handleVideoEnd = useCallback(
    (video: VideoItem) => {
      if (isStorageGenerationCurrent(storage.generation) && mountedRef.current && canUsePlaylistRef.current && routePlaylistIdRef.current === playlistId && usePlayerStore.getState().playlistId === playlistId) {
        recordPlayMutation.mutate({
          generation: storage.generation,
          playlistId,
          videoId: video.id,
          completed: true,
        });
      }
    },
    [playlistId, recordPlayMutation, storage.generation],
  );

  // Auto-shuffle on first load
  useEffect(() => {
    if (canUsePlaylist && playlistQuery.data && playlistQuery.data.videos.length > 0) {
      const playlist = playlistQuery.data.playlist;
      const { playlistId: currentPlaylistId } =
        usePlayerStore.getState();

      if (currentPlaylistId === playlist.id) {
        return;
      }

      if (autoShuffleKeyRef.current === playlist.id) return;
      autoShuffleKeyRef.current = playlist.id;
      handleShuffle("RANDOM");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playlistQuery.data?.playlist.id, canUsePlaylist]);

  const playlist = playlistQuery.data?.playlist;
  const listeningView = focusMode || hideThumbnails;
  const playerClassName = cn(
    "min-h-[200px] rounded-2xl",
    listeningView && "aspect-auto min-h-64",
    listeningView && !hideThumbnails && "min-h-[336px]",
  );
  const playerReady = canUsePlaylist && queuePlaylistId === playlistId;
  const showAmbientThumbnail = Boolean(
    playerReady && currentVideo?.thumbnail && !hideThumbnails,
  );

  return (
    <div className="flex min-h-screen flex-col bg-[#080807] text-white">
      <Navbar />

      <main className="relative min-w-0 flex-1">
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

        <div className="relative mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 lg:px-8">
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
            {playlistQuery.isPending || (!playlistQuery.isError && !playlistQuery.isFetchedAfterMount) ? (
              <div>
                <Skeleton className="h-7 w-48 max-w-full bg-white/10 sm:w-64" />
                <Skeleton className="mt-1 h-4 w-40 bg-white/10" />
              </div>
            ) : playlist ? (
              <div className="min-w-0 flex-1">
                <h1 className="truncate text-2xl font-bold tracking-tight md:text-3xl">
                  {playlist.title}
                </h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-white/55">
                  {playlist.channelTitle && (
                    <span>{playlist.channelTitle}</span>
                  )}
                  {(!playlistQuery.isError || (playlistQuery.data?.videos.length ?? 0) > 0) && (
                    <><span>·</span><span>{playlistQuery.data?.videos.length ?? 0} videos</span></>
                  )}
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
            ) : playlistQuery.isError ? (
              <h1 className="text-2xl font-bold">Playlist unavailable</h1>
            ) : (
              <div>
                <h1 className="text-2xl font-bold">Playlist not found</h1>
              </div>
            )}
          </div>

          <BrowserStorageNotice />
          {showReadError && storage.phase === "ready" && (
            <QueryReadError subject="playlist" stale={Boolean(playlist)} />
          )}

          {playlistQuery.isPending || (!playlistQuery.isError && !playlistQuery.isFetchedAfterMount) ? (
            <div role="status" aria-label={playlistQuery.isPaused ? "Waiting to load your playlist" : "Loading your playlist"} className="grid gap-6 lg:grid-cols-3">
              <div className="lg:col-span-2">
                <Skeleton className="aspect-video w-full rounded-3xl bg-white/10" />
              </div>
              <div>
                <Skeleton className="h-[500px] rounded-3xl bg-white/10" />
              </div>
            </div>
          ) : canUsePlaylist && playlist && (playlistQuery.data?.videos.length ?? 0) > 0 && playerReady ? (
            <>
              <div
                className={cn(
                  "grid min-w-0 items-start gap-4 sm:gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,24rem)]",
                )}
              >
                <div className="min-w-0 rounded-3xl border border-white/10 bg-white/[0.045] p-3 shadow-2xl shadow-black/30 backdrop-blur-xl sm:rounded-[2rem] sm:p-4">
                  <PlayerViewControls />
                  <VideoPlayer
                    onVideoEnd={handleVideoEnd}
                    className={playerClassName}
                    overlay={
                      listeningView ? (
                        <ListeningView
                          currentVideo={currentVideo}
                          hideThumbnails={hideThumbnails}
                        />
                      ) : undefined
                    }
                  />
                  {!focusMode && !hideThumbnails && currentVideo && (
                    <div className="px-1 pb-2 pt-5">
                      <p className="mb-2 text-xs text-white/45">
                        Now playing · Track {currentIndex + 1} of {queue.length}
                      </p>
                      <h2 className="text-balance text-xl font-bold tracking-tight [overflow-wrap:anywhere]">
                        {currentVideo.title}
                      </h2>
                      <p className="mt-1 text-sm text-white/55">
                        {currentVideo.channelTitle}
                      </p>
                    </div>
                  )}
                  <div className="mt-4 border-t border-white/10 pt-2">
                    <PlaybackControls />
                  </div>
                </div>

                <section
                  aria-label="Queue"
                  className="flex h-[min(65dvh,40rem)] min-h-80 min-w-0 flex-col rounded-3xl border border-white/10 bg-white/[0.045] p-3 shadow-2xl shadow-black/30 backdrop-blur-xl sm:rounded-[2rem] sm:p-4 xl:sticky xl:top-6 xl:col-start-2 xl:row-span-2 xl:row-start-1 xl:h-[calc(100dvh-3rem)] xl:max-h-[56rem]"
                >
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
                </section>

                <div className="min-w-0 xl:col-start-1 xl:row-start-2">
                  <ShuffleControls
                    currentPreset={shufflePreset}
                    excludeWatched={excludeWatched}
                    onShuffle={handleShuffle}
                    onExcludeWatchedChange={setExcludeWatched}
                    isShuffling={shuffleMutation.isPending}
                  />
                </div>
              </div>

              <StagePlayer />

              <DailySuggestions
                playlistId={playlist.id}
                playlistTitle={playlist.title}
                videos={playlistQuery.data?.videos ?? []}
              />
            </>
          ) : canUsePlaylist && playlist && (playlistQuery.data?.videos.length ?? 0) > 0 ? (
            <div className="rounded-3xl border border-white/10 bg-white/[0.045] p-6">
              <p role="status" className="mb-4 text-white/70">Preparing this playlist for playback.</p>
              <ShuffleControls currentPreset={shufflePreset} excludeWatched={excludeWatched} onShuffle={handleShuffle} onExcludeWatchedChange={setExcludeWatched} isShuffling={shuffleMutation.isPending} />
            </div>
          ) : canUsePlaylist && playlist ? (
            <div className="flex flex-col items-center justify-center rounded-[2rem] border border-white/10 bg-white/[0.045] py-20 text-center shadow-2xl shadow-black/30 backdrop-blur">
              <Music className="mb-4 h-12 w-12 text-white/45" />
              <h2 className="text-xl font-semibold">
                This playlist has no videos
              </h2>
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
          ) : !showReadError && playlistQuery.isSuccess && playlist ? (
            <p role="status" className="rounded-3xl border border-white/10 bg-white/[0.045] p-6 text-white/70">
              {playlistQuery.isPaused ? "Waiting to read this playlist." : "Checking this playlist…"}
            </p>
          ) : null}
        </div>
      </main>
    </div>
  );
}
