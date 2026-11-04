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
        case failure(String)
    }

    // Fixed canonical base, independent of TMPDIR/TEMP/TMP and of Foundation's
    // environment-derived temporary directory.
    private static let temporaryBase = "/private/tmp"

    // Greater than the sum of the parent's bounded waits, but still finite.
    private static let holdBudgetSeconds: UInt64 = 120

    // Strict POSIX canonicalization for the fixed base and the synthetic root.
    // Foundation's resolvingSymlinksInPath previously reported a value unequal
    // to the literal /private/tmp on macOS, so this uses the same realpath the
    // POSIX boundary expects. A nil result fails closed at the caller.
    private static func canonicalPath(_ path: String) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard realpath(path, &buffer) != nil else { return nil }
        guard let canonical = String(validatingUTF8: buffer) else { return nil }
        return canonical
    }

    private static func hasSyntheticBasename(_ canonical: String) -> Bool {
        let basename = canonical.split(separator: "/").last.map(String.init) ?? ""
        return basename.hasPrefix("tubeshuffle-standalone-")
    }

    static func main() {
        do {
            let arguments = try parseArguments()
            try run(arguments)
        } catch {
            emit("error", failure: failureName(error))
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
        if !arguments.root.hasPrefix("/") {
            throw ProbeUsage.root
        }
        let root = URL(fileURLWithPath: arguments.root)
        // Fail closed if Foundation normalized the input. The store must
        // receive exactly the path the parent and identity checks validated.
        guard root.path == arguments.root else {
            throw ProbeUsage.root
        }

        // Original no-follow lstat before any symlink resolution.
        var original = stat()
        if lstat(arguments.root, &original) != 0 {
            throw ProbeUsage.root
        }
        if (original.st_mode & S_IFMT) != S_IFDIR {
            throw ProbeUsage.root
        }
        if original.st_uid != arguments.uid {
            throw ProbeUsage.root
        }
        if UInt32(original.st_mode & 0o777) != arguments.modeBits {
            throw ProbeUsage.root
        }
        if Int64(original.st_dev) != arguments.dev {
            throw ProbeUsage.root
        }
        if UInt64(original.st_ino) != arguments.ino {
            throw ProbeUsage.root
        }

        // The parent opens this descriptor without following the final path
        // component and passes it through subprocess pass_fds.
        var inherited = stat()
        if fstat(arguments.rootFD, &inherited) != 0 {
            throw ProbeUsage.root
        }
        if (inherited.st_mode & S_IFMT) != S_IFDIR {
            throw ProbeUsage.root
        }
        if inherited.st_uid != arguments.uid {
            throw ProbeUsage.root
        }
        if UInt32(inherited.st_mode & 0o777) != arguments.modeBits {
            throw ProbeUsage.root
        }
        if Int64(inherited.st_dev) != arguments.dev {
            throw ProbeUsage.root
        }
        if UInt64(inherited.st_ino) != arguments.ino {
            throw ProbeUsage.root
        }
        if inherited.st_dev != original.st_dev {
            throw ProbeUsage.root
        }
        if inherited.st_ino != original.st_ino {
            throw ProbeUsage.root
        }

        // Fixed canonical boundary check, only after the no-follow identity
        // checks above. Refuse a symlinked or aliased base rather than trusting
        // an environment-derived temporary directory.
        var baseInfo = stat()
        if lstat(temporaryBase, &baseInfo) != 0 {
            throw ProbeUsage.root
        }
        if (baseInfo.st_mode & S_IFMT) != S_IFDIR {
            throw ProbeUsage.root
        }
        guard let canonicalBase = canonicalPath(temporaryBase) else {
            throw ProbeUsage.root
        }
        if canonicalBase != temporaryBase {
            throw ProbeUsage.root
        }
        guard let canonicalRoot = canonicalPath(arguments.root) else {
            throw ProbeUsage.root
        }
        let prefix = temporaryBase + "/"
        if !canonicalRoot.hasPrefix(prefix) {
            throw ProbeUsage.root
        }
        if !hasSyntheticBasename(canonicalRoot) {
            throw ProbeUsage.root
        }
        // Return the original validated URL, not the canonical string, so the
        // store receives the path the parent and identity checks validated.
        return root
    }

    private static func run(_ arguments: Arguments) throws {
        switch arguments.mode {
        case "create-hold":
            if case .failure(let failure) = createNew(arguments) {
                emit("failed", failure: failure)
                exit(1)
            }
            emit("holding")
            try holdOrExit()

        case "open-success":
            if case .failure(let failure) = openExisting(arguments) {
                emit("failed", failure: failure)
                exit(1)
            }
            emit("opened")

        case "contend":
            guard case .failure(let failure) = openExisting(arguments) else {
                emit("unexpected-success")
                exit(1)
            }
            emit("denied", failure: failure)
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
            guard case .failure(let first) = openExisting(arguments) else {
                ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
                ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
                emit("unexpected-success")
                exit(1)
            }
            ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
            ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
            emit("failed", failure: first)
            guard first == "invalidStore", !beforeObserved, !afterObserved else { exit(1) }
            emit("preflight-no-constructor")

            guard case .failure(let retained) = openExisting(arguments) else {
                emit("unexpected-success")
                exit(1)
            }
            emit("retained", failure: retained)
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
            guard case .failure(let first) = createNew(arguments) else {
                ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
                ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
                emit("unexpected-success")
                exit(1)
            }
            ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
            ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
            emit("failed", failure: first)
            guard first == "invalidStore" else { exit(1) }

            guard case .failure(let retained) = openExisting(arguments) else {
                emit("unexpected-success")
                exit(1)
            }
            emit("retained", failure: retained)
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
            guard case .failure(let failure) = openExisting(arguments) else {
                ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
                ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
                emit("unexpected-success")
                exit(1)
            }
            ExperimentalLocalLibraryStore.beforeContainerConstructionForTesting = nil
            ExperimentalLocalLibraryStore.afterContainerAssignedForTesting = nil
            emit("failed", failure: failure)
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
            return .failure(failureName(error))
        }
    }

    private static func openExisting(_ arguments: Arguments) -> OpenOutcome {
        do {
            let root = try validatedRoot(arguments)
            _ = try ExperimentalLocalLibraryStore.testing(.openExisting, root: root)
            return .success
        } catch {
            return .failure(failureName(error))
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

    private static func emit(_ event: String, failure: String? = nil) {
        var fields = ["\"event\":\"\(event)\""]
        if let failure { fields.append("\"failure\":\"\(failure)\"") }
        FileHandle.standardOutput.write(Data(("{" + fields.joined(separator: ",") + "}\n").utf8))
    }
}
