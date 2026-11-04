// Offline process-lifecycle probe for the quarantined experimental library
// store. This helper is compiled standalone by
// macos/tests/run_standalone_library_store_probe.py; it is not an app target
// member and never launches the app. It only accepts a private synthetic
// temporary root created by that Python parent, plus the inherited directory
// descriptor and identity for that root.
//
// The helper re-lstats the original path without following it, validates the
// inherited descriptor, and checks that both identities match immediately
// before use. Roots must be under the fixed canonical /private/tmp base, not an
// environment-derived Foundation temporary directory. A hold blocks on a
// monotonic budget and exits when the parent sends "exit" or when stdin closes.
// This does not defend against a hostile same-user process racing the validation
// and store open: there is no such guarantee here. Correctness claims are limited
// to the observed cooperative lock lifecycle; this does not establish power-loss
// durability, physical read-only behavior, full store integrity, adversarial
// filesystem protection, or migration-free behavior. Shutdown uses bounded
// SIGTERM/SIGKILL; uninterruptible or escaped descendants cannot be guaranteed
// dead, so the parent retains uncertain fixture/build trees instead of claiming
// they were definitively reaped.
import Darwin
import Dispatch
import Foundation

#if !TUBESHUFFLE_STANDALONE_LIBRARY_PROBE
#error("Compile only with -DTUBESHUFFLE_STANDALONE_LIBRARY_PROBE")
#endif

private enum ProbeUsage: Error {
    case arguments
    case root
    case hold
}

@main
@MainActor
struct StandaloneLibraryProbe {
    private struct Arguments {
        let mode: String
        let root: String
        let rootFD: Int32
        let dev: Int64
        let ino: UInt64
        let uid: UInt32
        let modeBits: UInt32
    }

    private enum OpenOutcome {
        case success
        case failure(String, String?)
    }

    // Fixed canonical base, independent of TMPDIR/TEMP/TMP and of Foundation's
    // environment-derived temporary directory.
    private static let temporaryBase = "/private/tmp"

    // Greater than the sum of the parent's bounded waits, but still finite.
    private static let holdBudgetSeconds: UInt64 = 120

    // TEMP DEBUG-ROOT-A4F2: fixed reason tag for the root-validation
    // diagnostic. It carries no path, identifier, device, inode, or errno.
    // Remove this property and recordRootFailure with the probe below.
    private static var rootFailureTag: String?

    private static func recordRootFailure(_ tag: String) {
        rootFailureTag = "DEBUG-ROOT-A4F2:" + tag
    }

    // Read the tag only for a root-validation error, then clear it so a later
    // non-root failure cannot inherit a stale reason. The tag itself is fixed.
    private static func rootReason(for error: Error) -> String? {
        defer { rootFailureTag = nil }
        guard let usage = error as? ProbeUsage, case .root = usage else { return nil }
        return rootFailureTag
    }

    static func main() {
        do {
            let arguments = try parseArguments()
            try run(arguments)
        } catch {
            // Preserve the existing event and failure; append the fixed tag
            // only for a failed root validation.
            emit("error", failure: failureName(error), reason: rootReason(for: error))
            exit(2)
        }
    }

    private static func parseArguments() throws -> Arguments {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 14 else { throw ProbeUsage.arguments }
        var values: [String: String] = [:]
        var index = 0
        while index < args.count {
            let key = args[index]
            guard key.hasPrefix("--"), index + 1 < args.count else {
                throw ProbeUsage.arguments
            }
            values[key] = args[index + 1]
            index += 2
        }
        guard values.count == 7,
              let mode = values["--mode"],
              let root = values["--root"],
              let fdText = values["--root-fd"], let fd = Int32(fdText),
              let devText = values["--dev"], let dev = Int64(devText),
              let inoText = values["--ino"], let ino = UInt64(inoText),
              let uidText = values["--uid"], let uid = UInt32(uidText),
              let modeText = values["--root-mode"], let modeBits = UInt32(modeText),
              fd >= 3 else {
            throw ProbeUsage.arguments
        }
        return Arguments(mode: mode, root: root, rootFD: fd, dev: dev,
                         ino: ino, uid: uid, modeBits: modeBits)
    }

