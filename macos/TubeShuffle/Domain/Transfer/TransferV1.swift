import Foundation

/// The transfer boundary is deliberately value-only.  It never opens a store,
/// guesses occurrence continuity, or writes an import.
enum TransferV1 {
    static let format = "tubeshuffle-transfer"
    static let version = 1
    static let maximumBytes = RawJSONScanner.maximumBytes

    struct OmittedHistory: Equatable {
        let id: String
        let reason: String
    }

    struct Export: Equatable {
        let data: Data
        let omittedOrphans: [OmittedHistory]
        let disclosures: [String]
    }

    struct Decoded: Equatable {
        let exportedAt: String
        let snapshot: LibrarySnapshot
        /// Orphans accepted from historical files are explicitly omitted.
        let omittedOrphans: [OmittedHistory]
    }

    enum ImportBlock: Equatable {
        case nonEmptyDestination(playlists: Int, occurrences: Int, history: Int)
    }

    struct ImportPreview: Equatable {
        let source: Decoded
        let mayCreateFreshLibrary: Bool
        let block: ImportBlock?
        /// The v1 file cannot contain queue, preferences, media, or credentials.
        let disclosures: [String]
    }

    enum Error: Swift.Error, Equatable {
        case raw(RawJSONError)
        case invalidEnvelope(String)
        case unsupportedVersion
        case invalid(String)
        case fileTooLarge(requiredBytes: Int)
    }

    static func decode(_ data: Data) throws -> Decoded {
        guard data.count <= maximumBytes else { throw Error.raw(.tooLarge) }
        let document: RawJSONDocument
        do { document = try RawJSONScanner.scan(data, maximumNodes: 500_000, maximumDepth: 8) }
        catch let error as RawJSONError { throw Error.raw(error) }
        let tree = try Tree(document)
        let root = try tree.object(0, context: "envelope")
        try exactKeys(root, ["format", "version", "exportedAt", "playlists", "videos", "history"], context: "envelope")
        guard try tree.string(root["format"]!) == format else { throw Error.invalidEnvelope("format") }
        guard try integer(tree, root["version"]!) == version else { throw Error.unsupportedVersion }
        let exportedAt = try timestamp(try tree.string(root["exportedAt"]!))
        let playlists = try decodePlaylists(tree, root["playlists"]!)
        let occurrences = try decodeVideos(tree, root["videos"]!, playlistIDs: Set(playlists.map(\.id)))
        let history = try decodeHistory(tree, root["history"]!, playlists: Set(playlists.map(\.id)), occurrences: occurrences)
        return Decoded(exportedAt: exportedAt, snapshot: .init(playlists: playlists, occurrences: occurrences, history: history.kept), omittedOrphans: history.omitted)
    }

    static func encode(snapshot: LibrarySnapshot, exportedAt: String) throws -> Export {
        let exportedAt = try timestamp(exportedAt)
        try validateSnapshot(snapshot)
        let playlistIDs = Set(snapshot.playlists.map(\.id))
        let occurrenceByID = Dictionary(uniqueKeysWithValues: snapshot.occurrences.map { ($0.id, $0) })
        var keptHistory: [LibraryHistoryEvent] = []
        var omitted: [OmittedHistory] = []
        for event in snapshot.history {
            let reason: String?
            if !playlistIDs.contains(event.playlistId) { reason = "missing_playlist" }
            else if occurrenceByID[event.videoId] == nil { reason = "missing_video" }
            else if occurrenceByID[event.videoId]?.playlistId != event.playlistId { reason = "cross_playlist" }
            else { reason = nil }
            if let reason { omitted.append(.init(id: event.id.rawValue, reason: reason)) } else { keptHistory.append(event) }
        }
        let object: [String: Any] = [
            "format": format, "version": version, "exportedAt": exportedAt,
            "playlists": snapshot.playlists.map(playlistObject),
            "videos": snapshot.occurrences.map(videoObject),
            "history": keptHistory.map(historyObject),
        ]
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard data.count <= maximumBytes else { throw Error.fileTooLarge(requiredBytes: data.count) }
        return Export(data: data, omittedOrphans: omitted, disclosures: disclosures(omitted: omitted))
    }

    /// A pure plan.  A non-empty destination is always blocked: no merge,
    /// overwrite, automatic mapping, or occurrence-lineage inference exists in v1.
    static func prepareFreshImport(_ source: Decoded, destination: LibrarySnapshot) -> ImportPreview {
        let block: ImportBlock? = destination == .empty ? nil : .nonEmptyDestination(playlists: destination.playlists.count, occurrences: destination.occurrences.count, history: destination.history.count)
        return ImportPreview(source: source, mayCreateFreshLibrary: block == nil, block: block, disclosures: disclosures(omitted: source.omittedOrphans))
    }

