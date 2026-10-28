import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyEnergyTrack } from "@/lib/shuffle/energy-classifier";
import { randomShuffle, smartShuffle } from "@/lib/shuffle/shuffle-service";
import vectors from "../../shared/fixtures/smart.json";

afterEach(() => vi.restoreAllMocks());

describe("shuffle-v1 portable corpus against TypeScript", () => {
  it.each(vectors.classifierV1)("classifies $input.title", ({ input, expected }) => {
    const result = classifyEnergyTrack(input);
    expect(result.bucket).toBe(expected.bucket);
    expect(result.score).toBe(expected.score);
    expect(result.signals).toEqual(expected.signals);
    expect(result.confidence).toBeCloseTo(expected.confidence, 12);
  });

  it.each(vectors.v1)("$name consumes exactly the prescribed draws", ({ mode, tracks, draws, expectedOccurrences }) => {
    let cursor = 0;
    const random = vi.spyOn(Math, "random").mockImplementation(() => {
      if (cursor >= draws.length) throw new Error("random vector exhausted");
      return draws[cursor++];
    });
    const input = tracks.map((track, occurrence) => ({ ...track, occurrence }));
    const before = structuredClone(input);
    const result = mode === "normal" ? randomShuffle(input) : smartShuffle(input);
    expect(result.map((item) => item.occurrence)).toEqual(expectedOccurrences);
    expect(random).toHaveBeenCalledTimes(draws.length);
    expect(cursor).toBe(draws.length);
    expect(input).toEqual(before);
    expect(result).not.toBe(input);
    expect(result.every((item) => item === input[item.occurrence])).toBe(true);
  });
});
