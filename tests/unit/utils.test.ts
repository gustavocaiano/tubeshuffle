import { describe, it, expect } from "vitest";
import {
  extractPlaylistId,
  formatDuration,
  parseIsoDuration,
  truncate,
} from "@/lib/utils";

describe("extractPlaylistId", () => {
  it("should extract from standard playlist URL", () => {
    expect(
      extractPlaylistId(
        "https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
      )
    ).toBe("PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf");
  });

  it("should extract from URL with additional params", () => {
    expect(
      extractPlaylistId(
        "https://www.youtube.com/watch?v=abc123&list=PLtest123&index=5"
      )
    ).toBe("PLtest123");
  });

  it("should return plain ID as-is", () => {
    expect(extractPlaylistId("PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf")).toBe(
      "PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf"
    );
  });

  it("should return null for invalid input", () => {
    expect(extractPlaylistId("not a url and not an id!")).toBeNull();
  });

  it("should handle mobile YouTube URLs", () => {
    expect(
      extractPlaylistId(
        "https://m.youtube.com/playlist?list=PLmobile123"
      )
    ).toBe("PLmobile123");
  });
});

describe("formatDuration", () => {
  it("should format seconds only", () => {
    expect(formatDuration(45)).toBe("0:45");
  });

  it("should format minutes and seconds", () => {
    expect(formatDuration(185)).toBe("3:05");
  });

  it("should format hours, minutes, and seconds", () => {
    expect(formatDuration(3661)).toBe("1:01:01");
  });

  it("should handle zero", () => {
    expect(formatDuration(0)).toBe("0:00");
  });
});

describe("parseIsoDuration", () => {
  it("should parse hours, minutes, seconds", () => {
    expect(parseIsoDuration("PT1H2M3S")).toBe(3723);
  });

  it("should parse minutes and seconds", () => {
    expect(parseIsoDuration("PT5M30S")).toBe(330);
  });

  it("should parse seconds only", () => {
    expect(parseIsoDuration("PT45S")).toBe(45);
  });

  it("should parse hours only", () => {
    expect(parseIsoDuration("PT2H")).toBe(7200);
  });

  it("should return 0 for invalid format", () => {
    expect(parseIsoDuration("invalid")).toBe(0);
  });
});

describe("truncate", () => {
  it("should not truncate short strings", () => {
    expect(truncate("Hello", 10)).toBe("Hello");
  });

  it("should truncate long strings with ellipsis", () => {
    expect(truncate("Hello, World! This is a long string", 15)).toBe(
      "Hello, World..."
    );
  });

  it("should handle exact length", () => {
    expect(truncate("Hello", 5)).toBe("Hello");
  });
});
