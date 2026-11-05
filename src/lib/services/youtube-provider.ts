import { fetchPlaylistDataFromProxy } from "@/lib/services/youtube-proxy";
import type { YouTubePlaylistData } from "@/types/playlist";

export type YouTubeApiMode = "browser" | "proxy";

export async function fetchPlaylistData(
  playlistId: string
): Promise<YouTubePlaylistData> {
  return fetchPlaylistDataFromProxy(playlistId);
}