    private static func validatedRoot(_ arguments: Arguments) throws -> URL {
        rootFailureTag = nil
        if !arguments.root.hasPrefix("/") {
            recordRootFailure("absolute")
            throw ProbeUsage.root
        }
        let root = URL(fileURLWithPath: arguments.root)

        // Original no-follow lstat before any symlink resolution.
        var original = stat()
        if lstat(arguments.root, &original) != 0 {
            recordRootFailure("original-lstat")
            throw ProbeUsage.root
        }
        if (original.st_mode & S_IFMT) != S_IFDIR {
            recordRootFailure("original-type")
            throw ProbeUsage.root
        }
        if original.st_uid != arguments.uid {
            recordRootFailure("original-uid")
            throw ProbeUsage.root
        }
        if UInt32(original.st_mode & 0o777) != arguments.modeBits {
            recordRootFailure("original-mode")
            throw ProbeUsage.root
        }
        if Int64(original.st_dev) != arguments.dev {
            recordRootFailure("original-dev")
            throw ProbeUsage.root
        }
        if UInt64(original.st_ino) != arguments.ino {
            recordRootFailure("original-ino")
            throw ProbeUsage.root
        }

        // The parent opens this descriptor without following the final path
        // component and passes it through subprocess pass_fds.
        var inherited = stat()
        if fstat(arguments.rootFD, &inherited) != 0 {
            recordRootFailure("inherited-fstat")
            throw ProbeUsage.root
        }
        if (inherited.st_mode & S_IFMT) != S_IFDIR {
            recordRootFailure("inherited-type")
            throw ProbeUsage.root
        }
        if inherited.st_uid != arguments.uid {
            recordRootFailure("inherited-uid")
            throw ProbeUsage.root
        }
        if UInt32(inherited.st_mode & 0o777) != arguments.modeBits {
            recordRootFailure("inherited-mode")
            throw ProbeUsage.root
        }
        if Int64(inherited.st_dev) != arguments.dev {
            recordRootFailure("inherited-dev")
            throw ProbeUsage.root
        }
        if UInt64(inherited.st_ino) != arguments.ino {
            recordRootFailure("inherited-ino")
            throw ProbeUsage.root
        }
        if inherited.st_dev != original.st_dev {
            recordRootFailure("inherited-identity-dev")
            throw ProbeUsage.root
        }
        if inherited.st_ino != original.st_ino {
            recordRootFailure("inherited-identity-ino")
            throw ProbeUsage.root
        }

        // Fixed canonical boundary check, only after the no-follow identity
        // checks above. Refuse a symlinked or aliased base rather than trusting
        // an environment-derived temporary directory.
        var baseInfo = stat()
        let canonicalBase = URL(fileURLWithPath: temporaryBase)
            .resolvingSymlinksInPath().path
        if lstat(temporaryBase, &baseInfo) != 0 {
            recordRootFailure("base-lstat")
            throw ProbeUsage.root
        }
        if (baseInfo.st_mode & S_IFMT) != S_IFDIR {
            recordRootFailure("base-type")
            throw ProbeUsage.root
        }
        if canonicalBase != temporaryBase {
            recordRootFailure("base-canonical")
            throw ProbeUsage.root
        }
        let resolved = root.resolvingSymlinksInPath()
        let prefix = temporaryBase + "/"
        if !resolved.path.hasPrefix(prefix) {
            recordRootFailure("resolved-prefix")
            throw ProbeUsage.root
        }
        if !resolved.lastPathComponent.hasPrefix("tubeshuffle-standalone-") {
            recordRootFailure("resolved-basename")
            throw ProbeUsage.root
        }
        return root
    }

