import { fetchPlaylistDataFromBrowser } from "@/lib/services/youtube-browser";
import { fetchPlaylistDataFromProxy } from "@/lib/services/youtube-proxy";
import type { YouTubePlaylistData } from "@/types/playlist";

export type YouTubeApiMode = "browser" | "proxy";

// Integration reference (Context7): /websites/developers_google_youtube_v3
function getYouTubeApiMode(): YouTubeApiMode {
  const mode = process.env.NEXT_PUBLIC_YOUTUBE_API_MODE ?? "proxy";
  return mode === "browser" ? "browser" : "proxy";
}

export async function fetchPlaylistData(
  playlistId: string
): Promise<YouTubePlaylistData> {
  if (getYouTubeApiMode() === "browser") {
    return fetchPlaylistDataFromBrowser(playlistId);
  }

  return fetchPlaylistDataFromProxy(playlistId);
}
