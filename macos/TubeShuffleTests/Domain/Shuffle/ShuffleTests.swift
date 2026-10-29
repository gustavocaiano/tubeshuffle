import Foundation
import XCTest
@testable import TubeShuffle

final class ShuffleTests: XCTestCase {
    private struct Corpus: Decodable {
        let classifierV1: [ClassifierCase]
        let classifierDifferential: [DifferentialCase]
        let v1: [OrderCase]
    }
    private struct DifferentialCase: Decodable {
        let name: String
        let input: EnergyTrackInput
        let expected: TrackEnergyProfile
    }
    private struct ClassifierCase: Decodable {
        let input: EnergyTrackInput
        let expected: TrackEnergyProfile
    }
    private struct OrderCase: Decodable {
        let name: String
        let mode: String
        let tracks: [EnergyTrackInput]
        let draws: [Double]
        let expectedOccurrences: [Int]
    }

    private func corpus() throws -> Corpus {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "smart", withExtension: "json"), "Missing bundled fixture: smart.json")
        return try JSONDecoder().decode(Corpus.self, from: Data(contentsOf: url))
    }

    func testClassifierVectors() throws {
        for vector in try corpus().classifierV1 {
            let actual = ShuffleV1.classify(vector.input)
            XCTAssertEqual(actual.bucket, vector.expected.bucket, vector.input.title)
            XCTAssertEqual(actual.score, vector.expected.score, vector.input.title)
            XCTAssertEqual(actual.confidence, vector.expected.confidence, accuracy: 1e-12, vector.input.title)
            XCTAssertEqual(actual.signals.map { Array($0.utf16) }, vector.expected.signals.map { Array($0.utf16) }, vector.input.title)
        }
    }

    func testDifferentialClassifierVectors() throws {
        for vector in try corpus().classifierDifferential {
            let actual = ShuffleV1.classify(vector.input)
            XCTAssertEqual(actual.bucket, vector.expected.bucket, vector.name)
            XCTAssertEqual(actual.score, vector.expected.score, vector.name)
            XCTAssertEqual(actual.confidence, vector.expected.confidence, accuracy: 1e-12, vector.name)
            // Swift String equality is canonically equivalent, unlike JS's UTF-16 equality.
            XCTAssertEqual(actual.signals.map { Array($0.utf16) }, vector.expected.signals.map { Array($0.utf16) }, vector.name)
        }
    }

    func testOccurrenceAndDrawVectors() throws {
        for vector in try corpus().v1 {
            var consumed = 0
            let draw: () -> Double = {
                guard consumed < vector.draws.count else {
                    XCTFail("Draw stream exhausted: \(vector.name)")
                    return 0
                }
                let value = vector.draws[consumed]
                consumed += 1
                return value
            }
            let actual: [Int]
            switch vector.mode {
            case "normal": actual = ShuffleV1.randomShuffle(count: vector.tracks.count, draw: draw)
            case "smart": actual = ShuffleV1.smartShuffle(vector.tracks, draw: draw)
            default: XCTFail("Unknown mode: \(vector.mode)"); continue
            }
            XCTAssertEqual(actual, vector.expectedOccurrences, vector.name)
            XCTAssertEqual(consumed, vector.draws.count, "Unused draws: \(vector.name)")
            XCTAssertEqual(actual.sorted(), Array(vector.tracks.indices), vector.name)
        }
    }
}