    private static func run(_ arguments: Arguments) throws {
        switch arguments.mode {
        case "create-hold":
            if case .failure(let failure, let reason) = createNew(arguments) {
                emit("failed", failure: failure, reason: reason)
                exit(1)
            }
            emit("holding")
            try holdOrExit()

        case "open-success":
            if case .failure(let failure, let reason) = openExisting(arguments) {
                emit("failed", failure: failure, reason: reason)
                exit(1)
            }
            emit("opened")

        case "contend":
            guard case .failure(let failure, let reason) = openExisting(arguments) else {
                emit("unexpected-success")
                exit(1)
            }
            emit("denied", failure: failure, reason: reason)
            guard failure == "alreadyOwned" else { exit(1) }

        case "preflight-hold":
            var beforeObserved = false
            var afterObserved = false
            ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = {
                beforeObserved = true
                emit("unexpected-before-container")
            }
            ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = {
                afterObserved = true
                emit("unexpected-after-container")
            }
            guard case .failure(let first, let firstReason) = openExisting(arguments) else {
                ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
                ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
                emit("unexpected-success")
                exit(1)
            }
            ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
            ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
            emit("failed", failure: first, reason: firstReason)
            guard first == "invalidStore", !beforeObserved, !afterObserved else { exit(1) }
            emit("preflight-no-constructor")

            guard case .failure(let retained, let retainedReason) = openExisting(arguments) else {
                emit("unexpected-success")
                exit(1)
            }
            emit("retained", failure: retained, reason: retainedReason)
            guard retained == "alreadyOwned" else { exit(1) }
            emit("holding")
            try holdOrExit()

        case "injected-fail-hold":
            ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = {
                emit("before-container")
            }
            ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = {
                emit("container-assigned")
                throw ExperimentalLocalLibraryStore.Failure.invalidStore
            }
            guard case .failure(let first, let firstReason) = createNew(arguments) else {
                ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
                ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
                emit("unexpected-success")
                exit(1)
            }
            ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
            ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
            emit("failed", failure: first, reason: firstReason)
            guard first == "invalidStore" else { exit(1) }

            guard case .failure(let retained, let retainedReason) = openExisting(arguments) else {
                emit("unexpected-success")
                exit(1)
            }
            emit("retained", failure: retained, reason: retainedReason)
            guard retained == "alreadyOwned" else { exit(1) }
            emit("holding")
            try holdOrExit()

        case "open-fail":
            var beforeObserved = false
            var afterObserved = false
            ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = {
                beforeObserved = true
                emit("unexpected-before-container")
            }
            ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = {
                afterObserved = true
                emit("unexpected-after-container")
            }
            guard case .failure(let failure, let reason) = openExisting(arguments) else {
                ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
                ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
                emit("unexpected-success")
                exit(1)
            }
            ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
            ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
            emit("failed", failure: failure, reason: reason)
            guard failure == "invalidStore", !beforeObserved, !afterObserved else { exit(1) }
            emit("open-fail-no-constructor")

        default:
            throw ProbeUsage.arguments
        }
    }

    // Re-run the complete path/descriptor identity validation immediately
    // before the store touches the synthetic root. No hostile same-user race
    // guarantee is claimed; this narrows the window only.
    private static func createNew(_ arguments: Arguments) -> OpenOutcome {
        do {
            let root = try validatedRoot(arguments)
            _ = try ExperimentalLocalLibraryStore.testing(.createNew, root: root)
            return .success
        } catch {
            return .failure(failureName(error), rootReason(for: error))
        }
    }

    private static func openExisting(_ arguments: Arguments) -> OpenOutcome {
        do {
            let root = try validatedRoot(arguments)
            _ = try ExperimentalLocalLibraryStore.testing(.openExisting, root: root)
            return .success
        } catch {
            return .failure(failureName(error), rootReason(for: error))
        }
    }

    private static func holdOrExit() throws {
        guard holdUntilExit() else { throw ProbeUsage.hold }
        emit("exited")
    }

    // Monotonic budget with no sleep and no unbounded hold. EOF or budget
    // exhaustion returns false so the process exits instead of remaining
    // orphaned.
    private static func holdUntilExit() -> Bool {
        let start = DispatchTime.now().uptimeNanoseconds
        let budget = holdBudgetSeconds * 1_000_000_000
        var command = [UInt8]()
        while DispatchTime.now().uptimeNanoseconds &- start < budget {
            var descriptor = pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0)
            let ready = poll(&descriptor, 1, 200)
            if ready < 0 {
                if errno == EINTR { continue }
                return false
            }
            if ready == 0 { continue }
            var byte: UInt8 = 0
            let count = read(STDIN_FILENO, &byte, 1)
            if count <= 0 { return false }
            if byte == 0x0A {
                if command == Array("exit".utf8) { return true }
                command.removeAll(keepingCapacity: true)
            } else {
                command.append(byte)
            }
        }
        return false
    }

    private static func failureName(_ error: Error) -> String {
        guard let failure = error as? ExperimentalLocalLibraryStore.Failure else {
            return "unexpected"
        }
        switch failure {
        case .unavailable: return "unavailable"
        case .alreadyOwned: return "alreadyOwned"
        case .invalidStore: return "invalidStore"
        }
    }

    private static func emit(_ event: String, failure: String? = nil, reason: String? = nil) {
        var fields = ["\"event\":\"\(event)\""]
        if let failure { fields.append("\"failure\":\"\(failure)\"") }
        if let reason { fields.append("\"reason\":\"\(reason)\"") }
        FileHandle.standardOutput.write(Data(("{" + fields.joined(separator: ",") + "}\n").utf8))
    }
}
