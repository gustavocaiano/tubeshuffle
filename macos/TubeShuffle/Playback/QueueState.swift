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
struct QueueState {
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
    private var generation = 0
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

    mutating func request(_ target: Int, reason: Reason, allowed: Bool) -> Request? {
        guard allowed, pending == nil, (0..<count).contains(target) else { return nil }
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

    // Playback during a command is buffered until the command result. It is still
    // only a candidate observation: the bridge has no occurrence token.
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
