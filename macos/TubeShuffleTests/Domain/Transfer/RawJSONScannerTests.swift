import Foundation
import XCTest
@testable import TubeShuffle

final class RawJSONScannerTests: XCTestCase {
    private func scan(_ text: String) throws -> RawJSONDocument {
        try RawJSONScanner.scan(Data(text.utf8))
    }

    func testMalformedBytesAndBOM() {
        let samples: [[UInt8]] = [[0xff], [0x22, 0xc0, 0x80, 0x22], [0x22, 0xed, 0xa0, 0x80, 0x22], [0xef, 0xbb, 0xbf, 0x7b, 0x7d]]
        for bytes in samples {
            XCTAssertThrowsError(try RawJSONScanner.scan(Data(bytes)))
        }
    }

    func testDecodedDuplicateKeysAndExactEquality() throws {
        for text in [#"{"a":1,"\u0061":2}"#, #"{"outer":[{"x":1,"\u0078":2}]}"#, #"{"😀":1,"\ud83d\ude00":2}"#] {
            XCTAssertThrowsError(try scan(text)) { XCTAssertEqual($0 as? RawJSONError, .duplicateKey) }
        }
        let result = try scan("{\"é\":1,\"e\u{301}\":2}")
        XCTAssertEqual(result.nodes.count, 3)
    }

    func testSurrogatesAndSyntax() throws {
        _ = try scan(#"["\ud83d\ude00","😀"]"#)
        for text in [#""\ud800""#, #""\udc00""#, #""\ud800\u0041""#, "[1,]", "{\"a\":1,}", "[[]] false", "01", "1.", "1e+", "\"\n\""] {
            XCTAssertThrowsError(try scan(text), text)
        }
        _ = try scan("{\"a\":[{},[true,false,null]]}")
    }

    func testLexemesAndPresence() throws {
        let result = try scan(#"{"present":null,"n":1.00e+02}"#)
        XCTAssertEqual(result.nodes.count, 3)
        guard case .null = result.nodes[1].value, case .number(let number) = result.nodes[2].value else {
            return XCTFail("values lost")
        }
        XCTAssertEqual(number, "1.00e+02")
        XCTAssertFalse(result.nodes.contains { $0.key == "absent" })
    }

    func testByteLimitAndDeepNesting() throws {
        let max = RawJSONScanner.maximumBytes
        var input = Data(repeating: 0x20, count: max)
        input[0] = 0x30
        _ = try RawJSONScanner.scan(input)
        input.append(0x20)
        XCTAssertThrowsError(try RawJSONScanner.scan(input)) { XCTAssertEqual($0 as? RawJSONError, .tooLarge) }
        let depth = 20_000
        _ = try scan(String(repeating: "[", count: depth) + "0" + String(repeating: "]", count: depth))
    }

    func testSharedRawValidationVectors() throws {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "transfer-v1", withExtension: "json"))
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let vectors = try XCTUnwrap(fixture["vectors"] as? [String: Any])
        let validation = try XCTUnwrap(vectors["validation"] as? [[String: Any]])
        let raw = validation.filter { $0["raw"] is String }
        XCTAssertFalse(raw.isEmpty)
        for vector in raw {
            let text = try XCTUnwrap(vector["raw"] as? String)
            if vector["expected"] as? String == "duplicate_key" {
                XCTAssertThrowsError(try scan(text)) { XCTAssertEqual($0 as? RawJSONError, .duplicateKey) }
            } else {
                _ = try scan(text)
            }
        }
    }

