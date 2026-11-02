import Foundation

/// Validates only the callback's syntax and destination. The caller must bind it
/// to one outstanding flow, prevent replay, and never log the URL or code.
/// The input String may already have been normalized by Foundation or the browser
/// callback; this validator cannot establish the original URL bytes. The flow,
/// replay protection, and provider parameters (including this parser's allowlist)
/// must be verified in a real integration before use.
/// Exchange the returned code directly; Supabase Swift 2.55.5's session(from:)
/// logs the callback URL and may include provider-supplied text in errors.
struct TransientOAuthCallback {
    enum ValidationError: Error, Equatable {
        case invalidRedirectConfiguration
        case invalidCallback
        case providerError
    }

    private let scheme: String
    private let host: String
    private let path: String
    private let correlationKey: String?

    init(redirect: String, correlationKey: String? = nil) throws {
        guard let parts = Self.destination(redirect), parts.query == nil else {
            throw ValidationError.invalidRedirectConfiguration
        }
        guard correlationKey == nil || correlationKey == "flow_correlation" else {
            throw ValidationError.invalidRedirectConfiguration
        }
        scheme = parts.scheme.lowercased()
        host = parts.host.lowercased()
        path = parts.path
        self.correlationKey = correlationKey
    }

    func code(from callback: String) throws -> String {
        let parameters = try parse(callback)
        if parameters["error"] != nil || parameters["error_description"] != nil || parameters["error_code"] != nil {
            throw ValidationError.providerError
        }
        guard let code = parameters["code"], !code.isEmpty else {
            throw ValidationError.invalidCallback
        }
        return code
    }

    func correlation(from callback: String) throws -> String {
        guard let key = correlationKey, let value = try parse(callback)[key], !value.isEmpty else {
            throw ValidationError.invalidCallback
        }
        return value
    }

    #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
    // Observation only, invoked after rejection. Never return callback data.
    enum RejectionCategory: String {
        case fragment = "rejection_fragment_present"
        case destination = "rejection_destination_mismatch_or_malformed"
        case queryMissing = "rejection_query_missing"
        case unknownOrDuplicate = "rejection_unknown_or_duplicate_keys"
        case malformedEncoding = "rejection_malformed_encoding"
        case correlationAbsent = "rejection_correlation_absent"
        case codeAbsent = "rejection_code_absent"
        case other = "rejection_other"
    }

    // Temporary shape-only probe: examine parameter names, never their values.
    enum ParameterShape {
        case empty, providerError, token, mixed, other
    }

    func rejectedFragmentShapes(_ callback: String) -> (query: ParameterShape, fragment: ParameterShape)? {
        guard let hash = callback.firstIndex(of: "#") else { return nil }
        let beforeFragment = callback[..<hash]
        let query = beforeFragment.firstIndex(of: "?").map { beforeFragment[beforeFragment.index(after: $0)...] }
        let fragment = callback[callback.index(after: hash)...]
        func shape(_ component: Substring?) -> ParameterShape {
            guard let component, !component.isEmpty else { return .empty }
            var hasError = false, hasToken = false
            for item in component.split(separator: "&", omittingEmptySubsequences: false) {
                let keyPart = item.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
                guard let key = Self.decode(String(keyPart)) else { continue }
                if ["error", "error_description", "error_code"].contains(key) { hasError = true }
                if ["access_token", "refresh_token", "id_token", "token_type", "expires_in", "expires_at"].contains(key) { hasToken = true }
            }
            if hasError && hasToken { return .mixed }
            if hasError { return .providerError }
            if hasToken { return .token }
            return .other
        }
        return (shape(query), shape(fragment))
    }

    func rejectionCategory(_ callback: String) -> RejectionCategory {
        if callback.contains("#") { return .fragment }
        let pieces = callback.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        guard let target = Self.destination(String(pieces[0])),
              target.scheme.lowercased() == scheme, target.host.lowercased() == host,
              target.path.utf8.elementsEqual(path.utf8) else { return .destination }
        guard pieces.count == 2, !pieces[1].isEmpty else { return .queryMissing }
        let query = String(pieces[1])
        guard Self.validComponent(query, path: false) else { return .malformedEncoding }
        var keys = Set<String>()
        var correlationPresent = false
        var codePresent = false
        var providerErrorPresent = false
        for item in query.split(separator: "&", omittingEmptySubsequences: false) {
            let pair = item.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2, let key = Self.decode(String(pair[0])) else { return .other }
            guard (["code", "error", "error_description", "error_code"].contains(key) || key == correlationKey),
                  keys.insert(key).inserted else { return .unknownOrDuplicate }
            if key == correlationKey { correlationPresent = !pair[1].isEmpty }
            if key == "code" { codePresent = !pair[1].isEmpty }
            if ["error", "error_description", "error_code"].contains(key) { providerErrorPresent = true }
        }
        if correlationKey != nil && !correlationPresent { return .correlationAbsent }
        if !providerErrorPresent && !codePresent { return .codeAbsent }
        return .other
    }
    #endif

