import { parseIsoDuration } from "@/lib/utils";
import type { YouTubePlaylistData, YouTubeVideoData } from "@/types/playlist";

const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";

function getBrowserApiKey(): string {
  const apiKey = process.env.NEXT_PUBLIC_YOUTUBE_API_KEY;

  if (!apiKey) {
    throw new Error("Missing NEXT_PUBLIC_YOUTUBE_API_KEY for browser YouTube mode");
  }

  return apiKey;
}

async function fetchYouTubeJson<T>(
  endpoint: string,
  params: Record<string, string>
): Promise<T> {
  const apiKey = getBrowserApiKey();
  const searchParams = new URLSearchParams({ ...params, key: apiKey });
  const url = `${YOUTUBE_API_BASE}/${endpoint}?${searchParams.toString()}`;

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
  });

  const payload = (await response.json()) as {
    error?: { message?: string };
  };

  if (!response.ok) {
    const message = payload.error?.message ?? `YouTube API request failed: ${response.status}`;
    throw new Error(message);
  }

  return payload as T;
}

async function fetchVideoDetails(videoIds: string[]): Promise<Map<string, { duration: number; viewCount?: number; likeCount?: number }>> {
  if (videoIds.length === 0) return new Map();

  const response = await fetchYouTubeJson<{
    items?: Array<{
      id?: string;
      contentDetails?: { duration?: string };
      statistics?: { viewCount?: string; likeCount?: string };
    }>;
  }>("videos", {
    part: "contentDetails,statistics",
    id: videoIds.join(","),
  });

  const details = new Map<string, { duration: number; viewCount?: number; likeCount?: number }>();

  for (const item of response.items ?? []) {
    const id = item.id;
    if (!id) continue;

    details.set(id, {
      duration: item.contentDetails?.duration
        ? parseIsoDuration(item.contentDetails.duration)
        : 0,
      viewCount: item.statistics?.viewCount
        ? Number.parseInt(item.statistics.viewCount, 10)
        : undefined,
      likeCount: item.statistics?.likeCount
        ? Number.parseInt(item.statistics.likeCount, 10)
        : undefined,
    });
  }

  return details;
}

export async function fetchPlaylistDataFromBrowser(
  playlistId: string
): Promise<YouTubePlaylistData> {
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
  }>("playlists", {
    part: "snippet,contentDetails",
    id: playlistId,
  });

  const playlist = playlistResponse.items?.[0];

  if (!playlist) {
    throw new Error(`Playlist not found: ${playlistId}`);
  }

  const videos: YouTubeVideoData[] = [];
  let pageToken: string | undefined;

  do {
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
    }>("playlistItems", {
      part: "snippet,contentDetails",
      playlistId,
      maxResults: "50",
      ...(pageToken ? { pageToken } : {}),
    });

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
        thumbnail:
          item.snippet?.thumbnails?.high?.url ??
          item.snippet?.thumbnails?.default?.url ??
          "",
        duration: 0,
        position: videos.length,
      });
    }

    pageToken = pageResponse.nextPageToken;
  } while (pageToken);

  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const details = await fetchVideoDetails(batch.map((video) => video.id));

    for (const video of batch) {
      const detail = details.get(video.id);
      if (!detail) continue;

      video.duration = detail.duration;
      video.viewCount = detail.viewCount;
      video.likeCount = detail.likeCount;
    }
  }

  return {
    id: playlistId,
    title: playlist.snippet?.title ?? "Untitled Playlist",
    description: playlist.snippet?.description ?? null,
    thumbnail:
      playlist.snippet?.thumbnails?.high?.url ??
      playlist.snippet?.thumbnails?.default?.url ??
      null,
    channelTitle: playlist.snippet?.channelTitle ?? null,
    videoCount: playlist.contentDetails?.itemCount ?? videos.length,
    videos,
  };
}
