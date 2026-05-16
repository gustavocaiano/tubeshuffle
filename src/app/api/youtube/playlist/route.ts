import { NextResponse } from "next/server";
import { parseIsoDuration } from "@/lib/utils";
import type { YouTubePlaylistData, YouTubeVideoData } from "@/types/playlist";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const MAX_RESULTS_PER_PAGE = 50;
const MAX_PLAYLIST_PAGES = 100;
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,80}$/;

type ApiError = {
  status: number;
  message: string;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function getPlaylistId(request: Request): string {
  const url = new URL(request.url);
  const params = url.searchParams;
  const allowedParams = new Set(["list", "playlistId"]);

  for (const key of params.keys()) {
    if (!allowedParams.has(key)) {
      throw { status: 400, message: `Unsupported query parameter: ${key}` } satisfies ApiError;
    }
  }

  const playlistId = (params.get("list") ?? params.get("playlistId") ?? "").trim();

  if (!playlistId) {
    throw { status: 400, message: "Missing required query parameter: list" } satisfies ApiError;
  }

  if (!PLAYLIST_ID_PATTERN.test(playlistId)) {
    throw { status: 400, message: "Invalid playlist id format" } satisfies ApiError;
  }

  return playlistId;
}

async function fetchYouTubeJson<T>(
  endpoint: string,
  params: Record<string, string>,
  apiKey: string
): Promise<T> {
  const searchParams = new URLSearchParams({ ...params, key: apiKey });
  const response = await fetch(`${YOUTUBE_API_BASE}/${endpoint}?${searchParams.toString()}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });

  const payload = (await response.json()) as {
    error?: { code?: number; message?: string };
  };

  if (!response.ok) {
    const upstreamCode = payload.error?.code ?? response.status;

    if (upstreamCode === 404) {
      throw { status: 404, message: "Playlist not found" } satisfies ApiError;
    }

    if (upstreamCode === 403) {
      throw { status: 502, message: "YouTube API request rejected" } satisfies ApiError;
    }

    if (upstreamCode === 429) {
      throw { status: 429, message: "YouTube API rate limit exceeded" } satisfies ApiError;
    }

    throw { status: 502, message: "YouTube API request failed" } satisfies ApiError;
  }

  return payload as T;
}

async function fetchVideoDetails(
  videoIds: string[],
  apiKey: string
): Promise<
  Map<
    string,
    {
      duration: number;
      viewCount?: number;
      likeCount?: number;
      description?: string;
      tags?: string[];
      categoryId?: string;
      publishedAt?: string;
    }
  >
> {
  if (videoIds.length === 0) return new Map();

  const response = await fetchYouTubeJson<{
    items?: Array<{
      id?: string;
      snippet?: {
        description?: string;
        tags?: string[];
        categoryId?: string;
        publishedAt?: string;
      };
      contentDetails?: { duration?: string };
      statistics?: { viewCount?: string; likeCount?: string };
    }>;
  }>(
    "videos",
    {
      part: "snippet,contentDetails,statistics",
      id: videoIds.join(","),
    },
    apiKey
  );

  const details = new Map<
    string,
    {
      duration: number;
      viewCount?: number;
      likeCount?: number;
      description?: string;
      tags?: string[];
      categoryId?: string;
      publishedAt?: string;
    }
  >();

  for (const item of response.items ?? []) {
    const id = item.id;
    if (!id) continue;

    details.set(id, {
      duration: item.contentDetails?.duration ? parseIsoDuration(item.contentDetails.duration) : 0,
      viewCount: item.statistics?.viewCount
        ? Number.parseInt(item.statistics.viewCount, 10)
        : undefined,
      likeCount: item.statistics?.likeCount
        ? Number.parseInt(item.statistics.likeCount, 10)
        : undefined,
      description: item.snippet?.description,
      tags: item.snippet?.tags,
      categoryId: item.snippet?.categoryId,
      publishedAt: item.snippet?.publishedAt,
    });
  }

  return details;
}

async function fetchPlaylistData(playlistId: string, apiKey: string): Promise<YouTubePlaylistData> {
  const playlistResponse = await fetchYouTubeJson<{
    items?: Array<{
      snippet?: {
        title?: string;
        description?: string;
        channelTitle?: string;
        thumbnails?: { high?: { url?: string }; default?: { url?: string } };
      };
      contentDetails?: { itemCount?: number };
    }>;
  }>(
    "playlists",
    {
      part: "snippet,contentDetails",
      id: playlistId,
      maxResults: "1",
    },
    apiKey
  );

  const playlist = playlistResponse.items?.[0];
  if (!playlist) {
    throw { status: 404, message: "Playlist not found" } satisfies ApiError;
  }

  const videos: YouTubeVideoData[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;

  do {
    if (pageCount >= MAX_PLAYLIST_PAGES) {
      throw {
        status: 422,
        message: "Playlist exceeds supported import size",
      } satisfies ApiError;
    }

    const pageResponse = await fetchYouTubeJson<{
      nextPageToken?: string;
      items?: Array<{
        snippet?: {
          title?: string;
          videoOwnerChannelTitle?: string;
          thumbnails?: { high?: { url?: string }; default?: { url?: string } };
        };
        contentDetails?: { videoId?: string };
      }>;
    }>(
      "playlistItems",
      {
        part: "snippet,contentDetails",
        playlistId,
        maxResults: String(MAX_RESULTS_PER_PAGE),
        ...(pageToken ? { pageToken } : {}),
      },
      apiKey
    );

    for (const item of pageResponse.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      const title = item.snippet?.title ?? "Untitled";

      if (!videoId || title === "Deleted video" || title === "Private video") {
        continue;
      }

      videos.push({
        id: videoId,
        title,
        channelTitle: item.snippet?.videoOwnerChannelTitle ?? "Unknown",
        thumbnail: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.default?.url ?? "",
        duration: 0,
        position: videos.length,
      });
    }

    pageToken = pageResponse.nextPageToken;
    pageCount += 1;
  } while (pageToken);

  for (let i = 0; i < videos.length; i += MAX_RESULTS_PER_PAGE) {
    const batch = videos.slice(i, i + MAX_RESULTS_PER_PAGE);
    const details = await fetchVideoDetails(
      batch.map((video) => video.id),
      apiKey
    );

    for (const video of batch) {
      const detail = details.get(video.id);
      if (!detail) continue;

      video.duration = detail.duration;
      video.viewCount = detail.viewCount;
      video.likeCount = detail.likeCount;
      video.description = detail.description;
      video.tags = detail.tags;
      video.categoryId = detail.categoryId;
      video.publishedAt = detail.publishedAt;
    }
  }

  return {
    id: playlistId,
    title: playlist.snippet?.title ?? "Untitled Playlist",
    description: playlist.snippet?.description ?? null,
    thumbnail: playlist.snippet?.thumbnails?.high?.url ?? playlist.snippet?.thumbnails?.default?.url ?? null,
    channelTitle: playlist.snippet?.channelTitle ?? null,
    videoCount: playlist.contentDetails?.itemCount ?? videos.length,
    videos,
  };
}

export async function GET(request: Request) {
  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return jsonError(500, "Server configuration error");
    }

    const playlistId = getPlaylistId(request);
    const data = await fetchPlaylistData(playlistId, apiKey);
    return NextResponse.json(data, { status: 200 });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      "message" in error
    ) {
      const { status, message } = error as ApiError;
      return jsonError(status, message);
    }

    return jsonError(500, "Unexpected server error");
  }
}
