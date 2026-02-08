export interface YouTubePlaylistData {
  id: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  channelTitle: string | null;
  videoCount: number;
  videos: YouTubeVideoData[];
}

export interface YouTubeVideoData {
  id: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  duration: number; // seconds
  position: number;
  viewCount?: number;
  likeCount?: number;
}

export type ShufflePreset = "RANDOM" | "SMART" | "DISCOVERY" | "ENERGY";

export interface ShuffledVideo {
  id: string;
  youtubeId: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  duration: number;
  position: number;
}
