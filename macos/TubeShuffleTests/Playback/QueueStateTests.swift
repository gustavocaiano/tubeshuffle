// Standalone deterministic checks; run with swiftc as documented in README.
@main
enum QueueStateTests {
    static func main() {
        assert(ProgressSnapshot(elapsed: 0, duration: 0) == nil)
        assert(ProgressSnapshot(elapsed: .nan, duration: 10) == nil)
        assert(ProgressSnapshot(elapsed: 1, duration: .infinity) == nil)
        assert(ProgressSnapshot(elapsed: -1, duration: 10) == nil)
        assert(ProgressSnapshot(elapsed: 12, duration: 10)?.elapsed == 10)
        var gate = SeekGate()
        let token = gate.begin()!
        assert(gate.begin() == nil)
        gate.invalidate()
        assert(!gate.seeking && !gate.isActive(token))
        let nextToken = gate.begin()!
        gate.finish(token)
        assert(gate.seeking)
        gate.finish(nextToken)
        assert(!gate.seeking)
        var progress = ProgressAdmission()
        let first = progress.begin(now: 0)!
        assert(progress.begin(now: 1) == nil)
        let second = progress.begin(now: 10)!
        assert(!progress.stalled(now: 19) && progress.stalled(now: 20))
        assert(progress.begin(now: 20) == nil)
        progress.invalidate()
        assert(progress.begin(now: 20) == nil)
        progress.finish(id: first.id)
        let current = progress.begin(now: 20)!
        assert(!progress.isCurrent(id: first.id, generation: first.generation))
        progress.finish(id: second.id)
        assert(progress.isCurrent(id: current.id, generation: current.generation))
        var mutations = MutationGate()
        let context = MutationGate.Context(occurrence: 1, lifecycle: 1)
        let command = mutations.begin()!
        mutations.deferEnd(context)
        assert(mutations.finish(command, current: context))
        let stale = mutations.begin()!
        mutations.deferEnd(context)
        assert(!mutations.finish(stale, current: .init(occurrence: 2, lifecycle: 1)))
        let closed = mutations.begin()!
        mutations.deferEnd(context)
        mutations.invalidate()
        assert(mutations.restartRequired && !mutations.finish(closed, current: context))
        assert(mutations.begin() == nil)
        var stalled = MutationGate()
        let late = stalled.begin()!
        stalled.deferEnd(context)
        assert(stalled.timeout(late) && stalled.busy && stalled.restartRequired)
        assert(!stalled.timeout(late) && !stalled.finish(late, current: context))
        assert(stalled.begin() == nil)
        var lifecycle = MutationGate()
        let priorWindow = lifecycle.begin()!
        lifecycle.deferEnd(context)
        assert(!lifecycle.finish(priorWindow, current: .init(occurrence: 1, lifecycle: 2)))
        var intent = PlaybackIntent()
        assert(!intent.wantsPlayback)
        let play = intent.admit(true)
        assert(intent.wantsPlayback)
        intent.failed(play)
        assert(!intent.wantsPlayback)
        let old = intent.admit(true)
        intent.observe(false)
        intent.failed(old)
        assert(!intent.wantsPlayback)
        let firstToggle = intent.admit(true)
        let secondToggle = intent.admit(false)
        intent.failed(firstToggle)
        assert(!intent.wantsPlayback)
        intent.failed(secondToggle)
        assert(intent.wantsPlayback)
        var assisted = QueueState(count: 2)
        assisted.playing()
        assisted.markSeekAssisted()
        assert(assisted.ended() && assisted.lastEndWasSeekAssisted)
        let assistedLoad = assisted.request(1, reason: .seekAssisted, allowed: true)!
        _ = assisted.complete(assistedLoad, success: true)
        assisted.playing()
        assert(assisted.observedNatural == 0)
        var s = QueueState(count: 5)
        assert(s.request(1, reason: .natural, allowed: false) == nil)
        assert(s.requested == 0 && s.index == 0)
        let failed = s.request(1, reason: .manual, allowed: true)!
        _ = s.complete(failed, success: false)
        assert(s.index == 0 && s.failedTarget == 1 && s.accepted == 0 && s.nextTarget == 2)
        let retry = s.request(2, reason: .manual, allowed: true)!
        _ = s.complete(failed, success: true) // stale completion cannot commit retry
        assert(s.pending?.generation == retry.generation && s.index == 0)
        s.playing()
        assert(s.hasBufferedPlaying)
        assert(!s.ended()) // buffer a playing/ended pair while in flight
        assert(!s.ended()) // duplicate cannot add a second advance
        assert(s.complete(retry, success: true))
        assert(s.index == 2 && s.accepted == 1 && s.observedNatural == 0)
        assert(!s.ended())
        let natural = s.request(3, reason: .natural, allowed: true)!
        _ = s.complete(natural, success: true)
        assert(s.observedNatural == 0)
        s.playing()
        assert(s.observedNatural == 1 && s.ended() && !s.ended())
        s.invalidatePlayback()
        assert(!s.ended())
        var e = QueueState(count: 3)
        let pair = e.request(1, reason: .natural, allowed: true)!
        e.playing()
        assert(!e.ended())
        e.invalidatePlayback()
        assert(!e.complete(pair, success: true))
        assert(e.accepted == 0 && e.observedNatural == 0 && !e.ended())
        e.playing()
        assert(e.ended() && e.observedNatural == 0)
        let single = e.request(2, reason: .natural, allowed: true)!
        e.playing()
        e.invalidatePlayback()
        assert(!e.complete(single, success: true))
        assert(!e.ended() && e.observedNatural == 0)
        e.playing()
        assert(e.ended())
        print("QueueState checks passed")
    }
}
