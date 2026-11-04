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
