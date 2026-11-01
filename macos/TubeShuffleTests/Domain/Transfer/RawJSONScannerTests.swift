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
}
