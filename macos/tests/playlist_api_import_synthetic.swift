import Foundation

@main
struct PlaylistAPIImportSynthetic {
    static func main() throws {
        let date = "2026-11-05T12:00:00.000Z"
        let valid = try dto(videoCount: 2, videos: [video(id: "abcdefghijk", position: 0)])
        var ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"]
        let result = try PlaylistAPIImport.make(requestedPlaylistID: "PL12345678", dto: valid, importedAt: date) {
            UUID(uuidString: ids.removeFirst())!
        }
        precondition(result.warnings == [.videoCountDiffers(declared: 2, received: 1)])
        precondition(result.snapshot.playlists.count == 1 && result.snapshot.occurrences.count == 1)
        precondition(result.snapshot.occurrences[0].id.rawValue != valid.videos[0].id)
        precondition(result.snapshot.occurrences[0].playlistId == result.snapshot.playlists[0].id)
        precondition(result.snapshot.occurrences[0].viewCount == nil && result.snapshot.occurrences[0].likeCount == nil)

        expect(.requestedIDMismatch) {
            _ = try PlaylistAPIImport.make(requestedPlaylistID: "PL87654321", dto: valid, importedAt: date)
        }
        let nullCount = try dto(videoCount: 1, videos: [video(id: "abcdefghijk", position: 0, viewCount: NSNull())])
        expect(.explicitNullCount(field: "video.viewCount")) {
            _ = try PlaylistAPIImport.make(requestedPlaylistID: "PL12345678", dto: nullCount, importedAt: date)
        }
        let duplicatePosition = try dto(videoCount: 2, videos: [video(id: "abcdefghijk", position: 0), video(id: "lmnopqrstuv", position: 0)])
        expect(.duplicatePosition(0)) {
            _ = try PlaylistAPIImport.make(requestedPlaylistID: "PL12345678", dto: duplicatePosition, importedAt: date)
        }
        let invalidVideo = try dto(videoCount: 1, videos: [video(id: "not/a-video", position: 0)])
        do {
            _ = try PlaylistAPIImport.make(requestedPlaylistID: "PL12345678", dto: invalidVideo, importedAt: date)
            preconditionFailure("invalid video ID accepted")
        } catch PlaylistAPIImport.Error.unplayableVideoID { }
        print("PlaylistAPIImport synthetic checks passed")
    }

    private static func expect(_ wanted: PlaylistAPIImport.Error, _ body: () throws -> Void) {
        do { try body(); preconditionFailure("expected \(wanted)") }
        catch let error as PlaylistAPIImport.Error { precondition(error == wanted) }
        catch { preconditionFailure("unexpected \(error)") }
    }

    private static func dto(videoCount: Int, videos: [[String: Any]]) throws -> YouTubePlaylistDTO {
        let object: [String: Any] = [
            "id": "PL12345678", "title": "Synthetic playlist", "description": NSNull(),
            "thumbnail": NSNull(), "channelTitle": NSNull(), "videoCount": videoCount, "videos": videos,
        ]
        return try JSONDecoder().decode(YouTubePlaylistDTO.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private static func video(id: String, position: Int, viewCount: Any? = nil) -> [String: Any] {
        var result: [String: Any] = [
            "id": id, "title": "Synthetic video", "channelTitle": "Synthetic creator",
            "thumbnail": "thumbnail", "duration": 12.5, "position": position,
        ]
        if let viewCount { result["viewCount"] = viewCount }
        return result
    }
}
