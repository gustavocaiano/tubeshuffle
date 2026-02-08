import { create } from "zustand";

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
