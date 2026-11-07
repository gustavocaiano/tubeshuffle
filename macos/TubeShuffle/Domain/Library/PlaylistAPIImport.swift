import Foundation

// Pure API-to-library conversion. It deliberately creates new local
// occurrence identities and has no mapping to an existing snapshot, history,
// queue, or persistence destination.
enum PlaylistAPIImport {
    enum Warning: Equatable {
        // The remote playlist reports more/fewer items than the API response.
        // The snapshot keeps the declared count; callers must disclose this
        // rather than presenting the received array as a complete playlist.
        case videoCountDiffers(declared: Int, received: Int)
    }

    struct Result: Equatable {
        let snapshot: LibrarySnapshot
        let warnings: [Warning]
    }

    enum Error: Swift.Error, Equatable {
        case requestedIDMismatch
        case unplayableVideoID
        case tooManyVideos
        case invalidNumber(field: String)
        case explicitNullCount(field: String)
        case duplicatePosition(Int)
        case duplicateGeneratedID
        case invalidPublicationTimestamp
        case invalidTransferContract(TransferV1.Error)
        case transferRoundTripChangedSnapshot
    }

    // `importedAt` is supplied by the caller so conversion remains pure and
    // testable. It must satisfy TransferV1's canonical UTC-millisecond format.
    // Injecting UUIDs is test support only; production uses fresh UUID values.
    static func make(requestedPlaylistID: String, dto: YouTubePlaylistDTO, importedAt: String,
                     nextUUID: () -> UUID = UUID.init) throws -> Result {
        guard scalarEqual(requestedPlaylistID, dto.id) else { throw Error.requestedIDMismatch }
        guard dto.videos.count <= 5_000 else { throw Error.tooManyVideos }
        let declaredCount = try nonNegativeInteger(dto.videoCount, field: "videoCount", maximum: 1_000_000)

        let playlistID = PlaylistID(nextUUID().uuidString)
        var occurrenceIDs = Set<OccurrenceID>()
        var positions = Set<Int>()
        var occurrences: [LibraryOccurrence] = []
        occurrences.reserveCapacity(dto.videos.count)
        let publicationFormatter = ISO8601DateFormatter()
        publicationFormatter.formatOptions = [.withInternetDateTime]

        for video in dto.videos {
            guard video.id.range(of: "^[A-Za-z0-9_-]{11}$", options: .regularExpression) != nil else { throw Error.unplayableVideoID }
            let position = try nonNegativeInteger(video.position, field: "video.position", maximum: 9_007_199_254_740_991)
            guard positions.insert(position).inserted else { throw Error.duplicatePosition(position) }
            let occurrenceID = OccurrenceID(nextUUID().uuidString)
            guard occurrenceID.rawValue != playlistID.rawValue, occurrenceIDs.insert(occurrenceID).inserted else {
                throw Error.duplicateGeneratedID
            }
            occurrences.append(LibraryOccurrence(
                id: occurrenceID,
                playlistId: playlistID,
                youtubeId: video.id,
                title: video.title,
                channelTitle: video.channelTitle,
                thumbnail: video.thumbnail,
                duration: try seconds(video.duration, field: "video.duration"),
                position: position,
                viewCount: try count(video.viewCount, field: "video.viewCount"),
                likeCount: try count(video.likeCount, field: "video.likeCount"),
                description: video.description,
                tags: video.tags,
                categoryId: video.categoryId,
                publishedAt: try publicationTimestamp(video.publishedAt, formatter: publicationFormatter)
            ))
        }

        let playlist = LibraryPlaylist(
            id: playlistID,
            youtubeId: dto.id,
            title: dto.title,
            description: dto.description,
            thumbnail: dto.thumbnail,
            channelTitle: dto.channelTitle,
            videoCount: declaredCount,
            createdAt: importedAt,
            updatedAt: importedAt
        )
        let snapshot = LibrarySnapshot(playlists: [playlist], occurrences: occurrences, history: [])

        // TransferV1 is the v1 validation authority. Encoding and decoding
        // checks all text/YouTube/timestamp bounds without opening storage.
        let roundTrip: TransferV1.Decoded
        do {
            let encoded = try TransferV1.encode(snapshot: snapshot, exportedAt: importedAt)
            guard encoded.omittedOrphans.isEmpty else { throw Error.transferRoundTripChangedSnapshot }
            roundTrip = try TransferV1.decode(encoded.data)
        } catch let error as Error {
            throw error
        } catch let error as TransferV1.Error {
            throw Error.invalidTransferContract(error)
        }
        guard roundTrip.snapshot == snapshot, roundTrip.omittedOrphans.isEmpty else {
            throw Error.transferRoundTripChangedSnapshot
        }
        let warnings: [Warning] = declaredCount == dto.videos.count ? [] : [
            .videoCountDiffers(declared: declaredCount, received: dto.videos.count)
        ]
        return Result(snapshot: snapshot, warnings: warnings)
    }

