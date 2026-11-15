import Foundation

// Value equality is exact Unicode scalar sequence, not Swift String's
// canonically equivalent comparison. Nil and empty optionals are distinct.
private func scalarEqual(_ lhs: String, _ rhs: String) -> Bool {
    lhs.unicodeScalars.elementsEqual(rhs.unicodeScalars)
}

private func scalarEqual(_ lhs: String?, _ rhs: String?) -> Bool {
    switch (lhs, rhs) {
    case (nil, nil): return true
    case let (lhs?, rhs?): return scalarEqual(lhs, rhs)
    default: return false
    }
}

private func scalarEqual(_ lhs: [String]?, _ rhs: [String]?) -> Bool {
    switch (lhs, rhs) {
    case (nil, nil): return true
    case let (lhs?, rhs?):
        guard lhs.count == rhs.count else { return false }
        return zip(lhs, rhs).allSatisfy { pair in scalarEqual(pair.0, pair.1) }
    default: return false
    }
}

// Opaque IDs compare and hash their exact scalar sequence, not Swift String's
// canonically equivalent comparison. The tag keeps record namespaces distinct.
struct LibraryID<Namespace>: Hashable {
    let rawValue: String

    init(_ rawValue: String) { self.rawValue = rawValue }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue.unicodeScalars.elementsEqual(rhs.rawValue.unicodeScalars)
    }

    func hash(into hasher: inout Hasher) {
        for scalar in rawValue.unicodeScalars { hasher.combine(scalar.value) }
    }
}

enum PlaylistNamespace {}
enum OccurrenceNamespace {}
enum HistoryNamespace {}
typealias PlaylistID = LibraryID<PlaylistNamespace>
typealias OccurrenceID = LibraryID<OccurrenceNamespace>
typealias HistoryID = LibraryID<HistoryNamespace>

struct LibraryPlaylist: Equatable {
    let id: PlaylistID
    let youtubeId: String
    let title: String
    let description: String?
    let thumbnail: String?
    let channelTitle: String?
    let videoCount: Int
    let createdAt: String
    let updatedAt: String

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id
            && scalarEqual(lhs.youtubeId, rhs.youtubeId)
            && scalarEqual(lhs.title, rhs.title)
            && scalarEqual(lhs.description, rhs.description)
            && scalarEqual(lhs.thumbnail, rhs.thumbnail)
            && scalarEqual(lhs.channelTitle, rhs.channelTitle)
            && lhs.videoCount == rhs.videoCount
            && scalarEqual(lhs.createdAt, rhs.createdAt)
            && scalarEqual(lhs.updatedAt, rhs.updatedAt)
    }
}

struct LibraryOccurrence: Equatable {
    let id: OccurrenceID
    let playlistId: PlaylistID
    let youtubeId: String
    let title: String
    let channelTitle: String
    let thumbnail: String
    let duration: Double
    let position: Int
    let viewCount: Int?
    let likeCount: Int?
    let description: String?
    let tags: [String]?
    let categoryId: String?
    let publishedAt: String?

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id
            && lhs.playlistId == rhs.playlistId
            && scalarEqual(lhs.youtubeId, rhs.youtubeId)
            && scalarEqual(lhs.title, rhs.title)
            && scalarEqual(lhs.channelTitle, rhs.channelTitle)
            && scalarEqual(lhs.thumbnail, rhs.thumbnail)
            && lhs.duration == rhs.duration
            && lhs.position == rhs.position
            && lhs.viewCount == rhs.viewCount
            && lhs.likeCount == rhs.likeCount
            && scalarEqual(lhs.description, rhs.description)
            && scalarEqual(lhs.tags, rhs.tags)
            && scalarEqual(lhs.categoryId, rhs.categoryId)
            && scalarEqual(lhs.publishedAt, rhs.publishedAt)
    }
}

struct LibraryHistoryEvent: Equatable {
    let id: HistoryID
    let playlistId: PlaylistID
    // This refers to a local occurrence, never to a YouTube video ID.
    let videoId: OccurrenceID
    let watchedAt: String
    let watchedSeconds: Double
    let completed: Bool

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id
            && lhs.playlistId == rhs.playlistId
            && lhs.videoId == rhs.videoId
            && scalarEqual(lhs.watchedAt, rhs.watchedAt)
            && lhs.watchedSeconds == rhs.watchedSeconds
            && lhs.completed == rhs.completed
    }
}

// A value snapshot is not a transfer payload or a validated persistence model.
// Record value equality is structural only: it is not evidence of occurrence
// lineage or history continuity across refresh, transfer, or re-import.
struct LibrarySnapshot: Equatable {
    let playlists: [LibraryPlaylist]
    let occurrences: [LibraryOccurrence]
    let history: [LibraryHistoryEvent]

    static let empty = LibrarySnapshot(playlists: [], occurrences: [], history: [])

    // Filter by local occurrence identity, never by YouTube video identity.
    func unwatchedOccurrences(for playlistId: PlaylistID) -> [LibraryOccurrence] {
        let completed = Set(history.lazy
            .filter { $0.playlistId == playlistId && $0.completed }
            .map(\.videoId))
        return occurrences.filter { $0.playlistId == playlistId && !completed.contains($0.id) }
    }
}

