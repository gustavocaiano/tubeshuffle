import { describe, it, expect } from "vitest";
import {
  randomShuffle,
  smartShuffle,
  discoveryShuffle,
  shuffleVideos,
} from "@/server/services/shuffle-service";
import type { Video, PlayHistory } from "@prisma/client";

function createVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: `video-${Math.random().toString(36).slice(2, 9)}`,
    playlistId: "playlist-1",
    youtubeId: `yt-${Math.random().toString(36).slice(2, 9)}`,
    title: "Test Video",
    channelTitle: "Test Channel",
    thumbnail: "https://example.com/thumb.jpg",
    duration: 240,
    position: 0,
    viewCount: null,
    likeCount: null,
    createdAt: new Date(),
    ...overrides,
  };
}

function createPlayHistory(
  videoId: string,
  count: number
): PlayHistory[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ph-${i}-${Math.random().toString(36).slice(2, 9)}`,
    userId: "user-1",
    playlistId: "playlist-1",
    videoId,
    watchedAt: new Date(),
    watchedSeconds: 240,
    completed: true,
  }));
}

describe("Shuffle Service", () => {
  describe("randomShuffle", () => {
    it("should return all videos", () => {
      const videos = Array.from({ length: 20 }, (_, i) =>
        createVideo({ position: i })
      );
      const shuffled = randomShuffle(videos);
      expect(shuffled).toHaveLength(20);
    });

    it("should contain the same videos (no duplicates)", () => {
      const videos = Array.from({ length: 50 }, (_, i) =>
        createVideo({ id: `v-${i}`, position: i })
      );
      const shuffled = randomShuffle(videos);
      const ids = shuffled.map((v) => v.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(50);
    });

    it("should produce different orderings (probabilistic)", () => {
      const videos = Array.from({ length: 100 }, (_, i) =>
        createVideo({ id: `v-${i}`, position: i })
      );
      const shuffled1 = randomShuffle(videos);
      const shuffled2 = randomShuffle(videos);

      // Very unlikely both are identical for 100 items
      const ids1 = shuffled1.map((v) => v.id).join(",");
      const ids2 = shuffled2.map((v) => v.id).join(",");
      expect(ids1).not.toBe(ids2);
    });

    it("should handle empty array", () => {
      const shuffled = randomShuffle([]);
      expect(shuffled).toEqual([]);
    });

    it("should handle single item", () => {
      const video = createVideo();
      const shuffled = randomShuffle([video]);
      expect(shuffled).toEqual([video]);
    });
  });

  describe("smartShuffle", () => {
    it("should avoid same channel back-to-back when possible", () => {
      const videos = [
        createVideo({ title: "Artist A - Song 1", channelTitle: "Channel A" }),
        createVideo({ title: "Artist A - Song 2", channelTitle: "Channel A" }),
        createVideo({ title: "Artist B - Song 1", channelTitle: "Channel B" }),
        createVideo({ title: "Artist B - Song 2", channelTitle: "Channel B" }),
        createVideo({ title: "Artist C - Song 1", channelTitle: "Channel C" }),
        createVideo({ title: "Artist C - Song 2", channelTitle: "Channel C" }),
      ];

      // Run multiple times and check that smart shuffle attempts separation
      let betterThanRandom = 0;
      for (let i = 0; i < 20; i++) {
        const shuffled = smartShuffle(videos);
        let consecutiveSameChannel = 0;
        for (let j = 0; j < shuffled.length - 1; j++) {
          if (shuffled[j].channelTitle === shuffled[j + 1].channelTitle) {
            consecutiveSameChannel++;
          }
        }
        // Smart shuffle should generally have fewer consecutive same-channel pairs
        if (consecutiveSameChannel <= 1) betterThanRandom++;
      }
      // At least some runs should successfully separate channels
      expect(betterThanRandom).toBeGreaterThan(0);
    });
  });

  describe("discoveryShuffle", () => {
    it("should prioritize less-played videos", () => {
      const lessPlayed = createVideo({ id: "less-played", title: "Rare" });
      const morePlayed = createVideo({ id: "more-played", title: "Popular" });
      const videos = [lessPlayed, morePlayed];

      const history = [
        ...createPlayHistory("more-played", 10),
        ...createPlayHistory("less-played", 1),
      ];

      // Run many times and check that less-played appears first more often
      let lessPlayedFirst = 0;
      for (let i = 0; i < 100; i++) {
        const shuffled = discoveryShuffle(videos, history);
        if (shuffled[0].id === "less-played") lessPlayedFirst++;
      }

      // Less-played should be first more than 50% of the time
      expect(lessPlayedFirst).toBeGreaterThan(50);
    });
  });

  describe("shuffleVideos dispatcher", () => {
    it("should dispatch to randomShuffle for RANDOM preset", () => {
      const videos = Array.from({ length: 10 }, (_, i) =>
        createVideo({ position: i })
      );
      const shuffled = shuffleVideos(videos, "RANDOM");
      expect(shuffled).toHaveLength(10);
    });

    it("should dispatch to smartShuffle for SMART preset", () => {
      const videos = Array.from({ length: 10 }, (_, i) =>
        createVideo({ position: i })
      );
      const shuffled = shuffleVideos(videos, "SMART");
      expect(shuffled).toHaveLength(10);
    });

    it("should dispatch to discoveryShuffle for DISCOVERY preset", () => {
      const videos = Array.from({ length: 10 }, (_, i) =>
        createVideo({ position: i })
      );
      const shuffled = shuffleVideos(videos, "DISCOVERY", []);
      expect(shuffled).toHaveLength(10);
    });
  });
});