    func testParentEncodingPreservesRootNilAndParentIndexZero() throws {
        let object = try scan(#"{"a":[1,{"b":2}],"c":0}"#)
        XCTAssertEqual(object.nodes.count, 6)
        XCTAssertNil(object.nodes[0].parent)
        XCTAssertEqual(object.nodes[1].parent, 0)
        XCTAssertEqual(object.nodes[2].parent, 1)
        XCTAssertEqual(object.nodes[3].parent, 1)
        XCTAssertEqual(object.nodes[4].parent, 3)
        XCTAssertEqual(object.nodes[5].parent, 0)
        XCTAssertEqual(object.nodes.map(\.key), [nil, "a", nil, nil, "b", "c"])

        let array = try scan("[[0],0]")
        XCTAssertEqual(array.nodes.count, 4)
        XCTAssertNil(array.nodes[0].parent)
        XCTAssertEqual(array.nodes[1].parent, 0)
        XCTAssertEqual(array.nodes[2].parent, 1)
        XCTAssertEqual(array.nodes[3].parent, 0)
    }

    func testDuplicateKeysUseDecodedScalarsWhileDistinctKeysAndLexemesRemainExact() throws {
        for text in [#"{"a":1,"\u0061":2}"#, #"{"é":1,"\u00e9":2}"#, #"{"😀":1,"\ud83d\ude00":2}"#] {
            XCTAssertThrowsError(try scan(text)) { XCTAssertEqual($0 as? RawJSONError, .duplicateKey) }
        }

        let distinct = "{\"a\":1,\"\\u0062\":2,\"é\":3,\"e\u{301}\":4,\"n\":1.00e+02,\"m\":100}"
        let result = try scan(distinct)
        XCTAssertEqual(result.nodes.count, 7)
        XCTAssertEqual(result.nodes[1].key, "a")
        XCTAssertEqual(result.nodes[2].key, "b")
        let firstKey = Data(try XCTUnwrap(result.nodes[3].key).utf8)
        let secondKey = Data(try XCTUnwrap(result.nodes[4].key).utf8)
        XCTAssertEqual(firstKey, Data("é".utf8))
        XCTAssertEqual(secondKey, Data("e\u{301}".utf8))
        XCTAssertNotEqual(firstKey, secondKey)
        guard case .number(let scientific) = result.nodes[5].value,
              case .number(let plain) = result.nodes[6].value else {
            return XCTFail("number lexemes lost")
        }
        XCTAssertEqual(scientific, "1.00e+02")
        XCTAssertEqual(plain, "100")
        XCTAssertEqual(result.nodes[5].parent, 0)
        XCTAssertEqual(result.nodes[6].parent, 0)
    }

    func testDuplicateAndSyntaxChecksContinuePastTransferSchemaArrayLimits() {
        // Transfer v1 caps playlists, videos and history at 5,000, 50,000 and
        // 100,000 entries. The scanner owns no schema counts and must still
        // inspect the trailing value instead of short-circuiting at a limit.
        // Null-only rows keep the largest input near 0.5 MB: this is a control
        // flow check, not a memory-stress test.
        for limit in [5_000, 50_000, 100_000] {
            let prefix = "[" + String(repeating: "null,", count: limit)
            XCTAssertThrowsError(try scan(prefix + #"{"x":1,"\u0078":2}]"#)) {
                XCTAssertEqual($0 as? RawJSONError, .duplicateKey)
            }
            XCTAssertThrowsError(try scan(prefix + "]")) {
                XCTAssertEqual($0 as? RawJSONError, .invalidJSON)
            }
        }
    }

    func testByteLimitPrecedesUTF8AndJSONValidation() {
        let maximum = RawJSONScanner.maximumBytes
        var overLimit = Data(repeating: 0xff, count: maximum + 1)
        XCTAssertThrowsError(try RawJSONScanner.scan(overLimit)) {
            XCTAssertEqual($0 as? RawJSONError, .tooLarge)
        }
        overLimit[0] = 0xef
        overLimit[1] = 0xbb
        overLimit[2] = 0xbf
        XCTAssertThrowsError(try RawJSONScanner.scan(overLimit)) {
            XCTAssertEqual($0 as? RawJSONError, .tooLarge)
        }
        overLimit = Data(repeating: 0x7b, count: maximum + 1)
        XCTAssertThrowsError(try RawJSONScanner.scan(overLimit)) {
            XCTAssertEqual($0 as? RawJSONError, .tooLarge)
        }
    }

    func testParentEncodingAcrossScaledBroadAndDeepDocuments() throws {
        let width = 5_001
        let wide = try scan("[" + String(repeating: "0,", count: width - 1) + "0]")
        XCTAssertEqual(wide.nodes.count, width + 1)
        XCTAssertNil(wide.nodes[0].parent)
        XCTAssertEqual(wide.nodes[1].parent, 0)
        XCTAssertEqual(wide.nodes[width].parent, 0)
        XCTAssertTrue(wide.nodes.dropFirst().allSatisfy { $0.parent == 0 })

        let depth = 65_537
        let deep = try scan(String(repeating: "[", count: depth) + "0" + String(repeating: "]", count: depth))
        XCTAssertEqual(deep.nodes.count, depth + 1)
        XCTAssertNil(deep.nodes[0].parent)
        XCTAssertEqual(deep.nodes[1].parent, 0)
        XCTAssertEqual(deep.nodes[depth].parent, depth - 1)
        XCTAssertGreaterThan(depth - 1, Int(UInt16.max))
    }

    func testMaximumBytesLeavesParentEncodingHeadroom() {
        XCTAssertLessThan(RawJSONScanner.maximumBytes, Int(UInt32.max))
    }

    func testSameKeyInDifferentObjectsAndUnvalidatedNumericLexemesRemainExact() throws {
        let result = try scan(
            #"{"first":{"x":1},"second":{"x":2},"negativeZero":-0,"unsafeInteger":9007199254740993}"#)
        XCTAssertEqual(result.nodes.count, 7)
        XCTAssertEqual(result.nodes[2].key, "x")
        XCTAssertEqual(result.nodes[4].key, "x")
        XCTAssertEqual(result.nodes[2].parent, 1)
        XCTAssertEqual(result.nodes[4].parent, 3)
        guard case .number(let negativeZero) = result.nodes[5].value,
              case .number(let unsafeInteger) = result.nodes[6].value else {
            return XCTFail("number lexemes lost")
        }
        XCTAssertEqual(negativeZero, "-0")
        XCTAssertEqual(unsafeInteger, "9007199254740993")
    }

    func testRawJSONErrorsPrecedeEnvelopeVersionAndPlaylistCount() {
        // A v1-like envelope with version 2 and 5,001 playlist entries. The
        // first trailing object carries both a decoded duplicate key and an
        // unpaired surrogate; duplicate-key detection wins before that value is
        // read. A second object carries only the surrogate. The scanner must
        // report these raw errors before any envelope, version or count logic;
        // this does not exercise a schema validator.
        let playlists = "[" + String(repeating: "{},", count: 5_000)
        let prefix = #"{"format":"tubeshuffle-transfer","version":2,"exportedAt":"2026-10-28T00:00:00.000Z","playlists":"# + playlists
        let suffix = #"],"videos":[],"history":[]}"#
        XCTAssertThrowsError(try scan(prefix + #"{"id":"x","\u0069d":"\ud800"}"# + suffix)) {
            XCTAssertEqual($0 as? RawJSONError, .duplicateKey)
        }
        XCTAssertThrowsError(try scan(prefix + #"{"id":"\ud800"}"# + suffix)) {
            XCTAssertEqual($0 as? RawJSONError, .invalidJSON)
        }
    }

    // Exact pre-change Node layout; only the parent representation changed.
    private struct PreviousNodeLayout {
        let parent: Int?
        let key: String?
        let value: RawJSONDocument.Node.Value
    }

    func testNodeStrideIsNotLargerThanPreviousParentLayout() {
        let current = MemoryLayout<RawJSONDocument.Node>.stride
        let previous = MemoryLayout<PreviousNodeLayout>.stride
        print("RawJSONDocument.Node stride: current=\(current) previous=\(previous)")
        XCTAssertLessThanOrEqual(
            current,
            previous,
            "node stride grew: current \(current), previous \(previous)")
        // This only reports raw strides and asserts no growth. Whether current
        // is smaller must be read from the Mac output before claiming measured
        // savings; this is not a total document bound or import readiness.
    }
}
