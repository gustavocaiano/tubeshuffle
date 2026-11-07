"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  Music,
  Play,
  RefreshCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { classifyEnergyTrack } from "@/lib/shuffle/energy-classifier";
import { getLocalDateKey } from "@/lib/suggestions/daily-suggestions-cache";
import { cn, formatDuration } from "@/lib/utils";
import { usePlayerStore, type VideoItem } from "@/stores/player-store";
import type { LocalVideo, SuggestedVideo } from "@/types/playlist";
import { safeAccountMessage } from "@/lib/services/account-client";
import { useBrowserStorage } from "@/hooks/use-browser-storage";
import { fetchDailySuggestions, assertSuggestionsOperation } from "@/lib/suggestions/daily-suggestions-client";
import { serializeSuggestionsInput, MAX_SUGGESTION_SEEDS, type SuggestionSeed } from "@/lib/suggestions/input-policy";

interface DailySuggestionsProps {
  playlistId: string;
  playlistTitle: string;
  videos: LocalVideo[];
}

function selectSeeds(videos: LocalVideo[]): SuggestionSeed[] {
  const ranked = videos
    .map((video, index) => ({
      video,
      index,
      profile: classifyEnergyTrack(video),
    }))
    .sort(
      (a, b) =>
        b.profile.confidence - a.profile.confidence ||
        b.profile.score - a.profile.score ||
        a.index - b.index
    );

  const selected: LocalVideo[] = [];
  const seenBuckets = new Set<string>();

  for (const entry of ranked) {
    if (selected.length >= 12) break;
    if (entry.profile.bucket !== "unknown" && !seenBuckets.has(entry.profile.bucket)) {
      selected.push(entry.video);
      seenBuckets.add(entry.profile.bucket);
    }
  }

  for (const entry of ranked) {
    if (selected.length >= MAX_SUGGESTION_SEEDS) break;
    if (!selected.some((video) => video.id === entry.video.id)) {
      selected.push(entry.video);
    }
  }

  return selected.slice(0, MAX_SUGGESTION_SEEDS).map((video) => ({
    title: video.title,
    channelTitle: video.channelTitle,
    description: video.description,
    tags: video.tags,
    categoryId: video.categoryId,
    duration: video.duration,
  }));
}

function toVideoItem(suggestion: SuggestedVideo): VideoItem {
  return {
    id: `suggestion:${suggestion.youtubeId}`,
    youtubeId: suggestion.youtubeId,
    title: suggestion.title,
    channelTitle: suggestion.channelTitle,
    thumbnail: suggestion.thumbnail,
    duration: suggestion.duration,
  };
}

function buildFallbackSearchUrl(playlistTitle: string, videos: LocalVideo[]): string {
  const topSeed = selectSeeds(videos)[0];
  const query = [playlistTitle, topSeed?.title, topSeed?.channelTitle, "similar songs"]
    .filter(Boolean)
    .join(" ");
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

export function DailySuggestions({
  playlistId,
  playlistTitle,
  videos,
}: DailySuggestionsProps) {
  const storage = useBrowserStorage();
  const [dateKey, setDateKey] = useState(() => getLocalDateKey());
  const request = useMemo(() => {
    try {
      return { body: serializeSuggestionsInput({
        playlistId, playlistTitle, dateKey, seeds: selectSeeds(videos),
        excludeVideoIds: videos.map(video => video.youtubeId),
      }) };
    } catch (error) { return { error }; }
  }, [playlistId, playlistTitle, dateKey, videos]);

  useEffect(() => {
    const refreshDateKey = () => setDateKey(getLocalDateKey());
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") refreshDateKey();
    };

    window.addEventListener("focus", refreshDateKey);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    const interval = window.setInterval(refreshDateKey, 60 * 1000);

    return () => {
      window.removeEventListener("focus", refreshDateKey);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.clearInterval(interval);
    };
  }, []);

  if (storage.phase !== "ready") return null;
  return <DailySuggestionsSession
    key={JSON.stringify([storage.generation, dateKey, playlistId, request.body])}
    playlistId={playlistId} playlistTitle={playlistTitle} videos={videos}
    dateKey={dateKey} generation={storage.generation} request={request}
  />;
}