    private static func disclosures(omitted: [OmittedHistory]) -> [String] {
        var result = [
            "v1 imports only into an empty or newly created local library; existing libraries are never merged or overwritten.",
            "Queue, preferences, media, credentials, suggestions, and transient UI state are not transferred.",
            "Occurrence IDs and retained history are copied exactly; no occurrence continuity is inferred."
        ]
        if !omitted.isEmpty { result.append("\(omitted.count) legacy orphan history event(s) were omitted; inspect the preview before creating a library.") }
        return result
    }

    private static func decodePlaylists(_ tree: Tree, _ index: Int) throws -> [LibraryPlaylist] {
        let rows = try tree.array(index, limit: 5_000, context: "playlists")
        var result: [LibraryPlaylist] = []; var ids = Set<PlaylistID>(); var youtubeIDs = Set<String>()
        for row in rows {
            let o = try tree.object(row, context: "playlist")
            try exactKeys(o, ["id","youtubeId","title","description","thumbnail","channelTitle","videoCount","createdAt","updatedAt"], context: "playlist")
            let id = PlaylistID(try opaqueID(try tree.string(o["id"]!)))
            let youtube = try youtubeID(try tree.string(o["youtubeId"]!), playlist: true)
            guard ids.insert(id).inserted, youtubeIDs.insert(youtube).inserted else { throw Error.invalid("duplicate playlist identity") }
            result.append(.init(id: id, youtubeId: youtube, title: try text(try tree.string(o["title"]!), 1_000), description: try nullableText(tree, o["description"]!, 10_000), thumbnail: try nullableText(tree, o["thumbnail"]!, 10_000), channelTitle: try nullableText(tree, o["channelTitle"]!, 10_000), videoCount: try integer(tree, o["videoCount"]!, max: 1_000_000), createdAt: try timestamp(try tree.string(o["createdAt"]!)), updatedAt: try timestamp(try tree.string(o["updatedAt"]!))))
        }
        return result
    }

    private static func decodeVideos(_ tree: Tree, _ index: Int, playlistIDs: Set<PlaylistID>) throws -> [LibraryOccurrence] {
        let rows = try tree.array(index, limit: 50_000, context: "videos")
        var result: [LibraryOccurrence] = []; var ids = Set<OccurrenceID>(); var positions = Set<PositionKey>()
        let required = ["id","playlistId","youtubeId","title","channelTitle","thumbnail","duration","position"]
        let optional = ["viewCount","likeCount","description","tags","categoryId","publishedAt"]
        for row in rows {
            let o = try tree.object(row, context: "video"); try exactKeys(o, required + optional, context: "video")
            let id = OccurrenceID(try opaqueID(try tree.string(o["id"]!)))
            let playlist = PlaylistID(try opaqueID(try tree.string(o["playlistId"]!)))
            guard playlistIDs.contains(playlist), ids.insert(id).inserted else { throw Error.invalid("video reference or identity") }
            let position = try integer(tree, o["position"]!); guard positions.insert(.init(playlist: playlist, position: position)).inserted else { throw Error.invalid("duplicate video position") }
            result.append(.init(id: id, playlistId: playlist, youtubeId: try youtubeID(try tree.string(o["youtubeId"]!), playlist: false), title: try text(try tree.string(o["title"]!), 10_000), channelTitle: try text(try tree.string(o["channelTitle"]!), 10_000), thumbnail: try text(try tree.string(o["thumbnail"]!), 10_000), duration: try seconds(tree, o["duration"]!), position: position, viewCount: try optionalInteger(tree, o["viewCount"]), likeCount: try optionalInteger(tree, o["likeCount"]), description: try optionalText(tree, o["description"], 10_000), tags: try optionalTags(tree, o["tags"]), categoryId: try optionalText(tree, o["categoryId"], 10_000), publishedAt: try optionalTimestamp(tree, o["publishedAt"])))
        }
        return result
    }

