import type { ShufflePreset } from "@/types/playlist";
import { smartEnergyShuffle } from "@/lib/shuffle/energy-flow";

export interface ShuffleVideoItem {
  id: string;
  title: string;
  channelTitle: string;
  description?: string;
  tags?: readonly string[];
  categoryId?: string;
  duration?: number;
}

/**
 * Fisher-Yates shuffle — pure random.
 */
function fisherYatesShuffle<T>(array: T[]): T[] {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Random shuffle — simple Fisher-Yates.
 */
export function randomShuffle<T extends ShuffleVideoItem>(videos: T[]): T[] {
  return fisherYatesShuffle(videos);
}

export function smartShuffle<T extends ShuffleVideoItem>(videos: T[]): T[] {
  return smartEnergyShuffle(videos);
}

/**
 * Main shuffle dispatcher.
 */
export function shuffleVideos<T extends ShuffleVideoItem>(
  videos: T[],
  preset: ShufflePreset
): T[] {
  switch (preset) {
    case "SMART":
      return smartShuffle(videos);
    case "RANDOM":
    default:
      return randomShuffle(videos);
  }
}
