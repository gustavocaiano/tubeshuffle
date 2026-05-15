import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiPreferencesState {
  hideThumbnails: boolean;
  focusMode: boolean;
  setHideThumbnails: (value: boolean) => void;
  setFocusMode: (value: boolean) => void;
  toggleHideThumbnails: () => void;
  toggleFocusMode: () => void;
}

export const useUiPreferencesStore = create<UiPreferencesState>()(
  persist(
    (set) => ({
      hideThumbnails: false,
      focusMode: false,
      setHideThumbnails: (value) => set({ hideThumbnails: value }),
      setFocusMode: (value) => set({ focusMode: value }),
      toggleHideThumbnails: () =>
        set((state) => ({ hideThumbnails: !state.hideThumbnails })),
      toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
    }),
    {
      name: "ui-preferences",
    }
  )
);