    private static func decodeHistory(_ tree: Tree, _ index: Int, playlists: Set<PlaylistID>, occurrences: [LibraryOccurrence]) throws -> (kept: [LibraryHistoryEvent], omitted: [OmittedHistory]) {
        let rows = try tree.array(index, limit: 100_000, context: "history"); let byID = Dictionary(uniqueKeysWithValues: occurrences.map { ($0.id, $0) })
        var ids = Set<HistoryID>(); var kept: [LibraryHistoryEvent] = []; var omitted: [OmittedHistory] = []
        for row in rows {
            let o = try tree.object(row, context: "history"); try exactKeys(o, ["id","playlistId","videoId","watchedAt","watchedSeconds","completed"], context: "history")
            let id = HistoryID(try opaqueID(try tree.string(o["id"]!))); guard ids.insert(id).inserted else { throw Error.invalid("duplicate history id") }
            let playlist = PlaylistID(try opaqueID(try tree.string(o["playlistId"]!))); let video = OccurrenceID(try opaqueID(try tree.string(o["videoId"]!)))
            let event = LibraryHistoryEvent(id: id, playlistId: playlist, videoId: video, watchedAt: try timestamp(try tree.string(o["watchedAt"]!)), watchedSeconds: try seconds(tree, o["watchedSeconds"]!), completed: try tree.bool(o["completed"]!))
            if !playlists.contains(playlist) { omitted.append(.init(id: id.rawValue, reason: "missing_playlist")) }
            else if byID[video] == nil { omitted.append(.init(id: id.rawValue, reason: "missing_video")) }
            else if byID[video]?.playlistId != playlist { omitted.append(.init(id: id.rawValue, reason: "cross_playlist")) }
            else { kept.append(event) }
        }
        return (kept, omitted)
    }

    private static func validateSnapshot(_ snapshot: LibrarySnapshot) throws {
        // Re-use the decoder as the single validation authority without touching storage.
        let draft: [String: Any] = ["format": format, "version": version, "exportedAt": "2000-01-01T00:00:00.000Z", "playlists": snapshot.playlists.map(playlistObject), "videos": snapshot.occurrences.map(videoObject), "history": snapshot.history.map(historyObject)]
        _ = try decode(JSONSerialization.data(withJSONObject: draft, options: []))
    }

    private static func playlistObject(_ p: LibraryPlaylist) -> [String: Any] { ["id":p.id.rawValue,"youtubeId":p.youtubeId,"title":p.title,"description":p.description ?? NSNull(),"thumbnail":p.thumbnail ?? NSNull(),"channelTitle":p.channelTitle ?? NSNull(),"videoCount":p.videoCount,"createdAt":p.createdAt,"updatedAt":p.updatedAt] }
    private static func videoObject(_ v: LibraryOccurrence) -> [String: Any] { var o:[String:Any] = ["id":v.id.rawValue,"playlistId":v.playlistId.rawValue,"youtubeId":v.youtubeId,"title":v.title,"channelTitle":v.channelTitle,"thumbnail":v.thumbnail,"duration":v.duration,"position":v.position]; if let x=v.viewCount{o["viewCount"]=x}; if let x=v.likeCount{o["likeCount"]=x}; if let x=v.description{o["description"]=x}; if let x=v.tags{o["tags"]=x}; if let x=v.categoryId{o["categoryId"]=x}; if let x=v.publishedAt{o["publishedAt"]=x}; return o }
    private static func historyObject(_ h: LibraryHistoryEvent) -> [String: Any] { ["id":h.id.rawValue,"playlistId":h.playlistId.rawValue,"videoId":h.videoId.rawValue,"watchedAt":h.watchedAt,"watchedSeconds":h.watchedSeconds,"completed":h.completed] }
}