function DailySuggestionsSession({
  playlistId, playlistTitle, videos, dateKey, generation, request,
}: DailySuggestionsProps & { dateKey: string; generation: number; request: { body?: string; error?: unknown } }) {
  const [shouldLoad, setShouldLoad] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const refreshControllers = useRef(new Set<AbortController>());
  const fallbackUrl = useMemo(() => buildFallbackSearchUrl(playlistTitle, videos), [playlistTitle, videos]);
  const { playNowItem, playNextItem } = usePlayerStore();
  const queryClient = useQueryClient();
  const queryKey = ["dailySuggestions", playlistId, dateKey, generation, request.body];

  useEffect(() => {
    const controllers = refreshControllers.current;
    return () => { for (const controller of controllers) controller.abort(); };
  }, []);

  useEffect(() => {
    if (shouldLoad || !sentinelRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setShouldLoad(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [shouldLoad]);

  const suggestionsQuery = useQuery({
    queryKey,
    queryFn: ({ signal }) => {
      if (!request.body) throw request.error;
      return fetchDailySuggestions({ body: request.body, generation, signal });
    },
    enabled: shouldLoad && videos.length > 0,
    retry: false,
    staleTime: 60 * 60 * 1000,
  });

  const suggestions = suggestionsQuery.data?.suggestions ?? [];
  const resuggestUsed = suggestionsQuery.data?.resuggestUsed;
  const resuggestMutation = useMutation({
    mutationFn: (controller: AbortController) => {
      if (!request.body) throw request.error;
      return fetchDailySuggestions({ body: request.body, generation, signal: controller.signal, previousSuggestions: suggestions });
    },
    onSuccess: (result, controller) => {
      assertSuggestionsOperation({ generation, signal: controller.signal });
      queryClient.setQueryData(queryKey, result);
    },
    onSettled: (_result, _error, controller) => { refreshControllers.current.delete(controller); },
  });
  const canResuggest = suggestions.length > 0 && resuggestUsed === false;

  return (
    <section ref={sentinelRef} className="relative mt-8 overflow-hidden rounded-[2rem] border border-white/10 bg-[#10100e]/80 p-5 text-white shadow-2xl shadow-black/30 backdrop-blur-xl md:p-6">
      <div className="pointer-events-none absolute inset-x-8 h-24 rounded-full bg-amber-300/10 blur-3xl" />
      <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h2 className="text-2xl font-black tracking-tight md:text-3xl">Daily Suggestions</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-white/45">
          {suggestions.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                const controller = new AbortController();
                refreshControllers.current.add(controller);
                resuggestMutation.mutate(controller);
              }}
              disabled={!canResuggest || resuggestMutation.isPending}
              className="rounded-full border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
            >
              {resuggestMutation.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCcw className="mr-2 h-4 w-4" />
              )}
              {resuggestUsed ? "Done" : "Again"}
            </Button>
          ) : null}
          {!shouldLoad ? (
            <Button
              type="button"
              onClick={() => setShouldLoad(true)}
              className="rounded-full bg-white text-black hover:bg-white/90"
            >
              Show
            </Button>
          ) : null}
        </div>
      </div>

      {resuggestMutation.isError ? (
        <p className="relative mt-4 rounded-2xl border border-amber-200/15 bg-amber-200/[0.06] px-4 py-3 text-sm text-amber-100">
          {safeAccountMessage(resuggestMutation.error, "Suggestions are unavailable. Please try again.")}
        </p>
      ) : null}

      {suggestionsQuery.isLoading ? (
        <div className="relative mt-6 flex min-h-44 items-center justify-center rounded-3xl border border-white/10 bg-white/[0.045]">
          <Loader2 className="mr-2 h-5 w-5 animate-spin text-white/55" />
          <span className="text-sm text-white/55">Loading suggestions…</span>
        </div>
      ) : suggestionsQuery.isError ? (
        <div className="relative mt-6 rounded-3xl border border-amber-200/15 bg-amber-200/[0.06] p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-200" />
              <div>
                <p className="font-semibold text-amber-100">Suggestions unavailable.</p>
                <p className="mt-1 text-sm text-white/55">{safeAccountMessage(suggestionsQuery.error, "Suggestions are unavailable.")} Try a YouTube search instead.</p>
              </div>
            </div>
            <a href={fallbackUrl} target="_blank" rel="noopener noreferrer">
              <Button className="rounded-full bg-white text-black hover:bg-white/90">
                Search on YouTube
                <ExternalLink className="ml-2 h-4 w-4" />
              </Button>
            </a>
          </div>
        </div>
      ) : suggestions.length > 0 ? (
        <div className="relative mt-6 grid grid-cols-[repeat(auto-fit,minmax(min(100%,15rem),1fr))] gap-3">
          {suggestions.map((suggestion, index) => (
            <article
              key={suggestion.youtubeId}
              className="group flex min-h-full flex-col overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] shadow-xl shadow-black/15 transition-colors hover:border-white/25 hover:bg-white/[0.08]"
            >
              <div className="relative aspect-video overflow-hidden bg-white/10">
                {suggestion.thumbnail ? (
                  <Image
                    src={suggestion.thumbnail}
                    alt=""
                    fill
                    className="object-cover transition-transform duration-500 group-hover:scale-105"
                    sizes="(max-width: 768px) 100vw, (max-width: 1280px) 50vw, 20vw"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center bg-gradient-to-br from-white/15 via-white/5 to-amber-500/10">
                    <Music className="h-6 w-6 text-white/45" />
                  </div>
                )}
                <div className="absolute left-3 top-3 rounded-full bg-black/60 px-2 py-1 text-xs font-bold text-white backdrop-blur">
                  0{index + 1}
                </div>
                {suggestion.duration > 0 ? (
                  <div className="absolute bottom-3 right-3 rounded-full bg-black/70 px-2 py-1 text-xs text-white backdrop-blur">
                    {formatDuration(suggestion.duration)}
                  </div>
                ) : null}
              </div>

              <div className="flex flex-1 flex-col p-4">
                <h3 className="line-clamp-2 text-sm font-bold leading-snug text-white [overflow-wrap:anywhere]">
                  {suggestion.title}
                </h3>
                <p className="mt-2 truncate text-xs text-white/45">{suggestion.channelTitle}</p>

                <div className="mt-auto grid gap-2 pt-4">
                  <Button
                    type="button"
                    onClick={() => playNowItem(toVideoItem(suggestion))}
                    className="h-9 rounded-full bg-white text-black hover:bg-white/90"
                  >
                    <Play className="mr-2 h-3.5 w-3.5 fill-current" />
                    Play now
                  </Button>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => playNextItem(toVideoItem(suggestion))}
                      className="h-9 rounded-full border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
                    >
                      Next
                    </Button>
                    <a href={suggestion.url} target="_blank" rel="noopener noreferrer">
                      <Button
                        type="button"
                        variant="outline"
                        className="h-9 w-full rounded-full border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white"
                      >
                        YouTube
                        <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                      </Button>
                    </a>
                  </div>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : shouldLoad && suggestionsQuery.isSuccess ? (
        <div className="relative mt-6 flex flex-col items-center justify-center rounded-3xl border border-white/10 bg-white/[0.045] p-8 text-center">
          <Music className="mb-3 h-8 w-8 text-white/45" />
          <p className="font-semibold">No suggestions today.</p>
          <p className="mt-1 max-w-md text-sm text-white/50">Try a YouTube search instead.</p>
          <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className="mt-4">
            <Button className="rounded-full bg-white text-black hover:bg-white/90">
              Search on YouTube
              <ExternalLink className="ml-2 h-4 w-4" />
            </Button>
          </a>
        </div>
      ) : (
        <div className={cn("relative mt-6 rounded-3xl border border-dashed border-white/10 bg-white/[0.035] p-6 text-sm text-white/45", !shouldLoad && "text-center")}>
          Scroll or tap Show.
        </div>
      )}
    </section>
  );
}
