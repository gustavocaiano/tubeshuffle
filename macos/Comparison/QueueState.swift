// This state tracks observations, not authenticated video identities.
struct QueueState {
    enum Reason: String { case natural, manual }
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

    init(count: Int) {
        self.count = count
    }

    var nextTarget: Int { (failedTarget ?? index) + 1 }

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
        return true
    }
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
        if pending != nil { pendingInvalidated = true }
    }
}