protocol LibraryRepository {
    func snapshot() throws -> LibrarySnapshot
}

// Refreshes one existing playlist from a new API response. Every track that is
// still in the playlist keeps its local occurrence identity, and therefore its
// listening history; tracks that left the playlist are reported as removed so
// their history can be dropped with them. Repeated copies of one video are
// paired with the new copies in playlist order: a best-effort identity, not
// proof that a particular copy survived.
struct PlaylistRefreshPlan: Equatable {
    enum Failure: Error, Equatable {
        case unknownPlaylist
        case mismatchedPlaylist
        case emptyResult
        case duplicateOccurrence
    }

    let playlist: LibraryPlaylist
    let kept: [LibraryOccurrence]
    let added: [LibraryOccurrence]
    let removed: [OccurrenceID]

    var changesTracks: Bool { !added.isEmpty || !removed.isEmpty }

    /// `fetched` is the single-playlist snapshot PlaylistAPIImport made for the
    /// same YouTube playlist. Its fresh identities are used only for new tracks.
    static func make(existing snapshot: LibrarySnapshot, playlistId: PlaylistID,
                     fetched: LibrarySnapshot, refreshedAt: String) throws -> PlaylistRefreshPlan {
        guard let current = snapshot.playlists.first(where: { $0.id == playlistId }) else { throw Failure.unknownPlaylist }
        guard fetched.playlists.count == 1, let remote = fetched.playlists.first,
              scalarEqual(remote.youtubeId, current.youtubeId) else { throw Failure.mismatchedPlaylist }
        let existing = snapshot.occurrences.filter { $0.playlistId == playlistId }.sorted(by: playlistOrder)
        let incoming = fetched.occurrences.filter { $0.playlistId == remote.id }.sorted(by: playlistOrder)
        guard incoming.count == fetched.occurrences.count else { throw Failure.mismatchedPlaylist }
        // An empty answer for a playlist that has tracks is far more likely a
        // service problem than a deliberately emptied playlist.
        guard !incoming.isEmpty || existing.isEmpty else { throw Failure.emptyResult }

        var pool: [String: [LibraryOccurrence]] = [:]
        for item in existing { pool[item.youtubeId, default: []].append(item) }
        var used: [String: Int] = [:]
        var kept: [LibraryOccurrence] = []
        var added: [LibraryOccurrence] = []
        var keptIDs = Set<OccurrenceID>()
        let taken = Set(snapshot.occurrences.map(\.id))
        for item in incoming {
            let next = used[item.youtubeId, default: 0]
            if let candidates = pool[item.youtubeId], next < candidates.count {
                used[item.youtubeId] = next + 1
                let local = candidates[next]
                keptIDs.insert(local.id)
                kept.append(item.assigned(id: local.id, playlistId: playlistId))
            } else {
                guard !taken.contains(item.id) else { throw Failure.duplicateOccurrence }
                added.append(item.assigned(id: item.id, playlistId: playlistId))
            }
        }
        let removed = existing.filter { !keptIDs.contains($0.id) }.map(\.id)
        let playlist = LibraryPlaylist(id: current.id, youtubeId: current.youtubeId, title: remote.title,
                                       description: remote.description, thumbnail: remote.thumbnail,
                                       channelTitle: remote.channelTitle, videoCount: remote.videoCount,
                                       createdAt: current.createdAt, updatedAt: refreshedAt)
        return PlaylistRefreshPlan(playlist: playlist, kept: kept, added: added, removed: removed)
    }

    /// The library after this refresh. History that refers to a removed
    /// occurrence is dropped with it; all other history is unchanged.
    func applied(to snapshot: LibrarySnapshot) -> LibrarySnapshot {
        let removedIDs = Set(removed)
        return LibrarySnapshot(
            playlists: snapshot.playlists.map { $0.id == playlist.id ? playlist : $0 },
            occurrences: snapshot.occurrences.filter { $0.playlistId != playlist.id } + kept + added,
            history: snapshot.history.filter { !removedIDs.contains($0.videoId) })
    }

    private static func playlistOrder(_ lhs: LibraryOccurrence, _ rhs: LibraryOccurrence) -> Bool {
        if lhs.position != rhs.position { return lhs.position < rhs.position }
        return lhs.id.rawValue.unicodeScalars.map(\.value).lexicographicallyPrecedes(rhs.id.rawValue.unicodeScalars.map(\.value))
    }
}

private extension LibraryOccurrence {
    func assigned(id: OccurrenceID, playlistId: PlaylistID) -> LibraryOccurrence {
        LibraryOccurrence(id: id, playlistId: playlistId, youtubeId: youtubeId, title: title, channelTitle: channelTitle,
                          thumbnail: thumbnail, duration: duration, position: position, viewCount: viewCount,
                          likeCount: likeCount, description: description, tags: tags, categoryId: categoryId,
                          publishedAt: publishedAt)
    }
}
