import Foundation

// This is a portable domain boundary, not an application model. Callers retain
// their objects and use the returned occurrence indices to construct the queue.
struct EnergyTrackInput: Decodable {
    var title: String
    var channelTitle: String
    var description: String?
    var tags: [String]?
    var categoryId: String?
    var duration: Double?
}

enum EnergyBucket: String, CaseIterable, Decodable {
    case hype, upbeat, steady, chill, melancholy, unknown
}

struct TrackEnergyProfile: Decodable {
    let bucket: EnergyBucket
    let score: Int
    let confidence: Double
    let signals: [String]
}

enum ShuffleV1 {
    private static let ladder: [EnergyBucket] = [.melancholy, .chill, .steady, .upbeat, .hype]
    private static let queuesOrder: [EnergyBucket] = [.hype, .upbeat, .steady, .chill, .melancholy, .unknown]
    private static let rules: [(EnergyBucket, [String])] = [
        (.hype, ["hype", "hard", "aggressive", "rage", "banger", "club", "festival", "drill", "phonk", "nightcore", "sped up", "speed up", "fast", "pump", "pump up", "trap", "hyper"]),
        (.upbeat, ["upbeat", "happy", "dance", "party", "energetic", "uplift", "uplifting", "summer", "joy", "fun", "remix", "mix", "pop", "edm", "bounce", "groove", "alegre", "animada", "animado", "feliz", "danca", "festa"]),
        (.steady, ["steady", "groove", "anthem", "live", "version", "official", "audio", "performance", "rock", "indie", "synth", "radio edit", "original", "session", "classic"]),
        (.chill, ["chill", "lofi", "lo-fi", "calm", "calma", "relax", "relaxed", "ambient", "soft", "acoustic", "study", "sleep", "downtempo", "instrumental", "smooth", "gentle", "mellow", "quiet"]),
        (.melancholy, ["sad", "sadness", "triste", "melancholy", "melancolic", "heartbreak", "lonely", "alone", "slow", "slowed", "slow version", "emotional", "nostalgic", "nostalgia", "blue", "cry", "broken", "minor", "down"])
    ]

    // Foundation uses OS Unicode data. It must be checked against the JS runtime
    // at release time; neither Unicode version nor contextual casing is pinned.
    private static func normalize(_ text: String) -> String {
        let scalars = text.decomposedStringWithCanonicalMapping.unicodeScalars.filter {
            !(0x0300...0x036f).contains($0.value)
        }
        return String(String.UnicodeScalarView(scalars)).lowercased()
    }

    private static let ecmaWhitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

    static func classify(_ input: EnergyTrackInput) -> TrackEnergyProfile {
        var scores = Dictionary(uniqueKeysWithValues: ladder.map { ($0, 0.0) })
        var signals: [String] = []
        let fields: [(String, String, Double)] = [
            ("title", input.title, 1.6), ("channelTitle", input.channelTitle, 1.1),
            ("description", input.description ?? "", 0.85), ("tags", input.tags?.joined(separator: " ") ?? "", 1.05)
        ]
        for (name, value, weight) in fields where !value.isEmpty {
            let normalized = normalize(value)
            for (bucket, terms) in rules {
                // NSString range search is literal UTF-16, unlike Swift's
                // canonically equivalent String comparisons.
                if let term = terms.first(where: { (normalized as NSString).range(of: normalize($0), options: .literal).location != NSNotFound }) {
                    scores[bucket, default: 0] += weight
                    signals.append("\(name):\(bucket.rawValue):\(normalize(term))")
                }
            }
        }
        if let duration = input.duration, duration.isFinite, duration > 0 {
            if duration <= 180 {
                scores[.hype, default: 0] += 0.35; scores[.upbeat, default: 0] += 0.55; signals.append("duration:short")
            } else if duration <= 270 {
                scores[.upbeat, default: 0] += 0.3; scores[.steady, default: 0] += 0.4; signals.append("duration:mid")
            } else if duration <= 420 {
                scores[.steady, default: 0] += 0.25; scores[.chill, default: 0] += 0.5; signals.append("duration:long")
            } else {
                scores[.chill, default: 0] += 0.35; scores[.melancholy, default: 0] += 0.55; signals.append("duration:very-long")
            }
        }
        let category = (input.categoryId ?? "").trimmingCharacters(in: ecmaWhitespace)
        if !category.isEmpty { signals.append("category:\(category)") }
        let ranked = ladder.enumerated().sorted {
            let a = scores[$0.element]!, b = scores[$1.element]!
            return a == b ? $0.offset < $1.offset : a > b
        }.map(\.element)
        let top = scores[ranked[0]]!, second = scores[ranked[1]]!
        let boosted = top + (category == "10" ? 0.2 : 0)
        let confidence = min(1, max(0, boosted / (boosted + second + 1.1)))
        let score = top < 0.9 ? boosted * 12 : min(100, max(0, boosted * 18))
        // Scores are nonnegative, so ties-away-from-zero matches Math.round.
        return TrackEnergyProfile(bucket: top < 0.9 ? .unknown : ranked[0], score: Int(score.rounded(.toNearestOrAwayFromZero)), confidence: confidence, signals: signals)
    }

