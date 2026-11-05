import Foundation
import XCTest
@testable import TubeShuffle

final class APIModelsTests: XCTestCase {
    private func fixture(_ name: String) throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: name, withExtension: "json"), "Missing bundled fixture: \(name).json")
        let data = try Data(contentsOf: url)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func data(_ object: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .fragmentsAllowed])
    }

    private func roundTrip<T: Codable & Equatable>(_ type: T.Type, _ object: Any) throws -> T {
        let value = try JSONDecoder().decode(type, from: data(object))
        XCTAssertEqual(try JSONDecoder().decode(type, from: JSONEncoder().encode(value)), value)
        return value
    }

    func testExistingPlaylistAndPopulatedVideoFixtures() throws {
        let source = try fixture("existing-api")
        let playlist = try XCTUnwrap(source["playlist"] as? [String: Any])
        let response = try XCTUnwrap(playlist["response"] as? [String: Any])
        let body = try XCTUnwrap(response["body"] as? [String: Any])
        let decoded = try roundTrip(YouTubePlaylistDTO.self, body)
        XCTAssertNil(decoded.description)
        XCTAssertEqual(decoded.videoCount, 2)
        XCTAssertEqual(decoded.videos.map(\.id), ["abcdefghijk", "abcdefghijk"])
        XCTAssertEqual(decoded.videos.map(\.position), [0, 1])
        XCTAssertEqual(decoded.videos[0].viewCount, .absent)
        let video = try roundTrip(YouTubeVideoDTO.self, XCTUnwrap(source["playlistPopulatedVideo"]))
        XCTAssertEqual(video.duration, 180)
        XCTAssertEqual(video.viewCount, .value(1234))
        XCTAssertEqual(video.publishedAt, "2020-01-02T00:00:00Z")
    }

    func testExistingSuggestionsAndLegacyErrors() throws {
        let source = try fixture("existing-api")
        let suggestions = try XCTUnwrap(source["suggestions"] as? [String: Any])
        let response = try XCTUnwrap(suggestions["response"] as? [String: Any])
        let decoded = try roundTrip(DailySuggestionsDTO.self, XCTUnwrap(response["body"]))
        XCTAssertEqual(decoded.generatedAt, "2026-10-28T00:00:00.000Z")
        XCTAssertEqual(decoded.quotaCost, 401)
        XCTAssertEqual(decoded.suggestions[0].duration, 180)
        XCTAssertEqual(decoded.suggestions[0].viewCount, .value(1234))
        let errors = try XCTUnwrap(source["errors"] as? [[String: Any]])
        for entry in errors {
            let error = try roundTrip(LegacyAPIErrorDTO.self, XCTUnwrap(entry["body"]))
            XCTAssertFalse(error.error.isEmpty)
            XCTAssertThrowsError(try JSONDecoder().decode(OwnerAPIErrorDTO.self, from: data(XCTUnwrap(entry["body"]))))
        }
    }

    func testOwnerFixtureResponsesAndDistinctEnvelopes() throws {
        let cases = try XCTUnwrap(try fixture("owner-api-proposed")["cases"] as? [[String: Any]])
        for entry in cases {
            let response = try XCTUnwrap(entry["response"] as? [String: Any])
            guard let body = response["body"] as? [String: Any] else { continue }
            if body["link"] != nil {
                let value = try roundTrip(PlaylistLinkResponseDTO.self, body)
                XCTAssertEqual(value.link.createdAt, "2026-10-28T00:00:00.000Z")
            } else if body["links"] != nil {
                XCTAssertEqual(try roundTrip(PlaylistLinksResponseDTO.self, body).links.count, 1)
            } else if body["error"] != nil {
                let value = try roundTrip(OwnerAPIErrorDTO.self, body)
                XCTAssertFalse(value.error.code.isEmpty)
                XCTAssertThrowsError(try JSONDecoder().decode(LegacyAPIErrorDTO.self, from: data(body)))
                XCTAssertThrowsError(try JSONDecoder().decode(UpstreamAPIErrorDTO.self, from: data(body)))
            }
        }
        let upstream = ["error": ["code": 429, "message": "limited"]] as [String: Any]
        XCTAssertEqual(try roundTrip(UpstreamAPIErrorDTO.self, upstream).error.code, 429)
        XCTAssertThrowsError(try JSONDecoder().decode(OwnerAPIErrorDTO.self, from: data(upstream)))
    }

    func testPresenceNullUnknownFieldsAndNumbers() throws {
        let source = try fixture("existing-api")
        let playlist = try XCTUnwrap(source["playlist"] as? [String: Any])
        let response = try XCTUnwrap(playlist["response"] as? [String: Any])
        var body = try XCTUnwrap(response["body"] as? [String: Any])
        body.removeValue(forKey: "description")
        XCTAssertThrowsError(try JSONDecoder().decode(YouTubePlaylistDTO.self, from: data(body)))
        body["description"] = NSNull(); body["futureField"] = ["anything": true]
        XCTAssertNoThrow(try JSONDecoder().decode(YouTubePlaylistDTO.self, from: data(body)))

        var video = try XCTUnwrap(source["playlistPopulatedVideo"] as? [String: Any])
        video["viewCount"] = NSNull(); video.removeValue(forKey: "likeCount")
        video["duration"] = 12.5; video["position"] = 2.0
        video["publishedAt"] = "unmodified upstream text"
        let decoded = try roundTrip(YouTubeVideoDTO.self, video)
        XCTAssertEqual(decoded.viewCount, .null); XCTAssertEqual(decoded.likeCount, .absent)
        XCTAssertEqual(decoded.duration, 12.5); XCTAssertEqual(decoded.publishedAt, "unmodified upstream text")
        let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(decoded)) as? [String: Any])
        XCTAssertTrue(encoded["viewCount"] is NSNull); XCTAssertNil(encoded["likeCount"])
        video["tags"] = NSNull()
        XCTAssertThrowsError(try JSONDecoder().decode(YouTubeVideoDTO.self, from: data(video)))
        video["tags"] = ["tag"]; video["duration"] = "180"
        XCTAssertThrowsError(try JSONDecoder().decode(YouTubeVideoDTO.self, from: data(video)))
    }
}
