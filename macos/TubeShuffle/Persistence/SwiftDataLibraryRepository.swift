import Foundation
import SwiftData

// Keys are ASCII encodings of exact UTF-8, not Swift String identity comparisons.
enum LibraryStorageKey {
    static func encode(_ value: String) -> String {
        value.utf8.map { String(format: "%02x", $0) }.joined()
    }

    static func valid(_ key: String, original: String) -> Bool {
        let scalars = original.unicodeScalars
        return (1...200).contains(scalars.count)
            && !scalars.contains { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }
            && key.utf8.elementsEqual(encode(original).utf8)
    }
}

@Model final class StoredPlaylist {
    var key: String
    var id: String
    var youtubeId: String
    var title: String
    var detail: String?
    var thumbnail: String?
    var channelTitle: String?
    var videoCount: Int
    var createdAt: String
    var updatedAt: String

    init(_ value: LibraryPlaylist) {
        id = value.id.rawValue; key = LibraryStorageKey.encode(value.id.rawValue)
        youtubeId = value.youtubeId; title = value.title; detail = value.description
        thumbnail = value.thumbnail; channelTitle = value.channelTitle; videoCount = value.videoCount
        createdAt = value.createdAt; updatedAt = value.updatedAt
    }
    var value: LibraryPlaylist {
        LibraryPlaylist(id: PlaylistID(id), youtubeId: youtubeId, title: title, description: detail,
                        thumbnail: thumbnail, channelTitle: channelTitle, videoCount: videoCount,
                        createdAt: createdAt, updatedAt: updatedAt)
    }
}

@Model final class StoredOccurrence {
    var key: String
    var id: String
    var playlistKey: String
    var playlistId: String
    var youtubeId: String
    var title: String
    var channelTitle: String
    var thumbnail: String
    var duration: Double
    var position: Int
    var viewCount: Int?
    var likeCount: Int?
    var detail: String?
    var tags: [String]?
    var categoryId: String?
    var publishedAt: String?

    init(_ value: LibraryOccurrence) {
        id = value.id.rawValue; key = LibraryStorageKey.encode(value.id.rawValue)
        playlistId = value.playlistId.rawValue; playlistKey = LibraryStorageKey.encode(value.playlistId.rawValue)
        youtubeId = value.youtubeId; title = value.title; channelTitle = value.channelTitle
        thumbnail = value.thumbnail; duration = value.duration; position = value.position
        viewCount = value.viewCount; likeCount = value.likeCount; detail = value.description
        tags = value.tags; categoryId = value.categoryId; publishedAt = value.publishedAt
    }
    var value: LibraryOccurrence {
        LibraryOccurrence(id: OccurrenceID(id), playlistId: PlaylistID(playlistId), youtubeId: youtubeId,
                          title: title, channelTitle: channelTitle, thumbnail: thumbnail, duration: duration,
                          position: position, viewCount: viewCount, likeCount: likeCount, description: detail,
                          tags: tags, categoryId: categoryId, publishedAt: publishedAt)
    }
}

@Model final class StoredHistoryEvent {
    var key: String
    var id: String
    var playlistKey: String
    var playlistId: String
    var videoKey: String
    var videoId: String
    var watchedAt: String
    var watchedSeconds: Double
    var completed: Bool

    init(_ value: LibraryHistoryEvent) {
        id = value.id.rawValue; key = LibraryStorageKey.encode(value.id.rawValue)
        playlistId = value.playlistId.rawValue; playlistKey = LibraryStorageKey.encode(value.playlistId.rawValue)
        videoId = value.videoId.rawValue; videoKey = LibraryStorageKey.encode(value.videoId.rawValue)
        watchedAt = value.watchedAt; watchedSeconds = value.watchedSeconds; completed = value.completed
    }
    var value: LibraryHistoryEvent {
        LibraryHistoryEvent(id: HistoryID(id), playlistId: PlaylistID(playlistId), videoId: OccurrenceID(videoId),
                            watchedAt: watchedAt, watchedSeconds: watchedSeconds, completed: completed)
    }
}

enum LibrarySnapshotStorageError: Error {
    case invalidKey, duplicateID, duplicatePosition, danglingReference
}

// Experimental destination-invariant reader only; NOT an export snapshot or a
// transfer implementation. The caller must ensure exclusive access to the whole
// store (including other contexts/processes) for the entire read. This cannot be
// enforced here: three fetches are not a SwiftData transaction or a consistent
// snapshot in the presence of writers. A confined context alone is insufficient.
// Orphan history is rejected, not inspected/omitted/reported as export requires.
// This prototype neither creates a store nor writes, and validates only the
// keys, identities, references and positions below, not all transfer constraints.
struct ExperimentalExclusiveStoreDestinationInvariantReader {
    private let context: ModelContext
    init(context: ModelContext) { self.context = context }

    func readAssumingExternallyExclusiveStore() throws -> LibrarySnapshot {
        let playlists = try context.fetch(FetchDescriptor<StoredPlaylist>())
        let occurrences = try context.fetch(FetchDescriptor<StoredOccurrence>())
        let history = try context.fetch(FetchDescriptor<StoredHistoryEvent>())
        var playlistKeys = Set<String>()
        var occurrencePlaylists: [String: String] = [:]
        var positions: [String: Set<Int>] = [:]
        var historyKeys = Set<String>()
        for record in playlists {
            guard LibraryStorageKey.valid(record.key, original: record.id) else { throw LibrarySnapshotStorageError.invalidKey }
            guard playlistKeys.insert(record.key).inserted else { throw LibrarySnapshotStorageError.duplicateID }
        }
        for record in occurrences {
            guard LibraryStorageKey.valid(record.key, original: record.id),
                  LibraryStorageKey.valid(record.playlistKey, original: record.playlistId) else { throw LibrarySnapshotStorageError.invalidKey }
            guard occurrencePlaylists.updateValue(record.playlistKey, forKey: record.key) == nil else { throw LibrarySnapshotStorageError.duplicateID }
            guard playlistKeys.contains(record.playlistKey) else { throw LibrarySnapshotStorageError.danglingReference }
            guard positions[record.playlistKey, default: []].insert(record.position).inserted else { throw LibrarySnapshotStorageError.duplicatePosition }
        }
        for record in history {
            guard LibraryStorageKey.valid(record.key, original: record.id),
                  LibraryStorageKey.valid(record.playlistKey, original: record.playlistId),
                  LibraryStorageKey.valid(record.videoKey, original: record.videoId) else { throw LibrarySnapshotStorageError.invalidKey }
            guard historyKeys.insert(record.key).inserted else { throw LibrarySnapshotStorageError.duplicateID }
            guard playlistKeys.contains(record.playlistKey), occurrencePlaylists[record.videoKey] == record.playlistKey else {
                throw LibrarySnapshotStorageError.danglingReference
            }
        }
        // Stable deterministic ordering, with occurrence position primary within each playlist.
        let orderedPlaylists = playlists.sorted { $0.key < $1.key }
        let orderedOccurrences = occurrences.sorted {
            if $0.playlistKey != $1.playlistKey { return $0.playlistKey < $1.playlistKey }
            if $0.position != $1.position { return $0.position < $1.position }
            return $0.key < $1.key
        }
        return LibrarySnapshot(playlists: orderedPlaylists.map(\.value), occurrences: orderedOccurrences.map(\.value),
                               history: history.sorted { $0.key < $1.key }.map(\.value))
    }
}
