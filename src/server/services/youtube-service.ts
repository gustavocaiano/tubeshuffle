import { google } from "googleapis";
import { cached } from "@/lib/redis";
import { parseIsoDuration } from "@/lib/utils";
import type { YouTubePlaylistData, YouTubeVideoData } from "@/types/playlist";

const getYouTubeClient = () =>
  google.youtube({
    version: "v3",
    auth: process.env.YOUTUBE_API_KEY,
  });

/**
 * Fetch playlist metadata + all videos with caching.
 */
export async function fetchPlaylistData(
  playlistId: string
): Promise<YouTubePlaylistData> {
  return cached(`playlist:${playlistId}`, 86400, async () => {
    const youtube = getYouTubeClient();

    const playlistRes = await youtube.playlists.list({
      part: ["snippet", "contentDetails"],
      id: [playlistId],
    });

    const playlist = playlistRes.data.items?.[0];
    if (!playlist) {
      throw new Error(`Playlist not found: ${playlistId}`);
    }

    const videos = await fetchAllPlaylistVideos(playlistId);

    return {
      id: playlistId,
      title: playlist.snippet?.title ?? "Untitled Playlist",
      description: playlist.snippet?.description ?? null,
      thumbnail:
        playlist.snippet?.thumbnails?.high?.url ??
        playlist.snippet?.thumbnails?.default?.url ??
        null,
      channelTitle: playlist.snippet?.channelTitle ?? null,
      videoCount:
        playlist.contentDetails?.itemCount ?? videos.length,
      videos,
    };
  });
}

/**
 * Fetch all videos from a playlist, handling pagination.
 */
async function fetchAllPlaylistVideos(
  playlistId: string
): Promise<YouTubeVideoData[]> {
  return cached(`playlist:${playlistId}:videos`, 21600, async () => {
    const youtube = getYouTubeClient();
    const videos: YouTubeVideoData[] = [];
    let pageToken: string | undefined;

    do {
      const response = await youtube.playlistItems.list({
        part: ["snippet", "contentDetails"],
        playlistId,
        maxResults: 50,
        pageToken,
      });

      const items = response.data.items ?? [];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const videoId = item.contentDetails?.videoId;
        if (!videoId) continue;

        // Skip deleted / private videos
        if (
          item.snippet?.title === "Deleted video" ||
          item.snippet?.title === "Private video"
        ) {
          continue;
        }

        videos.push({
          id: videoId,
          title: item.snippet?.title ?? "Untitled",
          channelTitle: item.snippet?.videoOwnerChannelTitle ?? "Unknown",
          thumbnail:
            item.snippet?.thumbnails?.high?.url ??
            item.snippet?.thumbnails?.default?.url ??
            "",
          duration: 0, // Will be filled by fetchVideoDurations
          position: videos.length,
        });
      }

      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    // Fetch durations in batches of 50
    if (videos.length > 0) {
      await fetchVideoDurations(videos);
    }

    return videos;
  });
}

/**
 * Batch-fetch video durations and stats.
 * YouTube allows up to 50 video IDs per request.
 */
async function fetchVideoDurations(
  videos: YouTubeVideoData[]
): Promise<void> {
  const youtube = getYouTubeClient();

  for (let i = 0; i < videos.length; i += 50) {
    const batch = videos.slice(i, i + 50);
    const ids = batch.map((v) => v.id);

    const response = await youtube.videos.list({
      part: ["contentDetails", "statistics"],
      id: ids,
    });

    const items = response.data.items ?? [];
    const detailsMap = new Map(
      items.map((item) => [item.id, item])
    );

    for (const video of batch) {
      const details = detailsMap.get(video.id);
      if (details?.contentDetails?.duration) {
        video.duration = parseIsoDuration(details.contentDetails.duration);
      }
      if (details?.statistics) {
        video.viewCount = parseInt(
          details.statistics.viewCount ?? "0",
          10
        );
        video.likeCount = parseInt(
          details.statistics.likeCount ?? "0",
          10
        );
      }
    }
  }
}