private extension TransferV1 {
    struct PositionKey: Hashable {
        let playlist: PlaylistID
        let position: Int
    }
    struct Tree {
        let document: RawJSONDocument
        let children: [[Int]]
        init(_ document: RawJSONDocument) throws { guard !document.nodes.isEmpty else { throw Error.invalidEnvelope("root") }; self.document = document; var c = Array(repeating: [Int](), count: document.nodes.count); for (i,n) in document.nodes.enumerated() { if let p=n.parent { c[p].append(i) } }; children = c }
        func object(_ i: Int, context: String) throws -> [String:Int] {
            guard case .object = document.nodes[i].value else { throw Error.invalid("\(context) must be object") }
            // RawJSONScanner already rejects byte-identical decoded duplicate keys.
            // Do not let Swift's canonical String equality turn distinct unknown
            // keys into a trap while reporting this object as invalid later.
            var result: [String: Int] = [:]
            for child in children[i] where result[document.nodes[child].key ?? ""] == nil {
                if let key = document.nodes[child].key { result[key] = child }
            }
            return result
        }
        func array(_ i: Int, limit: Int, context: String) throws -> [Int] { guard case .array = document.nodes[i].value else { throw Error.invalid("\(context) must be array") }; guard children[i].count <= limit else { throw Error.invalid("\(context) count limit") }; return children[i] }
        func string(_ i: Int) throws -> String { guard case .string(let v)=document.nodes[i].value else { throw Error.invalid("string expected") }; return v }
        func bool(_ i: Int) throws -> Bool { guard case .bool(let v)=document.nodes[i].value else { throw Error.invalid("boolean expected") }; return v }
        func number(_ i: Int) throws -> String { guard case .number(let v)=document.nodes[i].value else { throw Error.invalid("number expected") }; return v }
        func null(_ i: Int) -> Bool { if case .null = document.nodes[i].value { return true }; return false }
    }
    static func exactKeys(_ object: [String: Int], _ allowed: [String], context: String) throws {
        let actual = Set(object.keys)
        let requiredVideo = Set(["id", "playlistId", "youtubeId", "title", "channelTitle", "thumbnail", "duration", "position"])
        let valid = actual == Set(allowed) || (context == "video" && actual.isSubset(of: Set(allowed)) && requiredVideo.isSubset(of: actual))
        guard valid else { throw Error.invalid("unknown or missing \(context) field") }
    }
    static func text(_ value:String,_ max:Int) throws -> String { guard value.unicodeScalars.count <= max else { throw Error.invalid("text length") }; return value }
    static func opaqueID(_ value:String) throws -> String { guard value.unicodeScalars.count >= 1, value.unicodeScalars.count <= 200, !value.unicodeScalars.contains(where: { $0.value <= 0x1f || (0x7f...0x9f).contains($0.value) }) else { throw Error.invalid("invalid id") }; return value }
    static func youtubeID(_ value:String, playlist:Bool) throws -> String { let b=Array(value.utf8); let valid=b.allSatisfy { ($0 >= 65 && $0 <= 90) || ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 95 || $0 == 45 }; guard valid, b.count <= 80, b.count >= (playlist ? 10 : 1) else { throw Error.invalid("invalid youtube id") }; return value }
    // Validate the decimal lexeme before binary floating-point conversion:
    // 9007199254740991.1 must not round into an accepted integer.
    static func integer(_ tree: Tree, _ i: Int, max: Int = 9_007_199_254_740_991) throws -> Int {
        let lexeme = try tree.number(i).lowercased()
        let parts = lexeme.split(separator: "e", omittingEmptySubsequences: false)
        let mantissa = String(parts[0])
        let fractionCount = mantissa.split(separator: ".", omittingEmptySubsequences: false).dropFirst().first?.count ?? 0
        var digits = Array(mantissa.utf8.filter { $0 >= 48 && $0 <= 57 }.drop(while: { $0 == 48 }))
        if digits.isEmpty { return 0 }
        guard !mantissa.hasPrefix("-"), let exponent = parts.count == 1 ? 0 : Int(parts[1]),
              (-1_000_000...1_000_000).contains(exponent) else { throw Error.invalid("invalid integer") }
        var shift = exponent - fractionCount
        while digits.last == 48 { digits.removeLast(); shift += 1 }
        guard shift >= 0, digits.count + shift <= 16 else { throw Error.invalid("invalid integer") }
        let normalized = String(decoding: digits, as: UTF8.self) + String(repeating: "0", count: shift)
        guard let value = Int(normalized), value <= max else { throw Error.invalid("invalid integer") }
        return value
    }
    static func seconds(_ tree:Tree,_ i:Int) throws -> Double { let lex=try tree.number(i); guard let n=Double(lex), n.isFinite, n >= 0, n <= 864_000 else { throw Error.invalid("invalid seconds") }; return n }
    static func nullableText(_ tree:Tree,_ i:Int,_ max:Int) throws -> String? { tree.null(i) ? nil : try text(tree.string(i),max) }
    static func optionalText(_ tree:Tree,_ i:Int?,_ max:Int) throws -> String? { guard let i else { return nil }; guard !tree.null(i) else { throw Error.invalid("optional field cannot be null") }; return try text(tree.string(i),max) }
    static func optionalInteger(_ tree:Tree,_ i:Int?) throws -> Int? { guard let i else { return nil }; guard !tree.null(i) else { throw Error.invalid("optional field cannot be null") }; return try integer(tree,i) }
    static func optionalTimestamp(_ tree:Tree,_ i:Int?) throws -> String? { guard let i else{return nil}; guard !tree.null(i) else { throw Error.invalid("optional field cannot be null") }; return try timestamp(tree.string(i)) }
    static func optionalTags(_ tree:Tree,_ i:Int?) throws -> [String]? { guard let i else{return nil}; guard !tree.null(i) else { throw Error.invalid("optional field cannot be null") }; return try tree.array(i,limit:100,context:"tags").map { try text(tree.string($0),200) } }
    static func timestamp(_ value:String) throws -> String { let f=ISO8601DateFormatter(); f.formatOptions=[.withInternetDateTime,.withFractionalSeconds]; guard value.utf8.count == 24, value.hasSuffix("Z"), let d=f.date(from:value) else { throw Error.invalid("invalid timestamp") }; let out=ISO8601DateFormatter(); out.formatOptions=[.withInternetDateTime,.withFractionalSeconds]; let result=out.string(from:d); guard result == value else { throw Error.invalid("timestamp must be UTC milliseconds") }; return value }
}
