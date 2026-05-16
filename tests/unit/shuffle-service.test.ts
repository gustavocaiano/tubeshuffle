import { describe, it, expect } from "vitest";
import {
  randomShuffle,
  smartShuffle,
  shuffleVideos,
  type ShuffleVideoItem,
} from "@/lib/shuffle/shuffle-service";
import { classifyEnergyTrack } from "@/lib/shuffle/energy-classifier";

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
    it("should order by inferred energy while preserving all videos", () => {
      const videos = [
        createVideo({
          id: "hype-1",
          title: "Phonk Drill Banger",
          channelTitle: "Channel A",
          duration: 150,
        }),
        createVideo({
          id: "chill-1",
          title: "Lo-fi Chill Beats",
          channelTitle: "Channel B",
          duration: 300,
        }),
        createVideo({
          id: "sad-1",
          title: "Heartbreak Slow Version",
          channelTitle: "Channel C",
          duration: 480,
        }),
        createVideo({
          id: "upbeat-1",
          title: "Happy Dance Remix",
          channelTitle: "Channel D",
          duration: 200,
        }),
        createVideo({
          id: "steady-1",
          title: "Official Live Session",
          channelTitle: "Channel E",
          duration: 260,
        }),
      ];

      const shuffled = smartShuffle(videos);
      expect(shuffled).toHaveLength(videos.length);
      expect(new Set(shuffled.map((video) => video.id)).size).toBe(videos.length);

      const buckets = shuffled.map((video) => classifyEnergyTrack(video).bucket);
      expect(buckets).toContain("hype");
      expect(buckets).toContain("upbeat");
      expect(buckets).toContain("steady");
      expect(buckets).toContain("melancholy");
      expect(buckets).toContain("chill");
    });

    it("should not force channel spacing", () => {
      const videos = [
        createVideo({
          id: "same-channel-1",
          title: "Nightcore Burst One",
          channelTitle: "Same Channel",
          duration: 150,
        }),
        createVideo({
          id: "same-channel-2",
          title: "Nightcore Burst Two",
          channelTitle: "Same Channel",
          duration: 155,
        }),
        createVideo({
          id: "same-channel-3",
          title: "Nightcore Burst Three",
          channelTitle: "Same Channel",
          duration: 160,
        }),
      ];

      const shuffled = smartShuffle(videos);
      expect(shuffled.map((video) => video.channelTitle)).toEqual([
        "Same Channel",
        "Same Channel",
        "Same Channel",
      ]);
    });
  });

  describe("energy classifier", () => {
    it("should classify obvious energy cues deterministically", () => {
      expect(
        classifyEnergyTrack({
          title: "Lo-fi Chill Beats to Study/Relax To",
          channelTitle: "Study Channel",
          duration: 360,
        }).bucket
      ).toBe("chill");

      expect(
        classifyEnergyTrack({
          title: "Heartbreak Slow Version",
          channelTitle: "Acoustic Channel",
          duration: 480,
        }).bucket
      ).toBe("melancholy");

      expect(
        classifyEnergyTrack({
          title: "Phonk Drill Banger",
          channelTitle: "Dance Channel",
          duration: 150,
        }).bucket
      ).toBe("hype");
    });

    it("should fall back to unknown for weak signals", () => {
      const profile = classifyEnergyTrack({
        title: "Track 01",
        channelTitle: "Uploader",
        categoryId: "10",
      });

      expect(profile.bucket).toBe("unknown");
      expect(profile.confidence).toBeGreaterThanOrEqual(0);
      expect(profile.signals).toContain("category:10");
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
