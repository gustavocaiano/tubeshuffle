import type { YouTubePlaylistData } from "@/types/playlist";

/** The former public-key path must not consume quota outside the server guard. */
export async function fetchPlaylistDataFromBrowser(_playlistId: string): Promise<YouTubePlaylistData> {
  void _playlistId;
  throw new Error("Direct browser YouTube access is disabled");
}