    private func parse(_ callback: String) throws -> [String: String] {
        // A callback may carry one empty fragment delimiter. Leave every other
        // byte untouched; destination still rejects any remaining literal '#'.
        let target = callback.hasSuffix("#") ? String(callback.dropLast()) : callback
        guard let parts = Self.destination(target),
              parts.scheme.lowercased() == scheme,
              parts.host.lowercased() == host,
              parts.path.utf8.elementsEqual(path.utf8),
              let query = parts.query, !query.isEmpty else {
            throw ValidationError.invalidCallback
        }

        var parameters: [String: String] = [:]
        for item in query.split(separator: "&", omittingEmptySubsequences: false) {
            let pair = item.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pair.count == 2,
                  let key = Self.decode(String(pair[0])),
                  let value = Self.decode(String(pair[1])),
                  (["code", "error", "error_description", "error_code"].contains(key) || key == correlationKey),
                  parameters[key] == nil else {
                throw ValidationError.invalidCallback
            }
            parameters[key] = value
        }
        if let key = correlationKey, parameters[key]?.isEmpty != false {
            throw ValidationError.invalidCallback
        }
        return parameters
    }

    private struct Destination {
        let scheme: String
        let host: String
        let path: String
        let query: String?
    }

    // Parse the supplied string, not URLComponents: Foundation can repair bad
    // percent escapes before validation. It may already have been normalized upstream.
    // Only an ASCII DNS-style host is allowed.
    private static func destination(_ raw: String) -> Destination? {
        guard !raw.contains("#"), let separator = raw.range(of: "://") else { return nil }
        let scheme = String(raw[..<separator.lowerBound])
        let schemeBytes = Array(scheme.utf8)
        guard let first = schemeBytes.first, isLetter(first),
              schemeBytes.allSatisfy({ isLetter($0) || isDigit($0) || [43, 45, 46].contains($0) }) else { return nil }
        let rest = raw[separator.upperBound...]
        let hostEnd = rest.firstIndex(where: { $0 == "/" || $0 == "?" }) ?? rest.endIndex
        let host = String(rest[..<hostEnd])
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard labels.allSatisfy({ label in
            guard let first = label.utf8.first, let last = label.utf8.last,
                  first != 45, last != 45 else { return false }
            return label.utf8.allSatisfy { isLetter($0) || isDigit($0) || $0 == 45 }
        }) else { return nil }
        let remainder = rest[hostEnd...]
        let queryIndex = remainder.firstIndex(of: "?")
        let path = String(queryIndex.map { remainder[..<$0] } ?? remainder[...])
        let query = queryIndex.map { String(remainder[remainder.index(after: $0)...]) }
        guard (path.isEmpty || path.hasPrefix("/")), validComponent(path, path: true),
              let decodedPath = decode(path),
              !decodedPath.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == "." || $0 == ".." }),
              query.map({ validComponent($0, path: false) }) ?? true else { return nil }
        return Destination(scheme: scheme, host: host, path: path, query: query)
    }

    private static func isLetter(_ byte: UInt8) -> Bool {
        (65...90).contains(byte) || (97...122).contains(byte)
    }

    private static func isDigit(_ byte: UInt8) -> Bool { (48...57).contains(byte) }

    private static func validComponent(_ raw: String, path: Bool) -> Bool {
        // RFC 3986 pchar plus '/' (and '?' for query). Percent-encoded UTF-8
        // is checked by decode; literal non-ASCII is deliberately not repaired.
        let allowed = Array("-._~!$&'()*+,;=:@/".utf8) + (path ? [] : [63])
        let bytes = Array(raw.utf8)
        var index = 0
        while index < bytes.count {
            let byte = bytes[index]
            if byte == 37 {
                guard index + 2 < bytes.count, isHex(bytes[index + 1]), isHex(bytes[index + 2]) else { return false }
                index += 3
            } else {
                guard isLetter(byte) || isDigit(byte) || allowed.contains(byte) else { return false }
                index += 1
            }
        }
        return decode(raw) != nil
    }

    private static func isHex(_ byte: UInt8) -> Bool {
        isDigit(byte) || (65...70).contains(byte) || (97...102).contains(byte)
    }

    private static func decode(_ raw: String) -> String? {
        guard let value = raw.removingPercentEncoding,
              !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        return value
    }
}
