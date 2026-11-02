import Foundation
import XCTest
@testable import TubeShuffle

final class TransientOAuthCallbackTests: XCTestCase {
    #if DEBUG && LOCAL_OAUTH_DIAGNOSTIC
    func testTemporaryRejectionCategoriesAreFixedAndDoNotChangeValidation() throws {
        let base = "example-app://auth.example/callback"
        let validator = try TransientOAuthCallback(redirect: base, correlationKey: "flow_correlation")
        let cases: [(String, TransientOAuthCallback.RejectionCategory)] = [
            (base + "?code=x#fragment", .fragment),
            ("example-app://other.example/callback?code=x", .destination),
            (base, .queryMissing), (base + "?", .queryMissing),
            (base + "?unknown=secret", .unknownOrDuplicate),
            (base + "?code=x&code=y", .unknownOrDuplicate),
            (base + "?code=%ZZ", .malformedEncoding),
            (base + "?code=x", .correlationAbsent),
            (base + "?flow_correlation=x", .codeAbsent),
            (base + "?broken", .other)
        ]
        for (callback, category) in cases {
            XCTAssertEqual(validator.rejectionCategory(callback), category)
            XCTAssertThrowsError(try validator.code(from: callback))
        }
    }
    #endif
    private let redirect = "example-app://auth.example/callback"

    func testValidCodeAndCaseInsensitiveDestination() throws {
        let validator = try TransientOAuthCallback(redirect: redirect)
        XCTAssertEqual(try validator.code(from: "EXAMPLE-APP://AUTH.EXAMPLE/callback?code=a%2Bb%3Dc"), "a+b=c")
        XCTAssertEqual(try validator.code(from: "example-app://auth.example/callback?%63ode=%E2%98%83"), "☃")
        // '+' is a literal URI character, not form-encoded whitespace.
        XCTAssertEqual(try validator.code(from: "example-app://auth.example/callback?code=a+b"), "a+b")
    }

    func testInvalidConfiguration() {
        for raw in ["", "example-app:/callback", "example-app:///callback", "example-app://auth.example/callback?",
                    "example-app://auth.example/callback#", "example-app://user@auth.example/callback",
                    "example-app://auth.example:443/callback", "example-app://auth.example:/callback",
                    "example-app://auth.example/%GG", "example-app://auth.example/☃"] {
            XCTAssertThrowsError(try TransientOAuthCallback(redirect: raw), raw) {
                XCTAssertEqual($0 as? TransientOAuthCallback.ValidationError, .invalidRedirectConfiguration)
            }
        }
    }

    func testRejectsInvalidDNSLabelsInConfigurationAndCallback() throws {
        let validator = try TransientOAuthCallback(redirect: redirect)
        for host in [".", "..", ".example", "example.", "auth..example", "-auth.example", "auth-.example", "auth.-example", "auth.example-"] {
            let destination = "example-app://\(host)/callback"
            XCTAssertThrowsError(try TransientOAuthCallback(redirect: destination), host) {
                XCTAssertEqual($0 as? TransientOAuthCallback.ValidationError, .invalidRedirectConfiguration)
            }
            XCTAssertThrowsError(try validator.code(from: destination + "?code=x"), host) {
                XCTAssertEqual($0 as? TransientOAuthCallback.ValidationError, .invalidCallback)
            }
        }
        XCTAssertNoThrow(try TransientOAuthCallback(redirect: "example-app://a-b.example/callback"))
    }

    func testRejectsDotSegmentsInRedirectConfiguration() {
        for path in ["/.", "/..", "/a/./b", "/a/../b", "/%2e", "/%2E%2e", "/a/.%2e/b", "/a/%2e./b", "/a%2F%2e%2e%2Fb"] {
            XCTAssertThrowsError(try TransientOAuthCallback(redirect: "example-app://auth.example" + path), path) {
                XCTAssertEqual($0 as? TransientOAuthCallback.ValidationError, .invalidRedirectConfiguration)
            }
        }
        for path in ["/.well-known/callback", "/a...b", "/a%2Eb"] {
            XCTAssertNoThrow(try TransientOAuthCallback(redirect: "example-app://auth.example" + path), path)
        }
    }

    func testRejectsDestinationAndMalformedQuery() throws {
        let validator = try TransientOAuthCallback(redirect: redirect)
        for raw in ["other://auth.example/callback?code=x", "example-app://other/callback?code=x",
                    "example-app://auth.example/Callback?code=x", "example-app://auth.example/callback/?code=x",
                    "example-app://auth.example:443/callback?code=x", "example-app://auth.example:/callback?code=x",
                    "example-app://user@auth.example/callback?code=x", "example-app://auth.example/callback?code=x#",
                    "example-app://auth.example/callback", "example-app://auth.example/callback?code=",
                    "example-app://auth.example/callback?code", "example-app://auth.example/callback?code=x&",
                    "example-app://auth.example/callback?code=x&other=y",
                    "example-app://auth.example/callback?code=x&%63ode=y",
                    "example-app://auth.example/callback?code=%", "example-app://auth.example/callback?code=%0G",
                    "example-app://auth.example/callback?code=%FF", "example-app://auth.example/callback?code=%00",
                    "example-app://auth.example/callback?code=☃", "example-app://auth.example/callback?code=x y",
                    "example-app://auth.example/%63allback?code=x"] {
            XCTAssertThrowsError(try validator.code(from: raw), raw) {
                XCTAssertEqual($0 as? TransientOAuthCallback.ValidationError, .invalidCallback)
            }
        }
    }

    func testUnicodePathIsComparedAsExactEncodedBytes() throws {
        let validator = try TransientOAuthCallback(redirect: "example-app://auth.example/caf%C3%A9")
        XCTAssertEqual(try validator.code(from: "example-app://auth.example/caf%C3%A9?code=ok"), "ok")
        XCTAssertThrowsError(try validator.code(from: "example-app://auth.example/cafe%CC%81?code=ok"))
        XCTAssertThrowsError(try validator.code(from: "example-app://auth.example/caf%c3%a9?code=ok"))
    }

    func testProviderErrorsAreFixedAndSecretFree() throws {
        let validator = try TransientOAuthCallback(redirect: redirect)
        for query in ["error=secret-sentinel&error_description=private-sentinel&error_code=123",
                      "error_description=secret-sentinel", "error_code=secret-sentinel",
                      "code=secret-sentinel&error=private-sentinel"] {
            XCTAssertThrowsError(try validator.code(from: redirect + "?" + query)) { error in
                XCTAssertEqual(error as? TransientOAuthCallback.ValidationError, .providerError)
                let text = "\(error) \(String(reflecting: error)) \((error as NSError).localizedDescription)"
                XCTAssertFalse(text.contains("secret-sentinel"))
                XCTAssertFalse(text.contains("private-sentinel"))
                XCTAssertFalse(text.contains("example-app"))
            }
        }
        XCTAssertThrowsError(try validator.code(from: redirect + "?error=a&%65rror=b")) {
            XCTAssertEqual($0 as? TransientOAuthCallback.ValidationError, .invalidCallback)
        }
    }
}
