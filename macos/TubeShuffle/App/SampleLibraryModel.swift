import Foundation

// Synthetic data only. Occurrences deliberately have identities separate from video IDs.
struct SampleLibraryModel {
    let snapshot: LibrarySnapshot

    init() {
        let first = PlaylistID("sample-mornings")
        let second = PlaylistID("sample-evenings")
        let date = "2026-01-01T00:00:00Z"
        func playlist(_ id: PlaylistID, _ title: String, _ count: Int) -> LibraryPlaylist {
            LibraryPlaylist(id: id, youtubeId: "sample-\(id.rawValue)", title: title,
                            description: nil, thumbnail: nil, channelTitle: nil,
                            videoCount: count, createdAt: date, updatedAt: date)
        }
        func item(_ id: String, _ playlist: PlaylistID, _ video: String, _ title: String, _ position: Int) -> LibraryOccurrence {
            LibraryOccurrence(id: OccurrenceID(id), playlistId: playlist, youtubeId: video,
                              title: title, channelTitle: "Sample creator", thumbnail: "",
                              duration: 0, position: position, viewCount: nil, likeCount: nil,
                              description: nil, tags: nil, categoryId: nil, publishedAt: nil)
        }
        snapshot = LibrarySnapshot(
            playlists: [playlist(first, "Slow mornings", 3), playlist(second, "After hours", 2)],
            occurrences: [
                item("morning-1", first, "sample-video-a", "A little daylight", 0),
                item("morning-2", first, "sample-video-b", "Coffee break", 1),
                item("morning-3", first, "sample-video-a", "A little daylight", 2),
                item("evening-1", second, "sample-video-c", "City lights", 0),
                item("evening-2", second, "sample-video-d", "The long way home", 1)
            ],
            history: [LibraryHistoryEvent(id: HistoryID("sample-history-1"), playlistId: first,
                                          videoId: OccurrenceID("morning-1"), watchedAt: date,
                                          watchedSeconds: 120, completed: true)])
    }

    func occurrences(for playlist: PlaylistID) -> [LibraryOccurrence] {
        snapshot.occurrences.filter { $0.playlistId == playlist }.sorted { $0.position < $1.position }
    }

    func isWatched(_ occurrence: LibraryOccurrence) -> Bool {
        snapshot.history.contains { $0.playlistId == occurrence.playlistId && $0.videoId == occurrence.id && $0.completed }
    }
}
