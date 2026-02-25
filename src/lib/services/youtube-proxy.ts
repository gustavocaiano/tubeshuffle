import type { YouTubePlaylistData } from "@/types/playlist";

export async function fetchPlaylistDataFromProxy(
  playlistId: string
): Promise<YouTubePlaylistData> {
  const response = await fetch(
    `/api/youtube/playlist?playlistId=${encodeURIComponent(playlistId)}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
    }
  );

  const payload = (await response.json()) as
    | YouTubePlaylistData
    | { data?: YouTubePlaylistData; error?: string };

  if (!response.ok) {
    const message =
      "error" in payload && payload.error
        ? payload.error
        : `YouTube proxy request failed: ${response.status}`;
    throw new Error(message);
  }

  if ("data" in payload && payload.data) {
    return payload.data;
  }

  return payload as YouTubePlaylistData;
}
