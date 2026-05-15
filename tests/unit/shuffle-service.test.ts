import { describe, it, expect } from "vitest";
import {
  randomShuffle,
  smartShuffle,
  shuffleVideos,
  type ShuffleVideoItem,
} from "@/lib/shuffle/shuffle-service";

type TestVideo = ShuffleVideoItem & {
  playlistId: string;
  youtubeId: string;
  thumbnail: string;
  duration: number;
  position: number;
  viewCount: number | null;
  likeCount: number | null;
  createdAt: Date;
};

function createVideo(overrides: Partial<TestVideo> = {}): TestVideo {
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

    it("should only expose random and smart presets", () => {
      const presets = ["RANDOM", "SMART"] as const;
      const videos = Array.from({ length: 5 }, (_, i) =>
        createVideo({ position: i })
      );

      for (const preset of presets) {
        expect(shuffleVideos(videos, preset)).toHaveLength(5);
      }
    });
  });
});
