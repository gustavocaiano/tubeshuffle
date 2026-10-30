// Standalone deterministic checks; run with swiftc as documented in README.
@main
enum QueueStateTests {
    static func main() {
        var startup = StartupGate()
        assert(startup.timeout())
        assert(!startup.ready() && !startup.timeout() && !startup.fail())
        var readyStartup = StartupGate()
        assert(readyStartup.ready() && !readyStartup.timeout())
        assert(readyStartup.fail() && !readyStartup.ready())
        var failedStartup = StartupGate()
        assert(failedStartup.fail() && !failedStartup.ready() && !failedStartup.timeout())
        // Generation correlation replaces the former fail-closed attribution gate:
        // DirectPlayer starts at generation 1 with its fixture, and callbacks must
        // name the pending or active occurrence.
        var gens = QueueState(count: 4)
        assert(gens.activeGeneration == QueueState.initialGeneration)
        assert(gens.expectedGeneration == 1 && gens.expects(generation: 1))
        assert(!gens.expects(generation: 0) && !gens.expects(generation: 2))
        let initialLoad = gens.request(1, reason: .manual, allowed: true)!
        assert(initialLoad.generation == 2) // strictly greater than the player's initial 1
        assert(gens.expectedGeneration == 2 && gens.expects(generation: 2))
        assert(!gens.expects(generation: 1)) // old occurrence is stale while the load is in flight
        _ = gens.complete(initialLoad, success: true)
        assert(gens.activeGeneration == 2 && gens.expectedGeneration == 2 && gens.index == 1)
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
        // Two natural advances with generation-tagged callbacks.
        var two = QueueState(count: 4)
        assert(two.expects(generation: 1))
        let one = two.request(1, reason: .natural, allowed: true)!
        assert(one.generation == 2 && !two.expects(generation: 1))
        _ = two.complete(one, success: true)
        assert(two.activeGeneration == 2)
        two.playing() // state (2, 1)
        assert(two.observedNatural == 1)
        assert(two.ended() && !two.ended()) // state (2, 0) advances; duplicate ended rejected
        let secondLoad = two.request(2, reason: .natural, allowed: true)!
        assert(secondLoad.generation == 3)
        two.playing() // state (3, 1) while the load command is in flight
        assert(two.hasBufferedPlaying && !two.ended()) // buffered across command completion
        assert(!two.ended()) // a buffered pair cannot double-advance
        assert(two.complete(secondLoad, success: true)) // buffered ended surfaces at completion
        assert(two.index == 2 && two.activeGeneration == 3 && two.observedNatural == 2)
        let third = two.request(3, reason: .natural, allowed: true)!
        assert(third.generation == 4)
        _ = two.complete(third, success: true)
        two.playing()
        assert(two.ended() && !two.ended()) // second natural advance
        // Failed loads keep the previous occurrence active; retries and repeated
        // loads of the same video ID still reserve strictly increasing generations.
        var retryState = QueueState(count: 3)
        let failedLoad = retryState.request(1, reason: .manual, allowed: true)!
        assert(failedLoad.generation == 2)
        _ = retryState.complete(failedLoad, success: false)
        assert(retryState.failedTarget == 1 && retryState.activeGeneration == 1)
        assert(retryState.expectedGeneration == 1 && retryState.expects(generation: 1))
        let retryLoad = retryState.request(1, reason: .manual, allowed: true)!
        assert(retryLoad.generation == 3 && retryState.expects(generation: 3) && !retryState.expects(generation: 1))
        retryState.playing()
        assert(retryState.hasBufferedPlaying && !retryState.ended())
        _ = retryState.complete(retryLoad, success: true)
        assert(retryState.index == 1 && retryState.activeGeneration == 3 && !retryState.hasBufferedPlaying)
        let duplicate = retryState.request(1, reason: .manual, allowed: true)! // same video ID again
        assert(duplicate.generation == 4 && retryState.expects(generation: 4) && !retryState.expects(generation: 3))
        _ = retryState.complete(duplicate, success: true)
        assert(retryState.activeGeneration == 4)
        assert(!retryState.expects(generation: 1) && !retryState.expects(generation: 2) && !retryState.expects(generation: 3))
        var e = QueueState(count: 3)
        let pair = e.request(1, reason: .natural, allowed: true)!
        assert(e.expectedGeneration == pair.generation)
        e.playing()
        assert(!e.ended())
        e.invalidatePlayback()
        assert(!e.complete(pair, success: true))
        assert(e.expectedGeneration == 1) // pending dropped: the active occurrence is expected again
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
        // Readiness gate: each issued player generation must report readiness
        // within a bounded window; stale, misattributed or late ready callbacks
        // cannot disarm it, and a timeout is a one-way restart requirement.
        var readiness = ReadinessGate()
        let firstReadiness = readiness.arm(generation: 2)!
        assert(readiness.awaiting && readiness.awaitingGeneration == 2)
        assert(!readiness.ready(1)) // wrong generation cannot disarm the await
        assert(readiness.awaiting)
        assert(readiness.ready(2)) // the awaited generation disarms without a restart
        assert(!readiness.awaiting && !readiness.restartRequired)
        assert(!readiness.timeout(firstReadiness)) // already disarmed
        var lateReadiness = ReadinessGate()
        let lateToken = lateReadiness.arm(generation: 2)!
        assert(lateReadiness.timeout(lateToken) && lateReadiness.restartRequired)
        assert(!lateReadiness.ready(2)) // a late ready callback cannot recover a timed-out gate
        assert(lateReadiness.arm(generation: 3) == nil) // no new await after the restart requirement
        var abandoned = ReadinessGate()
        let abandonedToken = abandoned.arm(generation: 2)!
        abandoned.abandon() // failed load: the occurrence ended without readiness
        assert(!abandoned.timeout(abandonedToken) && !abandoned.restartRequired)
        let rearm = abandoned.arm(generation: 3)!
        assert(abandoned.awaitingGeneration == 3)
        assert(!abandoned.ready(2)) // the superseded generation cannot disarm the new await
        assert(abandoned.ready(3))
        assert(!abandoned.timeout(rearm))
        // Remote command snapshots are bound to the window generation and the
        // occurrence: a queued system command is validated against both, so an
        // advance between callback and execution cannot act on a superseded player.
        let eligibility = RemoteEligibility()
        let initial = eligibility.read()
        assert(!initial.transport && !initial.next && !initial.seek && initial.window == 0 && initial.occurrence == 0)
        eligibility.update(transport: true, next: true, seek: false, window: 1, occurrence: 3)
        let bound = eligibility.read()
        assert(bound.transport && bound.next && !bound.seek && bound.window == 1 && bound.occurrence == 3)
        eligibility.update(transport: false, next: false, seek: true, window: 2, occurrence: 5)
        let superseded = eligibility.read()
        assert(!superseded.transport && superseded.seek && superseded.window == 2 && superseded.occurrence == 5)
        // The window generation and occurrence a command was admitted under no
        // longer match after the update, so a queued command must be discarded.
        assert(!(bound.window == superseded.window && bound.occurrence == superseded.occurrence))
        // Race: an evaluation ticket invalidated by a generation advance (load
        // or seek) must be discarded on completion; only a ticket admitted after
        // the advance is current and may publish observations.
        var race = ProgressAdmission()
        let inFlight = race.begin(now: 0)!
        assert(race.isCurrent(id: inFlight.id, generation: inFlight.generation))
        race.invalidate() // the coordinator invalidates admission when an occurrence advances
        assert(!race.isCurrent(id: inFlight.id, generation: inFlight.generation))
        race.finish(id: inFlight.id) // the stale ticket frees its slot without effects
        let afterAdvance = race.begin(now: 12)!
        assert(race.isCurrent(id: afterAdvance.id, generation: afterAdvance.generation))
        assert(!race.isCurrent(id: afterAdvance.id, generation: inFlight.generation))
        race.finish(id: afterAdvance.id)
        // A pending occurrence invalidated by a pending error cannot be committed
        // by its own later completion, and the next request still reserves a
        // fresh, strictly larger generation.
        var dropped = QueueState(count: 3)
        let droppedLoad = dropped.request(1, reason: .natural, allowed: true)!
        dropped.playing()
        dropped.invalidatePlayback() // pending error quarantines the occurrence
        assert(!dropped.complete(droppedLoad, success: true)) // stale completion has no effect
        assert(dropped.index == 0 && dropped.accepted == 0 && !dropped.hasBufferedPlaying)
        assert(dropped.expectedGeneration == QueueState.initialGeneration)
        assert(!dropped.ended() && dropped.observedNatural == 0)
        let afterDrop = dropped.request(2, reason: .manual, allowed: true)!
        assert(afterDrop.generation == droppedLoad.generation + 1)
        _ = dropped.complete(afterDrop, success: true)
        assert(dropped.index == 2 && dropped.activeGeneration == afterDrop.generation && dropped.failedTarget == nil)
        print("QueueState checks passed")
    }
}
