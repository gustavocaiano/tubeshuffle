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
import {
  getDailySuggestionsResuggestUsed,
  getDailySuggestionsCache,
  getLocalDateKey,
  setDailySuggestionsResuggestUsed,
  setDailySuggestionsCache,
} from "@/lib/suggestions/daily-suggestions-cache";
import { cn, formatDuration } from "@/lib/utils";
import { usePlayerStore, type VideoItem } from "@/stores/player-store";
import type { DailySuggestionsResult, LocalVideo, SuggestedVideo } from "@/types/playlist";

interface DailySuggestionsProps {
  playlistId: string;
  playlistTitle: string;
  videos: LocalVideo[];
}

type DailySuggestionsQueryResult = DailySuggestionsResult & {
  source: "cache" | "network";
};

type SuggestionSeed = Pick<
  LocalVideo,
  "title" | "channelTitle" | "description" | "tags" | "categoryId" | "duration"
>;

const MAX_SEEDS = 40;

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
    if (selected.length >= MAX_SEEDS) break;
    if (!selected.some((video) => video.id === entry.video.id)) {
      selected.push(entry.video);
    }
  }

  return selected.slice(0, MAX_SEEDS).map((video) => ({
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

async function fetchDailySuggestions(
  playlistId: string,
  playlistTitle: string,
  videos: LocalVideo[],
  dateKey: string,
  options: {
    forceRefresh?: boolean;
    previousSuggestions?: SuggestedVideo[];
  } = {}
): Promise<DailySuggestionsQueryResult> {
  const cached = options.forceRefresh ? null : await getDailySuggestionsCache(playlistId, dateKey);
  if (!options.forceRefresh && cached && cached.suggestions.length >= 5) {
    return { ...cached, source: "cache" };
  }

  const excludedSuggestionIds = options.previousSuggestions?.map((suggestion) => suggestion.youtubeId) ?? [];

  const response = await fetch("/api/youtube/suggestions", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      playlistId,
      playlistTitle,
      dateKey,
      seeds: selectSeeds(videos),
      excludeVideoIds: [...videos.map((video) => video.youtubeId), ...excludedSuggestionIds],
      refreshToken: options.forceRefresh ? `${dateKey}:${Date.now()}` : undefined,
    }),
  });

  const payload = (await response.json()) as DailySuggestionsResult | { error?: string };
  if (!response.ok) {
    throw new Error(
      "error" in payload && payload.error
        ? payload.error
        : `Suggestions request failed: ${response.status}`
    );
  }

  const result = payload as DailySuggestionsResult;
  await setDailySuggestionsCache(result);
  return { ...result, source: "network" };
}

export function DailySuggestions({
  playlistId,
  playlistTitle,
  videos,
}: DailySuggestionsProps) {
  const [shouldLoad, setShouldLoad] = useState(false);
  const [dateKey, setDateKey] = useState(() => getLocalDateKey());
  const [resuggestUsed, setResuggestUsed] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const fallbackUrl = useMemo(
    () => buildFallbackSearchUrl(playlistTitle, videos),
    [playlistTitle, videos]
  );
  const { playNowItem, playNextItem } = usePlayerStore();
  const queryClient = useQueryClient();

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

  useEffect(() => {
    let active = true;
    void getDailySuggestionsResuggestUsed(playlistId, dateKey).then((used) => {
      if (active) setResuggestUsed(used);
    });

    return () => {
      active = false;
    };
  }, [playlistId, dateKey]);

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
    queryKey: ["dailySuggestions", playlistId, dateKey],
    queryFn: () => fetchDailySuggestions(playlistId, playlistTitle, videos, dateKey),
    enabled: shouldLoad && videos.length > 0,
    retry: false,
    staleTime: 60 * 60 * 1000,
  });

  const resuggestMutation = useMutation({
    mutationFn: () =>
      fetchDailySuggestions(playlistId, playlistTitle, videos, dateKey, {
        forceRefresh: true,
        previousSuggestions: suggestions,
      }),
    onSuccess: async (result) => {
      await setDailySuggestionsResuggestUsed(playlistId, dateKey);
      setResuggestUsed(true);
      queryClient.setQueryData(["dailySuggestions", playlistId, dateKey], result);
    },
  });

  const suggestions = suggestionsQuery.data?.suggestions ?? [];
  const canResuggest = suggestions.length > 0 && !resuggestUsed;

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
              onClick={() => resuggestMutation.mutate()}
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
          Couldn&apos;t refresh suggestions.
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
                <p className="mt-1 text-sm text-white/55">Try a YouTube search instead.</p>
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
        <div className="relative mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-5">
          {suggestions.map((suggestion, index) => (
            <article
              key={suggestion.youtubeId}
              className="group flex min-h-full flex-col overflow-hidden rounded-3xl border border-white/10 bg-white/[0.055] shadow-xl shadow-black/15 transition-all duration-300 hover:-translate-y-1 hover:border-white/25 hover:bg-white/[0.08]"
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
                <h3 className="line-clamp-2 text-sm font-bold leading-snug text-white">
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
