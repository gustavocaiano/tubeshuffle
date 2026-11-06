import { create } from "zustand";
import { browserStorage, getBrowserStorageState } from "@/lib/storage";
import { fetchPlaylistData } from "@/lib/services/youtube-provider";
import { extractPlaylistId } from "@/lib/utils";
import type { LocalPlayEventInput, LocalPlaylist, LocalVideo } from "@/types/playlist";

export interface LocalPlaylistBundle {
  playlist: LocalPlaylist;
  videos: LocalVideo[];
}

async function upsertPlaylistFromYouTubeId(playlistYoutubeId: string): Promise<LocalPlaylistBundle> {
  const generation = getBrowserStorageState().generation;
  const playlists = await browserStorage.listPlaylists();
  if (playlists.some((playlist) => playlist.youtubeId === playlistYoutubeId)) {
    throw new Error("Syncing or reimporting an existing playlist is temporarily blocked to protect your watch history. Keep your library unchanged and retry when safe sync is available.");
  }
  const data = await fetchPlaylistData(playlistYoutubeId);
  const now = new Date().toISOString();
  const playlistId = crypto.randomUUID();

  const playlist: LocalPlaylist = {
    id: playlistId,
    youtubeId: data.id,
    title: data.title,
    description: data.description,
    thumbnail: data.thumbnail,
    channelTitle: data.channelTitle,
    videoCount: data.videos.length,
    createdAt: now,
    updatedAt: now,
  };

  const videos: LocalVideo[] = data.videos.map((video, index) => ({
    id: crypto.randomUUID(),
    playlistId,
    youtubeId: video.id,
    title: video.title,
    channelTitle: video.channelTitle,
    thumbnail: video.thumbnail,
    duration: video.duration,
    position: index,
    viewCount: video.viewCount,
    likeCount: video.likeCount,
    description: video.description,
    tags: video.tags,
    categoryId: video.categoryId,
    publishedAt: video.publishedAt,
  }));

  await browserStorage.savePlaylist({ playlist, videos }, generation);
  return { playlist, videos };
}

export const playlistRepository = {
  async listPlaylists(): Promise<LocalPlaylist[]> {
    const playlists = await browserStorage.listPlaylists();
    return playlists.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  },

  async getPlaylist(id: string): Promise<LocalPlaylistBundle | null> {
    return browserStorage.getPlaylist(id);
  },

  async importPlaylistFromUrl(url: string): Promise<LocalPlaylistBundle> {
    const playlistId = extractPlaylistId(url);
    if (!playlistId) {
      throw new Error(
        "Invalid YouTube playlist URL. Please paste a valid YouTube playlist link."
      );
    }

    return upsertPlaylistFromYouTubeId(playlistId);
  },

  async syncPlaylist(_id: string): Promise<LocalPlaylistBundle> {
    throw new Error("Syncing or reimporting an existing playlist is temporarily blocked to protect your watch history. Keep your library unchanged and retry when safe sync is available.");
  },

  async deletePlaylist(id: string): Promise<void> {
    await browserStorage.deletePlaylist(id);
  },

  async recordPlay(input: LocalPlayEventInput, generation?: number): Promise<void> {
    await browserStorage.recordPlayEvent(input, generation);
  },

  async getCompletedVideoIds(playlistId: string): Promise<Set<string>> {
    return browserStorage.getCompletedVideoIds(playlistId);
  },
};

interface PlaylistStoreState {
  importModalOpen: boolean;
  setImportModalOpen: (open: boolean) => void;
  selectedPlaylistId: string | null;
  setSelectedPlaylistId: (id: string | null) => void;
}

export const usePlaylistStore = create<PlaylistStoreState>()((set) => ({
  importModalOpen: false,
  setImportModalOpen: (open) => set({ importModalOpen: open }),
  selectedPlaylistId: null,
  setSelectedPlaylistId: (id) => set({ selectedPlaylistId: id }),
}));
