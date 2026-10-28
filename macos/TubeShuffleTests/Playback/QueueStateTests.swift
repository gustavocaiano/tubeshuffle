// Standalone deterministic checks; run with swiftc as documented in README.
@main
enum QueueStateTests {
    static func main() {
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
        e.playing()
        assert(!e.ended())
        assert(!e.complete(pair, success: true))
        assert(e.accepted == 1 && e.observedNatural == 0 && !e.ended())
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
