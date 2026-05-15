import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiPreferencesState {
  hideThumbnails: boolean;
  focusMode: boolean;
  fullWindowMode: boolean;
  setHideThumbnails: (value: boolean) => void;
  setFocusMode: (value: boolean) => void;
  setFullWindowMode: (value: boolean) => void;
  toggleHideThumbnails: () => void;
  toggleFocusMode: () => void;
  toggleFullWindowMode: () => void;
}

export const useUiPreferencesStore = create<UiPreferencesState>()(
  persist(
    (set) => ({
      hideThumbnails: false,
      focusMode: false,
      fullWindowMode: false,
      setHideThumbnails: (value) => set({ hideThumbnails: value }),
      setFocusMode: (value) => set({ focusMode: value }),
      setFullWindowMode: (value) => set({ fullWindowMode: value }),
      toggleHideThumbnails: () =>
        set((state) => ({ hideThumbnails: !state.hideThumbnails })),
      toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
      toggleFullWindowMode: () =>
        set((state) => ({ fullWindowMode: !state.fullWindowMode })),
    }),
    {
      name: "ui-preferences",
    }
  )
);
