import Foundation

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
}

struct LibraryHistoryEvent: Equatable {
    let id: HistoryID
    let playlistId: PlaylistID
    // This refers to a local occurrence, never to a YouTube video ID.
    let videoId: OccurrenceID
    let watchedAt: String
    let watchedSeconds: Double
    let completed: Bool
}

// A value snapshot is not a transfer payload or a validated persistence model.
struct LibrarySnapshot: Equatable {
    let playlists: [LibraryPlaylist]
    let occurrences: [LibraryOccurrence]
    let history: [LibraryHistoryEvent]

    static let empty = LibrarySnapshot(playlists: [], occurrences: [], history: [])
}

protocol LibraryRepository {
    func snapshot() throws -> LibrarySnapshot
}
