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

export interface LocalPlaylist {
  id: string;
  youtubeId: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  channelTitle: string | null;
  videoCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface LocalVideo {
  id: string;
  playlistId: string;
  youtubeId: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  duration: number;
  position: number;
  viewCount?: number;
  likeCount?: number;
}

export interface LocalPlayEvent {
  id: string;
  playlistId: string;
  videoId: string;
  watchedAt: string;
  watchedSeconds: number;
  completed: boolean;
}

export type LocalPlayEventInput = Omit<LocalPlayEvent, "id" | "watchedAt"> & {
  id?: string;
  watchedAt?: string;
};

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
