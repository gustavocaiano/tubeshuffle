import AppKit
import AuthenticationServices
import Foundation
import XCTest
@testable import TubeShuffle

@MainActor
private final class FakeAuthSession: TransientAuthSession {
    var starts = true
    var startCount = 0
    var cancelCount = 0
    var completion: ((URL?, Error?) -> Void)?
    func start() -> Bool { startCount += 1; return starts }
    func cancel() { cancelCount += 1 }
}

@MainActor
final class TransientAuthBrowserTests: XCTestCase {
    private let authorizationURL = URL(string: "https://example.invalid/authorize")!
    private let callbackURL = URL(string: "example-app://auth.example/callback?code=test")!

    private func makeBrowser(_ fake: FakeAuthSession, started: XCTestExpectation,
                             anchor: NSWindow = NSWindow()) -> TransientAuthBrowser {
        TransientAuthBrowser(anchor: anchor) { [authorizationURL] url, scheme, provider, completion in
            XCTAssertEqual(url, authorizationURL)
            XCTAssertEqual(scheme, "example-app")
            let probe = ASWebAuthenticationSession(url: url, callbackURLScheme: scheme) { _, _ in }
            XCTAssertTrue(provider.presentationAnchor(for: probe) === anchor)
            fake.completion = completion
            started.fulfill()
            return fake
        }
    }

    private func failure(_ task: Task<URL, Error>, _ expected: TransientAuthBrowser.Failure,
                         file: StaticString = #filePath, line: UInt = #line) async {
        do {
            _ = try await task.value
            XCTFail("Expected failure", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? TransientAuthBrowser.Failure, expected, file: file, line: line)
        }
    }

    func testSuccessAndDuplicateCallback() async throws {
        let fake = FakeAuthSession(), started = expectation(description: "started")
        let browser = makeBrowser(fake, started: started)
        let task = Task { try await browser.start(url: authorizationURL, callbackScheme: "example-app") }
        await fulfillment(of: [started], timeout: 1)
        fake.completion?(callbackURL, nil)
        let result = try await task.value
        XCTAssertEqual(result, callbackURL)
        fake.completion?(nil, NSError(domain: "private", code: 1))
    }

    func testStartFalseResolves() async {
        let fake = FakeAuthSession(), started = expectation(description: "started")
        fake.starts = false
        let browser = makeBrowser(fake, started: started)
        let task = Task { try await browser.start(url: authorizationURL, callbackScheme: "example-app") }
        await fulfillment(of: [started], timeout: 1)
        await failure(task, .couldNotStart)
        fake.completion?(callbackURL, nil)
    }

    func testCancelWithoutCallbackAndLateCallbackCannotAffectNextFlow() async throws {
        let first = FakeAuthSession(), second = FakeAuthSession()
        let firstStarted = expectation(description: "first")
        let secondStarted = expectation(description: "second")
        var count = 0
        let browser = TransientAuthBrowser(anchor: NSWindow()) { _, _, _, completion in
            count += 1
            let fake = count == 1 ? first : second
            fake.completion = completion
            (count == 1 ? firstStarted : secondStarted).fulfill()
            return fake
        }
        let task = Task { try await browser.start(url: authorizationURL, callbackScheme: "example-app") }
        await fulfillment(of: [firstStarted], timeout: 1)
        browser.cancel()
        await failure(task, .cancelled)
        XCTAssertEqual(first.cancelCount, 1)
        let next = Task { try await browser.start(url: authorizationURL, callbackScheme: "example-app") }
        await fulfillment(of: [secondStarted], timeout: 1)
        first.completion?(nil, NSError(domain: "late", code: 1))
        second.completion?(callbackURL, nil)
        let result = try await next.value
        XCTAssertEqual(result, callbackURL)
    }

    func testTaskCancellationAndConcurrentStart() async {
        let fake = FakeAuthSession(), started = expectation(description: "started")
        let browser = makeBrowser(fake, started: started)
        let task = Task { try await browser.start(url: authorizationURL, callbackScheme: "example-app") }
        await fulfillment(of: [started], timeout: 1)
        do {
            _ = try await browser.start(url: authorizationURL, callbackScheme: "example-app")
            XCTFail("Expected concurrent start rejection")
        } catch {
            XCTAssertEqual(error as? TransientAuthBrowser.Failure, .alreadyRunning)
        }
        task.cancel()
        await failure(task, .cancelled)
        XCTAssertEqual(fake.cancelCount, 1)
    }

    func testOSFailureIsSanitizedAndMissingCallbackFails() async {
        for missing in [false, true] {
            let fake = FakeAuthSession(), started = expectation(description: "started")
            let browser = makeBrowser(fake, started: started)
            let task = Task { try await browser.start(url: authorizationURL, callbackScheme: "example-app") }
            await fulfillment(of: [started], timeout: 1)
            fake.completion?(nil, missing ? nil : NSError(domain: "secret-sentinel", code: 42))
            await failure(task, missing ? .missingCallback : .browserFailure)
        }
    }

    func testOSCancelledLoginMapsToCancelled() async {
        let fake = FakeAuthSession(), started = expectation(description: "started")
        let browser = makeBrowser(fake, started: started)
        let task = Task { try await browser.start(url: authorizationURL, callbackScheme: "example-app") }
        await fulfillment(of: [started], timeout: 1)
        fake.completion?(nil, NSError(domain: ASWebAuthenticationSessionErrorDomain,
                                      code: ASWebAuthenticationSessionError.canceledLogin.rawValue,
                                      userInfo: [NSLocalizedDescriptionKey: "secret-sentinel"]))
        await failure(task, .cancelled)
    }

    func testAlreadyCancelledDoesNotCreateOrStartSession() async {
        let fake = FakeAuthSession()
        var factoryCount = 0
        let browser = TransientAuthBrowser(anchor: NSWindow()) { _, _, _, _ in
            factoryCount += 1
            return fake
        }
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await browser.start(url: authorizationURL, callbackScheme: "example-app")
        }
        await failure(task, .cancelled)
        XCTAssertEqual(factoryCount, 0)
        XCTAssertEqual(fake.startCount, 0)
    }

    func testCancellationDuringFactoryDoesNotStartSession() async {
        let fake = FakeAuthSession()
        let browser = TransientAuthBrowser(anchor: NSWindow()) { _, _, _, _ in
            withUnsafeCurrentTask { $0?.cancel() }
            return fake
        }
        let task = Task { try await browser.start(url: authorizationURL, callbackScheme: "example-app") }
        await failure(task, .cancelled)
        XCTAssertEqual(fake.startCount, 0)
        XCTAssertEqual(fake.cancelCount, 1)
    }
}
