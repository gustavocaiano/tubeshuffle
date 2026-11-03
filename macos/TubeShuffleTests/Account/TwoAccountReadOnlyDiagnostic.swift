#if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
import Foundation
@testable import TubeShuffle

// Test-target only. Constructing this type never starts authentication or network
// traffic. A future live caller needs separate authorization and reviewed wiring.
protocol DiagnosticTransport {
    func get(_ request: URLRequest) async throws -> (Data, URLResponse)
}

final class DiagnosticEphemeralTransport: DiagnosticTransport {
    private let session: URLSession
    static let limit = 16_384

    init(protocolClasses: [AnyClass]? = nil) {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.urlCredentialStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 30
        if let protocolClasses { config.protocolClasses = protocolClasses }
        session = URLSession(configuration: config, delegate: DiagnosticNoRedirect(), delegateQueue: nil)
    }

    deinit { session.invalidateAndCancel() }

    func get(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let (bytes, response) = try await session.bytes(for: request)
        try Task.checkCancellation()
        guard response.expectedContentLength <= Int64(Self.limit) else { throw DiagnosticInternalFailure.invalid }
        var data = Data()
        for try await byte in bytes {
            try Task.checkCancellation()
            guard data.count < Self.limit else { throw DiagnosticInternalFailure.invalid }
            data.append(byte)
        }
        return (data, response)
    }
}

private final class DiagnosticNoRedirect: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) { completionHandler(nil) }
}

private enum DiagnosticInternalFailure: Error { case invalid, revoked }

@MainActor
final class TwoAccountReadOnlyDiagnostic {
    enum Outcome: Equatable {
        case linkedAccountInconclusive, rowIsolationInconclusive, rowIsolationFailure
        case confirmedLinkedAccountsAndSelectedOwnerRowHiddenFromSecondAccount
        case sameIdentity, ownerCheckFailed, nonOwnerCheckFailed
        case invalidCredential, unavailable, cancelled, busy
    }

    // No caller-supplied URL, path, method, query, or privileged key.
    private static let origin = "https://rkgbxjwmnlsmguhctguf.supabase.co"
    private let transport: any DiagnosticTransport
    private var generation = UUID()
    private var running = false
    private var inFlight: Task<Outcome, Never>?

    init(transport: any DiagnosticTransport) { self.transport = transport }

    // Cancellation is cooperative; generation fencing also rejects late results.
    // No credentials, identities, or rows are retained as object state.
    func revoke() { generation = UUID(); inFlight?.cancel() }

