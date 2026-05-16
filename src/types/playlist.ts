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
  description?: string;
  tags?: string[];
  categoryId?: string;
  publishedAt?: string;
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
  description?: string;
  tags?: string[];
  categoryId?: string;
  publishedAt?: string;
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

export type ShufflePreset = "RANDOM" | "SMART";

export interface ShuffledVideo {
  id: string;
  youtubeId: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  duration: number;
  position: number;
  description?: string;
  tags?: string[];
  categoryId?: string;
  publishedAt?: string;
}

export interface SuggestedVideo {
  id: string;
  youtubeId: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  duration: number;
  url: string;
  reason: string;
  query: string;
  publishedAt?: string;
  viewCount?: number;
}

export interface DailySuggestionsResult {
  playlistId: string;
  generatedAt: string;
  dateKey: string;
  query: string;
  quotaCost: number;
  suggestions: SuggestedVideo[];
}
