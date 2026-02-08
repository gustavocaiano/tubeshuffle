import { create } from "zustand";
import { persist } from "zustand/middleware";

interface VideoItem {
  id: string;
  youtubeId: string;
  title: string;
  channelTitle: string;
  thumbnail: string;
  duration: number;
}

interface PlayerState {
  // Queue
  queue: VideoItem[];
  currentIndex: number;
  currentVideo: VideoItem | null;

  // Playback
  isPlaying: boolean;
  volume: number;

  // Playlist context
  playlistId: string | null;
  playlistTitle: string | null;

  // Actions
  setQueue: (videos: VideoItem[], playlistId: string, playlistTitle: string) => void;
  playVideo: (index: number) => void;
  playNext: () => void;
  playPrevious: () => void;
  togglePlay: () => void;
  setPlaying: (playing: boolean) => void;
  setVolume: (volume: number) => void;
  clearQueue: () => void;
}

export const usePlayerStore = create<PlayerState>()(
  persist(
    (set, get) => ({
      queue: [],
      currentIndex: -1,
      currentVideo: null,
      isPlaying: false,
      volume: 80,
      playlistId: null,
      playlistTitle: null,

      setQueue: (videos, playlistId, playlistTitle) => {
        set({
          queue: videos,
          playlistId,
          playlistTitle,
          currentIndex: videos.length > 0 ? 0 : -1,
          currentVideo: videos.length > 0 ? videos[0] : null,
          isPlaying: true,
        });
      },

      playVideo: (index) => {
        const { queue } = get();
        if (index >= 0 && index < queue.length) {
          set({
            currentIndex: index,
            currentVideo: queue[index],
            isPlaying: true,
          });
        }
      },

      playNext: () => {
        const { queue, currentIndex } = get();
        const nextIndex = currentIndex + 1;
        if (nextIndex < queue.length) {
          set({
            currentIndex: nextIndex,
            currentVideo: queue[nextIndex],
            isPlaying: true,
          });
        } else {
          // End of queue
          set({ isPlaying: false });
        }
      },

      playPrevious: () => {
        const { queue, currentIndex } = get();
        const prevIndex = currentIndex - 1;
        if (prevIndex >= 0) {
          set({
            currentIndex: prevIndex,
            currentVideo: queue[prevIndex],
            isPlaying: true,
          });
        }
      },

      togglePlay: () => {
        set((state) => ({ isPlaying: !state.isPlaying }));
      },

      setPlaying: (playing) => {
        set({ isPlaying: playing });
      },

      setVolume: (volume) => {
        set({ volume: Math.max(0, Math.min(100, volume)) });
      },

      clearQueue: () => {
        set({
          queue: [],
          currentIndex: -1,
          currentVideo: null,
          isPlaying: false,
          playlistId: null,
          playlistTitle: null,
        });
      },
    }),
    {
      name: "player-state",
      partialize: (state) => ({
        volume: state.volume,
      }),
    }
  )
);