    private static func fisherYates(_ items: inout [Int], draw: () -> Double) {
        guard items.count > 1 else { return }
        for i in stride(from: items.count - 1, through: 1, by: -1) {
            let r = draw()
            precondition(r.isFinite && r >= 0 && r < 1, "Shuffle draws must be finite and in [0, 1)")
            let j = Int(floor(r * Double(i + 1)))
            items.swapAt(i, j)
        }
    }

    static func randomShuffle(count: Int, draw: () -> Double) -> [Int] {
        precondition(count >= 0)
        var indices = Array(0..<count)
        fisherYates(&indices, draw: draw)
        return indices
    }

    static func smartShuffle(_ tracks: [EnergyTrackInput], draw: () -> Double) -> [Int] {
        guard tracks.count > 1 else { return Array(tracks.indices) }
        var queues = Dictionary(uniqueKeysWithValues: queuesOrder.map { ($0, [Int]()) })
        var totals = Dictionary(uniqueKeysWithValues: ladder.map { ($0, 0.0) })
        var first: [EnergyBucket: Int] = [:]
        for (index, track) in tracks.enumerated() {
            let profile = classify(track)
            queues[profile.bucket]!.append(index)
            if profile.bucket != .unknown {
                totals[profile.bucket]! += Double(profile.score) * (0.5 + profile.confidence / 2)
                if first[profile.bucket] == nil { first[profile.bucket] = index }
            }
        }
        for bucket in queuesOrder { fisherYates(&queues[bucket]!, draw: draw) }
        var start = ladder[0], best = -1.0, bestFirst = Int.max
        for bucket in ladder {
            let total = totals[bucket]!, index = first[bucket] ?? Int.max
            if total > best || (total == best && index < bestFirst) {
                start = bucket; best = total; bestFirst = index
            }
        }
        var current = ladder.firstIndex(of: start)!, direction = current >= 2 ? -1 : 1
        var cycle = [current]
        while cycle.count < 10 {
            let next = current + direction
            if next < 0 || next > 4 { direction = -direction; continue }
            current = next; cycle.append(current)
        }
        let group = tracks.count >= 24 ? 3 : tracks.count >= 10 ? 2 : 1
        var result: [Int] = []
        for position in tracks.indices {
            let desired = ladder[cycle[(position / group) % cycle.count]]
            var selected: EnergyBucket? = nil
            if !queues[desired]!.isEmpty { selected = desired }
            else if (desired == .steady || desired == .chill) && !queues[.unknown]!.isEmpty { selected = .unknown }
            else {
                let desiredIndex = ladder.firstIndex(of: desired)!
                var distance = Int.max, count = -1
                for (index, bucket) in ladder.enumerated() where !queues[bucket]!.isEmpty {
                    let d = abs(index - desiredIndex), n = queues[bucket]!.count
                    if d < distance || (d == distance && n > count) {
                        selected = bucket; distance = d; count = n
                    }
                }
                if selected == nil && !queues[.unknown]!.isEmpty { selected = .unknown }
            }
            if let bucket = selected { result.append(queues[bucket]!.removeFirst()) }
        }
        for bucket in queuesOrder { result.append(contentsOf: queues[bucket]!) }
        return result
    }
}
