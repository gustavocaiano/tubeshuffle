import { describe, expect, it } from "vitest";
import fixture from "../../shared/fixtures/transfer-v1.json";

type Data = { playlists: { id: string; youtubeId: string }[]; videos: { id: string; playlistId: string; position: number; youtubeId: string }[]; history: { id: string; playlistId: string; videoId: string }[] };

function assertRelations(data: Data) {
  const playlists = new Map(data.playlists.map((p) => [p.id, p]));
  const videos = new Map(data.videos.map((v) => [v.id, v]));
  expect(playlists.size).toBe(data.playlists.length);
  expect(new Set(data.playlists.map((p) => p.youtubeId)).size).toBe(data.playlists.length);
  expect(videos.size).toBe(data.videos.length);
  expect(new Set(data.videos.map((v) => JSON.stringify([v.playlistId, v.position]))).size).toBe(data.videos.length);
  for (const video of data.videos) expect(playlists.has(video.playlistId)).toBe(true);
  expect(new Set(data.history.map((h) => h.id)).size).toBe(data.history.length);
  for (const event of data.history) {
    expect(playlists.has(event.playlistId)).toBe(true);
    expect(videos.get(event.videoId)?.playlistId).toBe(event.playlistId);
  }
}

describe("portable transfer specification vectors (not an importer)", () => {
  it.each(fixture.vectors.merge)("has consistent explicit outcome: $name", (vector) => {
    const { source, destination, expected } = vector;
    expect(source.format).toBe("tubeshuffle-transfer");
    expect(source.version).toBe(1);
    assertRelations(destination);
    assertRelations(expected.destination);
    if (expected.status === "rejected") {
      expect(expected).toHaveProperty("code");
      expect(expected.destination).toEqual("transactionStartDestination" in vector ? vector.transactionStartDestination : destination);
    } else {
      expect(expected).toHaveProperty("report");
      const report = "report" in expected ? expected.report : undefined;
      expect(report).toBeDefined();
      if (!report) return;
      for (const kind of ["playlists", "videos", "history"] as const) {
        expect(expected.destination[kind].length - destination[kind].length).toBe(report.created[kind]);
        expect(report.created[kind] + report.identical[kind]).toBeLessThanOrEqual(source[kind].length);
      }
    }
  });

  it("specifies repeated imports as no-ops and retains distinct occurrences", () => {
    const vectors = fixture.vectors.merge;
    const first = vectors.find((v) => v.name === "matched playlist maps IDs and adds occurrence and history")!;
    const repeat = vectors.find((v) => v.name === "repeat mapped import")!;
    expect(repeat.destination).toEqual(first.expected.destination);
    expect(repeat.expected.destination).toEqual(repeat.destination);
    expect(repeat.expected).toMatchObject({ report: { created: { playlists: 0, videos: 0, history: 0 }, identical: { playlists: 1, videos: 2, history: 1 } } });
    expect(repeat.destination.videos.map((v) => v.id)).toEqual(["v1", "v2"]);
    expect(repeat.destination.videos[0].youtubeId).toBe(repeat.destination.videos[1].youtubeId);
    expect(repeat.destination.history[0]).toMatchObject({ playlistId: "dst", videoId: "v2" });
  });

  it("explicitly covers collision, orphan, transactional and validation failures", () => {
    const names = fixture.vectors.merge.map((v) => v.name);
    for (const name of ["source orphans cannot attach to destination", "cross playlist source history omitted", "playlist ID collision with other destination despite youtube match", "video ID collision prevents unsafe history attachment", "position collision retains destination", "transaction failure rolls back", "concurrent change invalidates preview"]) expect(names).toContain(name);
    const orphan = fixture.vectors.merge.find((v) => v.name === "source orphans cannot attach to destination")!;
    expect(orphan.expected).toMatchObject({ report: { omittedOrphans: [{ id: "missing-playlist", reason: "missing_playlist" }, { id: "missing-video", reason: "missing_video" }, { id: "cross", reason: "missing_video" }] } });
    expect(fixture.vectors.validation.map((v) => v.expected)).toEqual(expect.arrayContaining(["duplicate_key", "unsupported_version", "duplicate_playlist_youtube_id", "invalid_field", "invalid_video_reference", "file_too_large", "valid"]));
    expect(fixture.vectors.legacyExport).toEqual(expect.arrayContaining([expect.objectContaining({ name: "large view count and fractional normalization", expected: { viewCount: 12500000000, publishedAt: "2020-02-29T12:34:56.000Z" } })]));
  });

  it.each(fixture.vectors.independentOccurrences)("documents independent occurrence handling: $name", (vector) => {
    assertRelations(vector.destination);
    assertRelations(vector.expected.destination);
    for (const pair of vector.confirmedPairs) {
      const src = vector.source.videos.find((v) => v.id === pair.sourceVideoId)!;
      const dst = vector.destination.videos.find((v) => v.id === pair.destinationVideoId)!;
      expect(src.youtubeId).toBe(dst.youtubeId);
      expect(vector.expected.videoMapping).toHaveProperty(src.id, dst.id);
      expect(vector.expected.destination.history[0].videoId).toBe(dst.id);
    }
    if (!vector.confirmedPairs.length) {
      expect(vector.expected.destination).toEqual(vector.destination);
      expect(vector.expected.conflicts).toContainEqual(expect.objectContaining({ kind: "history", reason: "unmapped_video" }));
    }
    if ("repeatNoWrites" in vector.expected) expect(vector.expected.destination).toEqual(vector.destination);
  });

  it.each(fixture.vectors.equalLegacyOccurrences)("requires evidence for equal legacy IDs: $name", (vector) => {
    assertRelations(vector.source);
    assertRelations(vector.destination);
    assertRelations(vector.expected.destination);
    const sourceVideo = vector.source.videos[0];
    const destinationVideo = vector.destination.videos[0];
    expect(sourceVideo.id).toBe(destinationVideo.id);
    expect(sourceVideo.youtubeId).toBe(destinationVideo.youtubeId);
    expect(vector.trustedProvenance).toBeNull();
    expect(vector.source.history[0].id).not.toBe(vector.destination.history[0].id);
    if (vector.confirmedPairs.length === 0) {
      expect(vector.expected.videoMapping).toEqual({});
      expect(vector.expected.destination).toEqual(vector.destination);
      expect(vector.expected.conflicts).toEqual([
        { kind: "video", id: sourceVideo.id, reason: "ambiguous_occurrence" },
        { kind: "history", id: vector.source.history[0].id, reason: "unmapped_video" },
      ]);
      expect(vector.expected.destination.history.some((h) => h.id === vector.source.history[0].id)).toBe(false);
    } else {
      expect(vector.confirmedPairs[0]).toMatchObject({ sourceVideoId: sourceVideo.id, destinationVideoId: destinationVideo.id });
      expect(vector.confirmedPairs[0].externalEvidence).toBeTruthy();
      expect(vector.expected.videoMapping).toHaveProperty(sourceVideo.id, destinationVideo.id);
      expect(vector.expected.destination.history).toContainEqual(vector.source.history[0]);
    }
  });

  it("keeps unresolved repeat and cross-device imports non-destructive", () => {
    const [first, repeat, crossDevice] = fixture.vectors.equalLegacyOccurrences;
    expect(repeat.source).toEqual(first.source);
    expect(repeat.destination).toEqual(first.expected.destination);
    expect(repeat.expected.destination).toEqual(first.destination);
    expect(crossDevice.expected.videoMapping).toEqual({});
    expect(crossDevice.expected.destination).toEqual(crossDevice.destination);
  });

  it("requires the refresh gate for every destructive entry point", () => {
    expect(fixture.vectors.refreshGateRoutes).toEqual(expect.arrayContaining([
      "syncPlaylist", "import existing YouTube playlist", "re-import existing YouTube playlist", "shared destructive upsert",
    ]));
  });

  it.each(fixture.vectors.syncIntegration)("specifies refresh and export safety: $name", (vector) => {
    assertRelations(vector.beforeImport);
    assertRelations(vector.afterImport);
    expect(vector.importExpected.destination).toEqual(vector.afterImport);
    expect(vector.importSource.history.map((h) => h.videoId)).toEqual(vector.afterImport.history.map((h) => h.videoId));
    assertRelations(vector.expected.afterRefresh);
    assertRelations(vector.expected.export);
    expect(vector.expected.afterRefresh).toEqual(vector.afterImport);
    expect(vector.expected.export).toEqual(vector.afterImport);
    expect(vector.expected.watchedOccurrenceIds).toEqual(vector.afterImport.history.map((h) => h.videoId));
    expect(new Set(vector.expected.watchedOccurrenceIds).size).toBe(2);
  });

  it("maps an IndexedDB-shaped snapshot's own undefined optionals before validation", () => {
    const snapshot = {
      ...fixture.videos[0], viewCount: 12500000000, likeCount: undefined,
      description: "kept", categoryId: undefined, tags: ["music"], publishedAt: undefined,
    };
    expect(Object.hasOwn(snapshot, "likeCount")).toBe(true);
    const optionals = ["viewCount", "likeCount", "description", "categoryId", "tags", "publishedAt"];
    // Illustrative mapping only, not a production exporter or full schema validator.
    const candidate = (record: Record<string, unknown>) => Object.fromEntries(
      Object.entries(record).filter(([key, value]) => !(optionals.includes(key) && value === undefined)),
    );
    const validateLikeCount = (record: Record<string, unknown>) => !Object.hasOwn(record, "likeCount") ||
      (typeof record.likeCount === "number" && Number.isSafeInteger(record.likeCount) && record.likeCount >= 0);
    const wire = candidate(snapshot);
    expect(wire).toEqual({ ...fixture.videos[0], viewCount: 12500000000, description: "kept", tags: ["music"] });
    expect(validateLikeCount(wire)).toBe(true);
    expect(validateLikeCount(candidate({ ...snapshot, likeCount: null }))).toBe(false);
    expect(validateLikeCount(candidate({ ...snapshot, likeCount: "12" }))).toBe(false);
    expect(Object.hasOwn(snapshot, "likeCount")).toBe(true);
  });
});
