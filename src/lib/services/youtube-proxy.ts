import type { YouTubePlaylistData } from "@/types/playlist";
import { responseError } from "./account-client";

export async function fetchPlaylistDataFromProxy(
  playlistId: string
): Promise<YouTubePlaylistData> {
  const response = await fetch(
    `/api/youtube/playlist?playlistId=${encodeURIComponent(playlistId)}`,
    {
      method: "GET",
      headers: { Accept: "application/json", "x-tubeshuffle-intent": "playlist" },
    }
  );

  if (!response.ok) throw await responseError(response);
  const payload = (await response.json()) as
    | YouTubePlaylistData
    | { data?: YouTubePlaylistData; error?: string };

  if ("data" in payload && payload.data) {
    return payload.data;
  }

  return payload as YouTubePlaylistData;
}
