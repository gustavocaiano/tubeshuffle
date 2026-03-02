import type { ShufflePreset } from "@/types/playlist";

export interface ShuffleVideoItem {
  id: string;
  title: string;
  channelTitle: string;
}

export interface ShufflePlayHistoryItem {
  videoId: string;
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
 * Discovery shuffle — prioritize videos with fewer plays.
 */
export function discoveryShuffle<
  T extends ShuffleVideoItem,
  H extends ShufflePlayHistoryItem,
>(videos: T[], playHistory: H[]): T[] {
  const playCountMap = new Map<string, number>();
  for (const ph of playHistory) {
    playCountMap.set(ph.videoId, (playCountMap.get(ph.videoId) ?? 0) + 1);
  }

  const weighted = videos.map((video) => ({
    video,
    weight: 1 / ((playCountMap.get(video.id) ?? 0) + 1),
  }));

  return weightedShuffle(weighted);
}

/**
 * Weighted random shuffle using cumulative weights.
 */
function weightedShuffle<T>(items: { video: T; weight: number }[]): T[] {
  const result: T[] = [];
  const remaining = [...items];

  while (remaining.length > 0) {
    const totalWeight = remaining.reduce((sum, item) => sum + item.weight, 0);
    let random = Math.random() * totalWeight;

    let selectedIndex = 0;
    for (let i = 0; i < remaining.length; i++) {
      random -= remaining[i].weight;
      if (random <= 0) {
        selectedIndex = i;
        break;
      }
    }

    result.push(remaining[selectedIndex].video);
    remaining.splice(selectedIndex, 1);
  }

  return result;
}

/**
 * Main shuffle dispatcher.
 */
export function shuffleVideos<
  T extends ShuffleVideoItem,
  H extends ShufflePlayHistoryItem,
>(videos: T[], preset: ShufflePreset, playHistory: H[] = []): T[] {
  switch (preset) {
    case "SMART":
      return smartShuffle(videos);
    case "DISCOVERY":
      return discoveryShuffle(videos, playHistory);
    case "ENERGY":
      return smartShuffle(videos);
    case "RANDOM":
    default:
      return randomShuffle(videos);
  }
}
