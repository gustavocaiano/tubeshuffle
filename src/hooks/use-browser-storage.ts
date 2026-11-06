"use client";

import { useSyncExternalStore } from "react";
import { getBrowserStorageState, getServerStorageState, subscribeBrowserStorage } from "@/lib/storage/browser-session";

export function useBrowserStorage() {
  return useSyncExternalStore(subscribeBrowserStorage, getBrowserStorageState, getServerStorageState);
}

export function isStorageGenerationCurrent(generation: number): boolean {
  const state = getBrowserStorageState();
  return state.phase === "ready" && state.generation === generation;
}
