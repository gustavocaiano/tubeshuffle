import { db } from "@/lib/db";
import { invalidateCache } from "@/lib/redis";
import { fetchPlaylistData } from "./youtube-service";
import type { Playlist, Video } from "@prisma/client";

/**
 * Import a YouTube playlist: fetch data from YouTube API + save to DB.
 */
export async function importPlaylist(
  userId: string,
  youtubePlaylistId: string
): Promise<Playlist & { videos: Video[] }> {
  // Check if already imported
  const existing = await db.playlist.findUnique({
    where: {
      userId_youtubeId: {
        userId,
        youtubeId: youtubePlaylistId,
      },
    },
    include: { videos: true },
  });

  if (existing) {
    return existing;
  }

  // Fetch from YouTube
  const playlistData = await fetchPlaylistData(youtubePlaylistId);

  // Save to database
  const playlist = await db.playlist.create({
    data: {
      userId,
      youtubeId: youtubePlaylistId,
      title: playlistData.title,
      description: playlistData.description,
      thumbnail: playlistData.thumbnail,
      channelTitle: playlistData.channelTitle,
      videoCount: playlistData.videos.length,
      videos: {
        create: playlistData.videos.map((v, idx) => ({
          youtubeId: v.id,
          title: v.title,
          channelTitle: v.channelTitle,
          thumbnail: v.thumbnail,
          duration: v.duration,
          position: idx,
          viewCount: v.viewCount ?? null,
          likeCount: v.likeCount ?? null,
        })),
      },
    },
    include: { videos: true },
  });

  return playlist;
}

/**
 * Sync a playlist with fresh YouTube data.
 * Updates videos (adds new, marks removed).
 */
export async function syncPlaylist(playlistId: string): Promise<void> {
  const playlist = await db.playlist.findUnique({
    where: { id: playlistId },
    include: { videos: true },
  });

  if (!playlist) {
    throw new Error("Playlist not found");
  }

  // Invalidate cache to get fresh data
  await invalidateCache(`playlist:${playlist.youtubeId}`);
  await invalidateCache(`playlist:${playlist.youtubeId}:videos`);

  const freshData = await fetchPlaylistData(playlist.youtubeId);

  // Find new videos
  const existingYoutubeIds = new Set(playlist.videos.map((v) => v.youtubeId));
  const freshYoutubeIds = new Set(freshData.videos.map((v) => v.id));

  const newVideos = freshData.videos.filter(
    (v) => !existingYoutubeIds.has(v.id)
  );
  const removedVideos = playlist.videos.filter(
    (v) => !freshYoutubeIds.has(v.youtubeId)
  );

  // Add new videos
  if (newVideos.length > 0) {
    await db.video.createMany({
      data: newVideos.map((v, idx) => ({
        playlistId: playlist.id,
        youtubeId: v.id,
        title: v.title,
        channelTitle: v.channelTitle,
        thumbnail: v.thumbnail,
        duration: v.duration,
        position: playlist.videos.length + idx,
        viewCount: v.viewCount ?? null,
        likeCount: v.likeCount ?? null,
      })),
    });
  }

  // Remove deleted videos
  if (removedVideos.length > 0) {
    await db.video.deleteMany({
      where: {
        id: { in: removedVideos.map((v) => v.id) },
      },
    });
  }

  // Update playlist metadata
  await db.playlist.update({
    where: { id: playlist.id },
    data: {
      title: freshData.title,
      description: freshData.description,
      thumbnail: freshData.thumbnail,
      videoCount: freshData.videos.length,
      lastFetched: new Date(),
    },
  });
}

/**
 * Delete a playlist and all its videos.
 */
export async function deletePlaylist(
  playlistId: string,
  userId: string
): Promise<void> {
  const playlist = await db.playlist.findUnique({
    where: { id: playlistId },
  });

  if (!playlist || playlist.userId !== userId) {
    throw new Error("Playlist not found or access denied");
  }

  await db.playlist.delete({
    where: { id: playlistId },
  });
}
