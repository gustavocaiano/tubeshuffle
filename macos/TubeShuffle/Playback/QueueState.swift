import Foundation

// Terminal startup failures cannot be undone by a late ready callback.
struct StartupGate {
    private enum State { case waiting, ready, failed }
    private var state = State.waiting
    mutating func ready() -> Bool {
        guard state == .waiting else { return false }
        state = .ready
        return true
    }
    mutating func timeout() -> Bool {
        guard state == .waiting else { return false }
        state = .failed
        return true
    }
    mutating func fail() -> Bool {
        guard state != .failed else { return false }
        state = .failed
        return true
    }
}

// Each coordinator-issued player generation must report readiness within a
// bounded window. Controls stay disabled until it does; a late ready callback
// cannot recover a timed-out gate, and an occurrence that ends without
// readiness (for example a failed load) abandons the await without requiring
// a restart of its own.
struct ReadinessGate {
    private(set) var awaitingGeneration: Int?
    private var serial = 0
    private var active: Int?
    private(set) var restartRequired = false
    var awaiting: Bool { active != nil }
    mutating func arm(generation: Int) -> Int? {
        guard !restartRequired else { return nil }
        serial += 1
        active = serial
        awaitingGeneration = generation
        return serial
    }
    @discardableResult
    mutating func ready(_ generation: Int) -> Bool {
        guard active != nil, generation == awaitingGeneration else { return false }
        active = nil
        awaitingGeneration = nil
        return true
    }
    // The occurrence ended without readiness; the watchdog must not fire for
    // an occurrence that is already over.
    mutating func abandon() {
        active = nil
        awaitingGeneration = nil
    }
    mutating func timeout(_ token: Int) -> Bool {
        guard active == token, !restartRequired else { return false }
        restartRequired = true
        active = nil
        awaitingGeneration = nil
        return true
    }
}

// Invalid or unavailable iframe measurements must not enable seeking.
struct ProgressSnapshot: Equatable {
    let elapsed: Double
    let duration: Double

    init?(elapsed: Double, duration: Double) {
        guard elapsed.isFinite, duration.isFinite, elapsed >= 0, duration > 0 else { return nil }
        self.elapsed = min(elapsed, duration)
        self.duration = duration
    }
}

struct SeekGate {
    private(set) var occurrence = 0
    private var serial = 0
    private var active: Int?
    var seeking: Bool { active != nil }
    func isActive(_ token: Int) -> Bool { active == token }
    mutating func begin() -> Int? {
        guard !seeking else { return nil }
        serial += 1
        active = serial
        return serial
    }
    mutating func finish(_ token: Int) {
        if active == token { active = nil }
    }
    mutating func invalidate() { occurrence += 1; active = nil }
}

// Limits retries per occurrence, not across abandoned iframe evaluations.
struct ProgressAdmission {
    private(set) var generation = 0
    private var serial = 0
    private var tasks: [Int: Double] = [:]
    var saturated: Bool { tasks.count >= 2 }
    func stalled(now: Double) -> Bool { saturated && tasks.values.allSatisfy { now - $0 >= 10 } }
    mutating func invalidate() { generation += 1 }
    mutating func begin(now: Double) -> (id: Int, generation: Int)? {
        guard !tasks.values.contains(where: { now - $0 < 10 }), tasks.count < 2 else { return nil }
        serial += 1
        tasks[serial] = now
        return (serial, generation)
    }
    func isCurrent(id: Int, generation: Int) -> Bool { self.generation == generation && serial == id && tasks[id] != nil }
    mutating func finish(id: Int) { tasks.removeValue(forKey: id) }
}

// A timed-out bridge mutation remains quarantined even if it later completes.
struct MutationGate {
    struct Context: Equatable { let occurrence: Int; let lifecycle: Int }
    private var serial = 0
    private var active: Int?
    private var deferred: Context?
    private(set) var restartRequired = false
    var busy: Bool { active != nil }
    mutating func begin() -> Int? {
        guard active == nil && !restartRequired else { return nil }
        serial += 1; active = serial; return serial
    }
    mutating func deferEnd(_ context: Context) { if busy { deferred = context } }
    mutating func timeout(_ token: Int) -> Bool {
        guard active == token && !restartRequired else { return false }
        restartRequired = true; deferred = nil; return true
    }
    mutating func invalidate() {
        if busy { restartRequired = true }
        deferred = nil
    }
    mutating func finish(_ token: Int, current: Context) -> Bool {
        guard active == token else { return false }
        active = nil
        defer { deferred = nil }
        return !restartRequired && deferred == current
    }
}

struct PlaybackIntent {
    private(set) var wantsPlayback = false
    private var revision = 0
    mutating func observe(_ playing: Bool) { revision += 1; wantsPlayback = playing }
    mutating func admit(_ playing: Bool) -> (revision: Int, previous: Bool) {
        let previous = wantsPlayback
        revision += 1
        wantsPlayback = playing
        return (revision, previous)
    }
    mutating func failed(_ token: (revision: Int, previous: Bool)) {
        if revision == token.revision { revision += 1; wantsPlayback = token.previous }
    }
}