    func verify(ownerToken: String, secondToken: String, publishableKey: String) async -> Outcome {
        guard !running else { return .busy }
        guard Self.validToken(ownerToken), Self.validToken(secondToken), publishableKey.utf8.count == 46,
              Array(publishableKey.utf8)[37] == 95,
              TransientSupabaseAccount.validPublishableKey(publishableKey) else { return .invalidCredential }
        running = true
        let epoch = generation
        let task = Task { @MainActor in
            await self.perform(ownerToken: ownerToken, secondToken: secondToken, publishableKey: publishableKey, epoch: epoch)
        }
        inFlight = task
        defer { inFlight = nil; running = false }
        return await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func perform(ownerToken: String, secondToken: String, publishableKey: String, epoch: UUID) async -> Outcome {
        do {
            let owner = try await identity(ownerToken, publishableKey, epoch)
            let second = try await identity(secondToken, publishableKey, epoch)
            guard owner != second else { return .sameIdentity }
            guard try await approved(ownerToken, publishableKey, epoch) else { return .ownerCheckFailed }
            let secondApproved = try await approved(secondToken, publishableKey, epoch)
            guard !secondApproved else { return .nonOwnerCheckFailed }
            let ownerRows = try await rows(ownerToken, publishableKey, epoch)
            let secondRows = try await rows(secondToken, publishableKey, epoch)
            guard ownerRows.allSatisfy({ $0.user_id == owner }) else { return .rowIsolationInconclusive }
            // Any row returned to the second account fails this conservative check.
            if !secondRows.isEmpty { return .rowIsolationFailure }
            // These account properties do not establish the provider used by either
            // current session, or that Google verified the Supabase email.
            // This single limited read does not establish general RLS isolation or
            // whether the owner can read other users' rows.
            return ownerRows.isEmpty ? .rowIsolationInconclusive : .confirmedLinkedAccountsAndSelectedOwnerRowHiddenFromSecondAccount
        } catch {
            if Task.isCancelled || epoch != generation || error is CancellationError { return .cancelled }
            if error is IdentityEvidenceFailure { return .linkedAccountInconclusive }
            if error is RowEvidenceFailure { return .rowIsolationInconclusive }
            return .unavailable
        }
    }

    private func check(_ epoch: UUID) throws {
        try Task.checkCancellation()
        guard epoch == generation else { throw DiagnosticInternalFailure.revoked }
    }

    private func request(_ path: String, _ token: String, _ key: String, _ epoch: UUID) async throws -> Data {
        try check(epoch)
        guard let url = URL(string: Self.origin + path) else { throw DiagnosticInternalFailure.invalid }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.httpShouldHandleCookies = false
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(key, forHTTPHeaderField: "apikey")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let (data, response) = try await transport.get(request)
        try check(epoch)
        guard data.count <= DiagnosticEphemeralTransport.limit,
              let http = response as? HTTPURLResponse, http.statusCode == 200,
              http.url == url else { throw DiagnosticInternalFailure.invalid }
        return data
    }

    private enum IdentityEvidenceFailure: Error { case inconclusive }
    // Decode the raw endpoint response: SDK user models can default a missing
    // is_anonymous field to false, which is not evidence of a nonanonymous user.
    private struct User: Decodable {
        struct Identity: Decodable {
            let provider: String
            let user_id: UUID
        }
        let id: UUID
        let is_anonymous: Bool
        let email: String
        let email_confirmed_at: String
        let identities: [Identity]
    }
    private enum RowEvidenceFailure: Error { case inconclusive }
    private struct Row: Decodable { let youtube_playlist_id: String; let user_id: UUID }
    private func identity(_ token: String, _ key: String, _ epoch: UUID) async throws -> UUID {
        let data = try await request("/auth/v1/user", token, key, epoch)
        guard let user = try? JSONDecoder().decode(User.self, from: data),
              !user.is_anonymous,
              Self.validEmailShape(user.email),
              Self.validConfirmationTimestamp(user.email_confirmed_at),
              !user.identities.isEmpty,
              user.identities.allSatisfy({ !$0.provider.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.user_id == user.id }),
              user.identities.contains(where: { $0.provider == "google" }) else {
            throw IdentityEvidenceFailure.inconclusive
        }
        return user.id
    }
    private static func validEmailShape(_ value: String) -> Bool {
        // Conservative ASCII dot-atom/address shape, not proof of deliverability,
        // provider verification, or a complete implementation of email syntax.
        guard value.utf8.count <= 254 else { return false }
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].utf8.count <= 64 else { return false }
        let local = parts[0].split(separator: ".", omittingEmptySubsequences: false)
        let domain = parts[1].split(separator: ".", omittingEmptySubsequences: false)
        let alphaNumeric: (UInt8) -> Bool = { (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) }
        guard !local.contains(where: { $0.isEmpty }), domain.count >= 2 else { return false }
        return local.allSatisfy { part in
            part.utf8.allSatisfy { alphaNumeric($0) || "!#$%&'*+-/=?^_`{|}~".utf8.contains($0) }
        } && domain.allSatisfy { label in
            let bytes = Array(label.utf8)
            return !bytes.isEmpty && bytes.count <= 63 && alphaNumeric(bytes[0]) && alphaNumeric(bytes[bytes.count - 1]) &&
                bytes.allSatisfy { alphaNumeric($0) || $0 == 45 }
        }
    }
    private static func validConfirmationTimestamp(_ value: String) -> Bool {
        // Restrict Foundation's permissive parser to a complete RFC3339 timestamp
        // and reject normalized invalid dates (such as February 30).
        let pattern = #"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)),
              match.range.length == value.utf16.count else { return false }
        let parts = (1...6).compactMap { index -> Int? in
            guard let range = Range(match.range(at: index), in: value) else { return nil }
            return Int(value[range])
        }
        guard parts.count == 6, parts[0] > 0, (1...12).contains(parts[1]),
              (0...23).contains(parts[3]), (0...59).contains(parts[4]), (0...59).contains(parts[5]) else { return false }
        if !value.hasSuffix("Z") {
            let offset = value.suffix(5).split(separator: ":")
            guard offset.count == 2, let hours = Int(offset[0]), let minutes = Int(offset[1]),
                  (0...23).contains(hours), (0...59).contains(minutes) else { return false }
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        guard let month = calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: 1)),
              let days = calendar.range(of: .day, in: .month, for: month), days.contains(parts[2]) else { return false }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = value.contains(".") ? [.withInternetDateTime, .withFractionalSeconds] : [.withInternetDateTime]
        return formatter.date(from: value) != nil
    }
    private func approved(_ token: String, _ key: String, _ epoch: UUID) async throws -> Bool {
        try JSONDecoder().decode(Bool.self, from: await request("/rest/v1/rpc/is_approved_owner", token, key, epoch))
    }
    private func rows(_ token: String, _ key: String, _ epoch: UUID) async throws -> [Row] {
        let data = try await request("/rest/v1/playlist_links?select=youtube_playlist_id,user_id&limit=1", token, key, epoch)
        guard let rows = try? JSONDecoder().decode([Row].self, from: data) else { throw RowEvidenceFailure.inconclusive }
        guard rows.count <= 1, rows.allSatisfy({ row in
            let bytes = Array(row.youtube_playlist_id.utf8)
            return (10...80).contains(bytes.count) && bytes.allSatisfy {
                (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
            }
        }) else { throw RowEvidenceFailure.inconclusive }
        return rows
    }
    private static func validToken(_ token: String) -> Bool {
        let bytes = Array(token.utf8)
        guard !bytes.isEmpty, bytes.count <= 8192 else { return false }
        let core = bytes.prefix { $0 != 61 }
        return !core.isEmpty && core.allSatisfy {
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 95, 126, 43, 47].contains($0)
        } && bytes.dropFirst(core.count).allSatisfy { $0 == 61 }
    }
}
#endif
