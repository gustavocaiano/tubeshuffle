import Foundation
import XCTest

// A test-only decision model, not production integration. Inputs are complete,
// already-classified snapshots; a caller must not infer ownership from a prefix.
// This does not provide filesystem atomicity, signing/access-group proof, a
// cross-process lock, crash safety, or any Keychain/file operation. Even equal
// snapshots can become stale before a caller acts. Cooperative multi-instance
// coordination and durable, exclusive writes must be proven separately.
private enum NamespaceReservation {
    enum Anchor: Equatable {
        case absent
        case pending(String)
        case committed(String)
        case malformed
        case unavailable
    }

    enum Namespace: Equatable {
        case empty
        // Exactly one validated marker and no other items. A prefixed value is
        // not sufficient to classify a marker as valid.
        case marker(String)
        case foreignItems
        case malformed
        case unavailable
    }

    enum Decision: Equatable {
        case reservePending(String)
        case commit(String)
        case allow
        case failClosed
    }

    static func decide(anchor: Anchor, namespace: Namespace, proposedNonce: String?) -> Decision {
        switch (anchor, namespace) {
        case (.absent, .empty):
            guard let nonce = proposedNonce, !nonce.isEmpty else { return .failClosed }
            return .reservePending(nonce)
        case let (.pending(anchorNonce), .marker(markerNonce)):
            guard !anchorNonce.isEmpty, anchorNonce.utf8.elementsEqual(markerNonce.utf8) else { return .failClosed }
            return .commit(anchorNonce)
        case let (.committed(anchorNonce), .marker(markerNonce)):
            guard !anchorNonce.isEmpty, anchorNonce.utf8.elementsEqual(markerNonce.utf8) else { return .failClosed }
            return .allow
        default:
            return .failClosed
        }
    }
}

final class NamespaceReservationDecisionTests: XCTestCase {
    private typealias Model = NamespaceReservation

    func testReservationCommitAndAllowAcrossRestarts() {
        let nonce = "fixed-nonce"
        XCTAssertEqual(Model.decide(anchor: .absent, namespace: .empty, proposedNonce: nonce), .reservePending(nonce))
        // Restart after pending is recorded but before the marker exists: no
        // automatic retry, replacement, or cleanup is authorized by this model.
        XCTAssertEqual(Model.decide(anchor: .pending(nonce), namespace: .empty, proposedNonce: "other"), .failClosed)
        XCTAssertEqual(Model.decide(anchor: .pending(nonce), namespace: .marker(nonce), proposedNonce: nil), .commit(nonce))
        // A restart after marker creation but before commit can propose commit again.
        XCTAssertEqual(Model.decide(anchor: .pending(nonce), namespace: .marker(nonce), proposedNonce: nil), .commit(nonce))
        XCTAssertEqual(Model.decide(anchor: .committed(nonce), namespace: .marker(nonce), proposedNonce: nil), .allow)
        XCTAssertEqual(Model.decide(anchor: .committed(nonce), namespace: .empty, proposedNonce: nonce), .failClosed)
    }

    func testCollisionAndMalformedInputsFailClosed() {
        let anchors: [Model.Anchor] = [.absent, .pending("a"), .committed("a"), .malformed, .unavailable]
        let invalidNamespaces: [Model.Namespace] = [.foreignItems, .malformed, .unavailable]
        for anchor in anchors {
            for namespace in invalidNamespaces {
                XCTAssertEqual(Model.decide(anchor: anchor, namespace: namespace, proposedNonce: "a"), .failClosed)
            }
        }
        for anchor in anchors {
            XCTAssertEqual(Model.decide(anchor: anchor, namespace: .marker("b"), proposedNonce: "a"), .failClosed)
        }
        XCTAssertEqual(Model.decide(anchor: .pending(""), namespace: .marker(""), proposedNonce: nil), .failClosed)
        XCTAssertEqual(Model.decide(anchor: .committed(""), namespace: .marker(""), proposedNonce: nil), .failClosed)
        XCTAssertEqual(Model.decide(anchor: .absent, namespace: .empty, proposedNonce: nil), .failClosed)
        XCTAssertEqual(Model.decide(anchor: .absent, namespace: .empty, proposedNonce: ""), .failClosed)
        XCTAssertEqual(Model.decide(anchor: .malformed, namespace: .empty, proposedNonce: "a"), .failClosed)
        XCTAssertEqual(Model.decide(anchor: .unavailable, namespace: .empty, proposedNonce: "a"), .failClosed)
        XCTAssertEqual(Model.decide(anchor: .pending("é"), namespace: .marker("e\u{301}"), proposedNonce: nil), .failClosed)
    }

    func testPrefixedForeignMarkerIsNotOwnership() {
        // A prefix or plausible payload is not authority to classify an item as
        // the unique, validated marker. The decision API has no mutation action.
        let prefixedForeign = Data("TubeShuffle.NativeCredential.v1\0foreign".utf8)
        XCTAssertTrue(prefixedForeign.starts(with: Data("TubeShuffle.NativeCredential.v1\0".utf8)))
        XCTAssertEqual(Model.decide(anchor: .absent, namespace: .foreignItems, proposedNonce: "a"), .failClosed)
        XCTAssertEqual(Model.decide(anchor: .committed("a"), namespace: .foreignItems, proposedNonce: nil), .failClosed)
    }

    func testCompetingReservationsAreOnlyProposals() {
        // Two independent readers of the same empty snapshot can both propose
        // reservation. This model does not elect a winner or serialize writes.
        XCTAssertEqual(Model.decide(anchor: .absent, namespace: .empty, proposedNonce: "a"), .reservePending("a"))
        XCTAssertEqual(Model.decide(anchor: .absent, namespace: .empty, proposedNonce: "b"), .reservePending("b"))
        XCTAssertEqual(Model.decide(anchor: .pending("a"), namespace: .marker("b"), proposedNonce: nil), .failClosed)
        XCTAssertEqual(Model.decide(anchor: .committed("a"), namespace: .marker("b"), proposedNonce: nil), .failClosed)
    }
}