    private static let publicationPattern = try! NSRegularExpression(
        pattern: #"^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?(Z|[+-][0-9]{2}:[0-9]{2})$"#)

    // Upstream RFC3339 publication metadata can omit milliseconds or carry an
    // offset. Convert here; transfer/history timestamps retain their strict
    // canonical contract. Sub-millisecond publication precision is truncated.
    private static func publicationTimestamp(_ value: String?, formatter: ISO8601DateFormatter) throws -> String? {
        guard let value else { return nil }
        let text = value as NSString, range = NSRange(location: 0, length: (value as NSString).length)
        guard let match = publicationPattern.firstMatch(in: value, range: range), match.range == range else {
            throw Error.invalidPublicationTimestamp
        }
        var whole = text.substring(with: match.range(at: 1))
        let fractionRange = match.range(at: 2)
        let fraction = fractionRange.location == NSNotFound ? "" : text.substring(with: fractionRange)
        let zone = text.substring(with: match.range(at: 3))
        if zone != "Z" {
            let bytes = Array(zone.utf8)
            let hours = Int(bytes[1] - 48) * 10 + Int(bytes[2] - 48)
            let minutes = Int(bytes[4] - 48) * 10 + Int(bytes[5] - 48)
            guard hours <= 23, minutes <= 59, zone != "-00:00",
                  let timezone = TimeZone(secondsFromGMT: (hours * 3_600 + minutes * 60) * (bytes[0] == 45 ? -1 : 1)) else {
                throw Error.invalidPublicationTimestamp
            }
            formatter.timeZone = timezone
            guard let date = formatter.date(from: whole + zone),
                  String(formatter.string(from: date).prefix(19)) == whole else { throw Error.invalidPublicationTimestamp }
            formatter.timeZone = TimeZone(secondsFromGMT: 0)
            whole = String(formatter.string(from: date).prefix(19))
        }
        return whole + "." + (fraction + "000").prefix(3) + "Z"
    }

    private static func count(_ field: WireField<Double>, field name: String) throws -> Int? {
        switch field {
        case .absent: return nil
        case .null: throw Error.explicitNullCount(field: name)
        case .value(let value): return try nonNegativeInteger(value, field: name, maximum: 9_007_199_254_740_991)
        }
    }

    private static func nonNegativeInteger(_ value: Double, field: String, maximum: Int) throws -> Int {
        guard value.isFinite, value >= 0, value.rounded() == value,
              value <= Double(maximum), let integer = Int(exactly: value) else {
            throw Error.invalidNumber(field: field)
        }
        return integer
    }

    private static func seconds(_ value: Double, field: String) throws -> Double {
        guard value.isFinite, value >= 0, value <= 864_000 else { throw Error.invalidNumber(field: field) }
        return value
    }

    private static func scalarEqual(_ lhs: String, _ rhs: String) -> Bool {
        lhs.unicodeScalars.elementsEqual(rhs.unicodeScalars)
    }
}
