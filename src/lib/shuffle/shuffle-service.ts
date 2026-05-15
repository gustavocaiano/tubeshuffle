import type { ShufflePreset } from "@/types/playlist";

export interface ShuffleVideoItem {
  id: string;
  title: string;
  channelTitle: string;
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

/**
 * Smart shuffle — avoid same artist/channel back-to-back.
 */
export function smartShuffle<T extends ShuffleVideoItem>(videos: T[]): T[] {
  const shuffled = fisherYatesShuffle(videos);

  const extractArtist = (title: string) => {
    const dashSplit = title.split("-");
    if (dashSplit.length >= 2) return dashSplit[0].trim().toLowerCase();
    return title.toLowerCase();
  };

  for (let i = 0; i < shuffled.length - 1; i++) {
    const currentArtist = extractArtist(shuffled[i].title);
    const nextArtist = extractArtist(shuffled[i + 1].title);

    if (currentArtist === nextArtist && i + 2 < shuffled.length) {
      for (let j = i + 2; j < shuffled.length; j++) {
        const candidateArtist = extractArtist(shuffled[j].title);
        if (candidateArtist !== currentArtist) {
          [shuffled[i + 1], shuffled[j]] = [shuffled[j], shuffled[i + 1]];
          break;
        }
      }
    }
  }

  for (let i = 0; i < shuffled.length - 1; i++) {
    if (
      shuffled[i].channelTitle === shuffled[i + 1].channelTitle &&
      i + 2 < shuffled.length
    ) {
      for (let j = i + 2; j < shuffled.length; j++) {
        if (shuffled[j].channelTitle !== shuffled[i].channelTitle) {
          [shuffled[i + 1], shuffled[j]] = [shuffled[j], shuffled[i + 1]];
          break;
        }
      }
    }
  }

  return shuffled;
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