// This state tracks observations, not authenticated video identities.
// Generation correlation: DirectPlayer starts at generation 1 with its built-in
// fixture, and every coordinator-issued load reserves the next strictly larger
// generation for that occurrence, including retries and repeated loads of the
// same video ID. Callbacks are processed only when their tag names the pending
// or active occurrence; everything else is stale and must be rejected.
struct QueueState {
    // Must match DirectPlayer's initial fixture generation.
    static let initialGeneration = 1
    // Must stay within the bridge's safe-integer maximum (DirectPlayer rejects
    // larger tags before issuing the load).
    static let maximumGeneration = 9_007_199_254_740_991
    enum Reason: String { case natural, manual, seekAssisted }
    struct Request {
        let generation: Int
        let target: Int
        let reason: Reason
    }
    let count: Int
    private(set) var index = 0
    private(set) var pending: Request?
    private(set) var failedTarget: Int?
    private(set) var requested = 0
    private(set) var accepted = 0
    private(set) var observedNatural = 0
    // Generation of the last accepted occurrence (the fixture until the first
    // load completes). A failed load does not advance it: the coordinator
    // quarantines the session instead, so nothing may treat the stale value
    // as trustworthy.
    private(set) var activeGeneration = QueueState.initialGeneration
    private var generation = QueueState.initialGeneration
    private var armed = false
    private var pendingPlaying = false
    private var pendingEnded = false
    private var pendingInvalidated = false
    private var awaitingNaturalObservation = false
    private var seekAssisted = false
    private(set) var lastEndWasSeekAssisted = false

    init(count: Int) {
        self.count = count
    }

    var nextTarget: Int { (failedTarget ?? index) + 1 }
    var hasBufferedPlaying: Bool { pending != nil && pendingPlaying && !pendingInvalidated }
    // The occurrence a callback must name: the in-flight load while one is
    // pending, otherwise the last accepted occurrence.
    var expectedGeneration: Int { pending?.generation ?? activeGeneration }
    func expects(generation: Int) -> Bool { generation == expectedGeneration }

    mutating func request(_ target: Int, reason: Reason, allowed: Bool) -> Request? {
        guard allowed, pending == nil, (0..<count).contains(target),
              generation < Self.maximumGeneration else { return nil }
        generation += 1
        let request = Request(generation: generation, target: target, reason: reason)
        pending = request
        pendingPlaying = false
        pendingEnded = false
        pendingInvalidated = false
        armed = false
        awaitingNaturalObservation = false
        seekAssisted = false
        lastEndWasSeekAssisted = false
        requested += 1
        return request
    }

    // Playback during a command is buffered until the command result. The
    // generation tag correlates it with the pending or active occurrence; it is
    // still only a candidate observation, not authenticated remote video identity.
    mutating func playing() {
        if pending != nil { if !pendingInvalidated { pendingPlaying = true } } else {
            if awaitingNaturalObservation { observedNatural += 1; awaitingNaturalObservation = false }
            armed = true
        }
    }
    mutating func ended() -> Bool {
        if pending != nil {
            if !pendingInvalidated && pendingPlaying { pendingEnded = true; pendingPlaying = false }
            return false
        }
        guard armed else { return false }
        armed = false
        lastEndWasSeekAssisted = seekAssisted
        return true
    }
    mutating func markSeekAssisted() { seekAssisted = true }
    // Returns whether a buffered playing/ended pair needs processing.
    mutating func complete(_ request: Request, success: Bool) -> Bool {
        guard pending?.generation == request.generation else { return false }
        pending = nil
        if success {
            accepted += 1
            index = request.target
            activeGeneration = request.generation
            failedTarget = nil
            awaitingNaturalObservation = request.reason == .natural && !pendingInvalidated
            if awaitingNaturalObservation && (pendingPlaying || pendingEnded) {
                observedNatural += 1
                awaitingNaturalObservation = false
            }
            armed = pendingPlaying
            let ended = pendingEnded
            pendingPlaying = false
            pendingEnded = false
            return ended
        }
        failedTarget = request.target
        awaitingNaturalObservation = false
        armed = false
        pendingPlaying = false
        pendingEnded = false
        return false
    }
    mutating func invalidatePlayback() {
        armed = false
        awaitingNaturalObservation = false
        pendingPlaying = false
        pendingEnded = false
        pending = nil
        pendingInvalidated = true
    }
}

// MediaPlayer callbacks can arrive on any thread; this snapshot is advisory and
// all commands are revalidated on the main actor before being issued. The
// snapshot is bound to both the window generation and the occurrence so a
// queued system command can be discarded when either has moved on.
final class RemoteEligibility {
    struct Snapshot {
        let transport: Bool
        let next: Bool
        let seek: Bool
        let window: Int
        let occurrence: Int
    }
    private let lock = NSLock()
    private var values = Snapshot(transport: false, next: false, seek: false, window: 0, occurrence: 0)
    func update(transport: Bool, next: Bool, seek: Bool, window: Int, occurrence: Int) {
        lock.lock(); defer { lock.unlock() }
        values = Snapshot(transport: transport, next: next, seek: seek, window: window, occurrence: occurrence)
    }
    func read() -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        return values
    }
}
