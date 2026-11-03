// Pure queue construction: indices always refer to the filtered occurrence array,
// not to YouTube IDs or positions in the original snapshot.
enum LibraryQueueBuilder {
    enum Mode { case normal, smart }

    /// Each value returned by `draw` must be finite and in [0, 1).
    static func build(snapshot: LibrarySnapshot, playlistId: PlaylistID?, mode: Mode,
                      excludeWatched: Bool, draw: () -> Double) -> [LibraryOccurrence] {
        guard let playlistId = playlistId,
              snapshot.playlists.contains(where: { $0.id == playlistId }) else { return [] }
        let candidates = excludeWatched
            ? snapshot.unwatchedOccurrences(for: playlistId)
            : snapshot.occurrences.filter { $0.playlistId == playlistId }
        let indices: [Int]
        switch mode {
        case .normal:
            indices = ShuffleV1.randomShuffle(count: candidates.count, draw: draw)
        case .smart:
            indices = ShuffleV1.smartShuffle(candidates.map(energyInput), draw: draw)
        }
        // Fail explicitly if the algorithm ever violates its permutation contract.
        precondition(indices.count == candidates.count && Set(indices) == Set(candidates.indices),
                     "Shuffle must return a permutation of candidate indices")
        return indices.map { candidates[$0] }
    }

    static func energyInput(_ occurrence: LibraryOccurrence) -> EnergyTrackInput {
        EnergyTrackInput(title: occurrence.title, channelTitle: occurrence.channelTitle,
                         description: occurrence.description, tags: occurrence.tags,
                         categoryId: occurrence.categoryId, duration: occurrence.duration)
    }
}
