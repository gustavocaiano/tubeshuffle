import Foundation

// Existing proxies serialize non-finite parsed counts as null. Keep that
// distinguishable from an omitted property and from an actual numeric value.
enum WireField<Value: Codable & Equatable>: Equatable {
    case absent, null, value(Value)
}

extension KeyedDecodingContainer {
    func wireField<T: Codable & Equatable>(_ type: T.Type, forKey key: Key) throws -> WireField<T> {
        guard contains(key) else { return .absent }
        if try decodeNil(forKey: key) { return .null }
        return .value(try decode(T.self, forKey: key))
    }

    // An optional wire property may be missing, but explicit null is invalid.
    func omittedOrValue<T: Decodable>(_ type: T.Type, forKey key: Key) throws -> T? {
        guard contains(key) else { return nil }
        return try decode(T.self, forKey: key)
    }
}

extension KeyedEncodingContainer {
    mutating func encodeWireField<T>(_ field: WireField<T>, forKey key: Key) throws {
        switch field {
        case .absent: break
        case .null: try encodeNil(forKey: key)
        case .value(let value): try encode(value, forKey: key)
        }
    }
}

struct YouTubePlaylistDTO: Codable, Equatable {
    let id: String
    let title: String
    let description: String?
    let thumbnail: String?
    let channelTitle: String?
    // JavaScript numbers, not Swift integers: upstream does not validate them.
    let videoCount: Double
    let videos: [YouTubeVideoDTO]

    enum CodingKeys: String, CodingKey { case id, title, description, thumbnail, channelTitle, videoCount, videos }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        // decode(Optional.self) requires presence, unlike decodeIfPresent.
        description = try c.decode(String?.self, forKey: .description)
        thumbnail = try c.decode(String?.self, forKey: .thumbnail)
        channelTitle = try c.decode(String?.self, forKey: .channelTitle)
        videoCount = try c.decode(Double.self, forKey: .videoCount)
        videos = try c.decode([YouTubeVideoDTO].self, forKey: .videos)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(title, forKey: .title)
        try c.encode(description, forKey: .description); try c.encode(thumbnail, forKey: .thumbnail)
        try c.encode(channelTitle, forKey: .channelTitle); try c.encode(videoCount, forKey: .videoCount)
        try c.encode(videos, forKey: .videos)
    }
}

struct YouTubeVideoDTO: Codable, Equatable {
    let id, title, channelTitle, thumbnail: String
    let duration, position: Double // duration in seconds
    let viewCount, likeCount: WireField<Double>
    let description: String?
    let tags: [String]?
    let categoryId, publishedAt: String? // upstream date text is not normalized

    enum CodingKeys: String, CodingKey { case id, title, channelTitle, thumbnail, duration, position, viewCount, likeCount, description, tags, categoryId, publishedAt }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); title = try c.decode(String.self, forKey: .title)
        channelTitle = try c.decode(String.self, forKey: .channelTitle); thumbnail = try c.decode(String.self, forKey: .thumbnail)
        duration = try c.decode(Double.self, forKey: .duration); position = try c.decode(Double.self, forKey: .position)
        viewCount = try c.wireField(Double.self, forKey: .viewCount); likeCount = try c.wireField(Double.self, forKey: .likeCount)
        description = try c.omittedOrValue(String.self, forKey: .description); tags = try c.omittedOrValue([String].self, forKey: .tags)
        categoryId = try c.omittedOrValue(String.self, forKey: .categoryId); publishedAt = try c.omittedOrValue(String.self, forKey: .publishedAt)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(title, forKey: .title); try c.encode(channelTitle, forKey: .channelTitle)
        try c.encode(thumbnail, forKey: .thumbnail); try c.encode(duration, forKey: .duration); try c.encode(position, forKey: .position)
        try c.encodeWireField(viewCount, forKey: .viewCount); try c.encodeWireField(likeCount, forKey: .likeCount)
        try c.encodeIfPresent(description, forKey: .description); try c.encodeIfPresent(tags, forKey: .tags)
        try c.encodeIfPresent(categoryId, forKey: .categoryId); try c.encodeIfPresent(publishedAt, forKey: .publishedAt)
    }
}

struct SuggestedVideoDTO: Codable, Equatable {
    let id, youtubeId, title, channelTitle, thumbnail: String
    let duration: Double // seconds
    let url, reason, query: String
    let publishedAt: String?
    let viewCount: WireField<Double>
    enum CodingKeys: String, CodingKey { case id, youtubeId, title, channelTitle, thumbnail, duration, url, reason, query, publishedAt, viewCount }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id); youtubeId = try c.decode(String.self, forKey: .youtubeId)
        title = try c.decode(String.self, forKey: .title); channelTitle = try c.decode(String.self, forKey: .channelTitle)
        thumbnail = try c.decode(String.self, forKey: .thumbnail); duration = try c.decode(Double.self, forKey: .duration)
        url = try c.decode(String.self, forKey: .url); reason = try c.decode(String.self, forKey: .reason)
        query = try c.decode(String.self, forKey: .query); publishedAt = try c.omittedOrValue(String.self, forKey: .publishedAt)
        viewCount = try c.wireField(Double.self, forKey: .viewCount)
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id); try c.encode(youtubeId, forKey: .youtubeId); try c.encode(title, forKey: .title)
        try c.encode(channelTitle, forKey: .channelTitle); try c.encode(thumbnail, forKey: .thumbnail); try c.encode(duration, forKey: .duration)
        try c.encode(url, forKey: .url); try c.encode(reason, forKey: .reason); try c.encode(query, forKey: .query)
        try c.encodeIfPresent(publishedAt, forKey: .publishedAt); try c.encodeWireField(viewCount, forKey: .viewCount)
    }
}

struct DailySuggestionsDTO: Codable, Equatable {
    let playlistId, generatedAt, dateKey, query: String
    let quotaCost: Double
    let suggestions: [SuggestedVideoDTO]
}

// Proposed response DTOs; server-side ID/date validation is not client logic.
// Preserve timestamp strings exactly, including milliseconds and UTC suffix.
struct PlaylistLinkDTO: Codable, Equatable {
    let youtubePlaylistId: String
    let createdAt: String
}
struct PlaylistLinksResponseDTO: Codable, Equatable { let links: [PlaylistLinkDTO] }
struct PlaylistLinkResponseDTO: Codable, Equatable { let link: PlaylistLinkDTO }
struct LegacyAPIErrorDTO: Codable, Equatable { let error: String }
struct OwnerAPIErrorDTO: Codable, Equatable {
    struct Detail: Codable, Equatable { let code, message: String }
    let error: Detail
}
struct UpstreamAPIErrorDTO: Codable, Equatable {
    struct Detail: Codable, Equatable { let code: Double; let message: String }
    let error: Detail
}
