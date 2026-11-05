import Foundation
import XCTest
@testable import TubeShuffle

final class RevocableSessionMemoryTests: XCTestCase {
    func testExactKeysReplacementAndRemoval() throws {
        let storage = RevocableSessionMemory()
        try storage.store(key: "key", value: Data([0, 255]))
        try storage.store(key: " key", value: Data())
        try storage.store(key: "KEY", value: Data([1]))
        XCTAssertEqual(try storage.retrieve(key: "key"), Data([0, 255]))
        XCTAssertEqual(try storage.retrieve(key: " key"), Data())
        XCTAssertEqual(try storage.retrieve(key: "KEY"), Data([1]))
        try storage.store(key: "key", value: Data([2]))
        XCTAssertEqual(try storage.retrieve(key: "key"), Data([2]))
        try storage.remove(key: "key")
        try storage.remove(key: "key")
        XCTAssertNil(try storage.retrieve(key: "key"))
        XCTAssertEqual(try storage.retrieve(key: " key"), Data())
    }

    func testCanonicallyEquivalentKeysRemainDistinct() throws {
        let storage = RevocableSessionMemory()
        let composed = "\u{00E9}"
        let decomposed = "e\u{0301}"
        XCTAssertEqual(composed, decomposed)
        XCTAssertNotEqual(Data(composed.utf8), Data(decomposed.utf8))

        try storage.store(key: composed, value: Data([1]))
        try storage.store(key: decomposed, value: Data([2]))
        XCTAssertEqual(try storage.retrieve(key: composed), Data([1]))
        XCTAssertEqual(try storage.retrieve(key: decomposed), Data([2]))
        try storage.remove(key: composed)
        XCTAssertNil(try storage.retrieve(key: composed))
        XCTAssertEqual(try storage.retrieve(key: decomposed), Data([2]))
        try storage.remove(key: decomposed)
        XCTAssertNil(try storage.retrieve(key: decomposed))
    }

    func testRevocationIsPermanentAndErrorIsSanitized() throws {
        let storage = RevocableSessionMemory()
        let key = "private-key-sentinel"
        let secret = "secret-value-sentinel"
        try storage.store(key: key, value: Data(secret.utf8))
        storage.revokeAndClear()
        storage.revokeAndClear()
        XCTAssertNil(try storage.retrieve(key: key))
        try storage.remove(key: key)
        XCTAssertThrowsError(try storage.store(key: key, value: Data(secret.utf8))) { error in
            XCTAssertEqual(error as? RevocableSessionMemory.StorageError, .revoked)
            let text = "\(error) \(String(reflecting: error)) \((error as NSError).localizedDescription)"
            XCTAssertFalse(text.contains(key))
            XCTAssertFalse(text.contains(secret))
        }
        XCTAssertNil(try storage.retrieve(key: key))
    }

    func testFreshInstanceIsIndependent() throws {
        let old = RevocableSessionMemory()
        let fresh = RevocableSessionMemory()
        try old.store(key: "same", value: Data([1]))
        try fresh.store(key: "same", value: Data([2]))
        old.revokeAndClear()
        XCTAssertNil(try old.retrieve(key: "same"))
        XCTAssertEqual(try fresh.retrieve(key: "same"), Data([2]))
        try fresh.store(key: "same", value: Data([3]))
        XCTAssertEqual(try fresh.retrieve(key: "same"), Data([3]))
    }

    func testConcurrentWritesAndRevokeCannotRepopulate() throws {
        let storage = RevocableSessionMemory()
        let iterations = 500
        // Each writer owns a distinct key; all have completed when this returns.
        DispatchQueue.concurrentPerform(iterations: iterations + 1) { index in
            if index == iterations {
                storage.revokeAndClear()
            } else {
                try? storage.store(key: "key-\(index)", value: Data([1]))
            }
        }
        for index in 0..<iterations {
            let key = "key-\(index)"
            XCTAssertNil(try storage.retrieve(key: key))
            XCTAssertThrowsError(try storage.store(key: key, value: Data([2])))
        }
    }
}
