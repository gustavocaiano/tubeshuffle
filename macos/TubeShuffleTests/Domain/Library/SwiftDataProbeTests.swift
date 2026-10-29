import Foundation
import SwiftData
import XCTest

// This model is deliberately confined to the test target and its disposable store.
@Model
final class SwiftDataProbeRecord {
    @Attribute(.unique) var key: String
    var payload: String

    init(key: String, payload: String) {
        self.key = key
        self.payload = payload
    }
}

final class SwiftDataProbeTests: XCTestCase {
    private enum SyntheticFailure: Error { case beforeSave }

    private func hexKey(_ id: String) -> String {
        id.utf8.map { String(format: "%02x", $0) }.joined()
    }

    private func withStore(_ body: (URL) throws -> Void) throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TubeShuffle-SwiftDataProbe-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        try body(directory.appendingPathComponent("probe.store"))
    }

    // Each invocation owns its container and context; neither escapes the autorelease pool.
    private func withContext(_ url: URL, _ body: (ModelContext) throws -> Void) throws {
        try autoreleasepool {
            let schema = Schema([SwiftDataProbeRecord.self])
            let configuration = ModelConfiguration("Probe", schema: schema, url: url, cloudKitDatabase: .none)
            let container = try ModelContainer(for: schema, configurations: [configuration])
            let context = ModelContext(container)
            context.autosaveEnabled = false
            try body(context)
        }
    }

    private func contents(_ url: URL) throws -> [String: String] {
        var result: [String: String] = [:]
        try withContext(url) { context in
            let records = try context.fetch(FetchDescriptor<SwiftDataProbeRecord>())
            XCTAssertEqual(records.count, Set(records.map(\.key)).count)
            for record in records { result[record.key] = record.payload }
        }
        return result
    }

    func testDistinctUnicodeByteKeysSurviveReopen() throws {
        let composed = hexKey("\u{e9}")
        let decomposed = hexKey("e\u{301}")
        XCTAssertEqual(composed, "c3a9")
        XCTAssertEqual(decomposed, "65cc81")
        XCTAssertNotEqual(composed, decomposed)
        try withStore { url in
            try withContext(url) { context in
                context.insert(SwiftDataProbeRecord(key: composed, payload: "composed"))
                context.insert(SwiftDataProbeRecord(key: decomposed, payload: "decomposed"))
                try context.save()
            }
            XCTAssertEqual(try contents(url), [composed: "composed", decomposed: "decomposed"])
        }
    }

    func testSyntheticFailureBeforeSaveRollsBackBaseline() throws {
        try withStore { url in
            try withContext(url) { context in
                context.insert(SwiftDataProbeRecord(key: "baseline", payload: "original"))
                try context.save()
            }
            try withContext(url) { context in
                let record = try XCTUnwrap(context.fetch(FetchDescriptor<SwiftDataProbeRecord>()).first)
                do {
                    record.payload = "changed"
                    context.insert(SwiftDataProbeRecord(key: "new", payload: "unsaved"))
                    throw SyntheticFailure.beforeSave
                } catch SyntheticFailure.beforeSave {
                    context.rollback()
                }
            }
            XCTAssertEqual(try contents(url), ["baseline": "original"])
        }
    }

    func testSuccessfulMutationSurvivesReopen() throws {
        try withStore { url in
            try withContext(url) { context in
                context.insert(SwiftDataProbeRecord(key: "baseline", payload: "original"))
                try context.save()
            }
            try withContext(url) { context in
                let record = try XCTUnwrap(context.fetch(FetchDescriptor<SwiftDataProbeRecord>()).first)
                record.payload = "changed"
                context.insert(SwiftDataProbeRecord(key: "new", payload: "saved"))
                try context.save()
            }
            XCTAssertEqual(try contents(url), ["baseline": "changed", "new": "saved"])
        }
    }
}
