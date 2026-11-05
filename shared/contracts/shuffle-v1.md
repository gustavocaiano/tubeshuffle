# Shuffle v1 — normative portable algorithm

This specifies the existing TypeScript behavior in `src/lib/shuffle/{shuffle-service,energy-classifier,energy-flow}.ts`; it does not change production randomness. Implementations must reproduce this version, not substitute locale collation, a different classifier, or a seeded PRNG. `shared/fixtures/smart.json` retains the original examples and adds `classifierV1` and `v1`, a language-neutral corpus. A v1 case contains ordered input `tracks`, `mode`, `draws`, and output zero-based `expectedOccurrences` (indices, not IDs). Preserve repeated IDs and input objects; never mutate the input. Swift must run the same corpus before parity is claimed.

## Randomness and arithmetic

The injectable source is a finite sequence of IEEE-754 binary64 numbers, consumed from index zero exactly once per draw. Each must satisfy 0 ≤ r < 1 and be finite; exhaustion or an unused fixture draw is a test failure. JSON decimal numbers are converted to nearest binary64. The contract does not specify a seed or generator; callers may supply any valid source. In the existing TS tests only, a `Math.random` spy supplies it. For each Fisher–Yates loop, copy the array, then for i from length−1 down to 1 inclusive draw r, compute `j = floor(r * (i + 1))` using binary64 multiplication, and swap positions i and j, including self-swaps. No rejection, modulo, extra draw, or draw for length 0 or 1. Normal is exactly this loop over the whole input. Smart draws only during its per-bucket shuffles, in the specified order below. Results are occurrence identities, not equality by metadata or ID.

All numeric operations below use IEEE-754 binary64 in the written order without reassociation; `round` is ECMAScript Math.round (ties toward positive infinity). Ranking equality is exact binary64 equality. Confidence corpus assertions allow absolute error 1e-12; implementations should use binary64 rather than decimal arithmetic. Inputs are metadata strings and optional finite numeric duration in seconds; absent optional strings/tags behave as empty; tags are joined with a single U+0020. JSON vectors avoid non-finite values. Empty and singleton input return a new array with no random draws.

## Classifier

Normalize each field and each term by Unicode canonical decomposition NFD, delete only code points U+0300 through U+036F, then apply ECMAScript `String.prototype.toLowerCase` (default Unicode lowercasing, not locale-specific, not case folding). Substring matching is literal JS `includes`, not word-boundary matching. In particular compatibility characters are not NFKD-normalized; combining marks outside that range remain. Implementations must match the Unicode data used by the JS runtime, including contextual and expanding lowercase mappings; Unicode data versions may differ across OS runtimes, so pin/verify Unicode behavior for a release rather than assuming Swift's locale-dependent operations match. `categoryId` is trimmed using ECMAScript whitespace/line-terminator trim semantics; it is not normalized or lowercased.

Initialize five scores to zero and signals to empty. Scan fields in this order: `title` weight 1.6, `channelTitle` 1.1, `description` 0.85, joined `tags` 1.05. Skip absent/empty fields. For each field, visit the following rules in their listed order. In each rule, test terms in the listed order and, on the first substring match only, add the field weight to that bucket and append `field:bucket:term`; stop testing that rule's terms but continue the next rule. Thus one field can match multiple buckets, overlapping terms count only the first in each bucket, and `groove` matches both upbeat and steady.

| Bucket | Ordered terms |
| --- | --- |
| hype | hype, hard, aggressive, rage, banger, club, festival, drill, phonk, nightcore, sped up, speed up, fast, pump, pump up, trap, hyper |
| upbeat | upbeat, happy, dance, party, energetic, uplift, uplifting, summer, joy, fun, remix, mix, pop, edm, bounce, groove, alegre, animada, animado, feliz, danca, festa |
| steady | steady, groove, anthem, live, version, official, audio, performance, rock, indie, synth, radio edit, original, session, classic |
| chill | chill, lofi, lo-fi, calm, calma, relax, relaxed, ambient, soft, acoustic, study, sleep, downtempo, instrumental, smooth, gentle, mellow, quiet |
| melancholy | sad, sadness, triste, melancholy, melancolic, heartbreak, lonely, alone, slow, slowed, slow version, emotional, nostalgic, nostalgia, blue, cry, broken, minor, down |

After the fields, if duration is a finite number greater than zero, apply exactly one row and append its signal:

| Duration | Score additions | Signal |
| --- | --- | --- |
| ≤180 | hype +0.35, upbeat +0.55 | duration:short |
| >180 and ≤270 | upbeat +0.3, steady +0.4 | duration:mid |
| >270 and ≤420 | steady +0.25, chill +0.5 | duration:long |
| >420 | chill +0.35, melancholy +0.55 | duration:very-long |

If trimmed category is nonempty append `category:<trimmed>` after duration; category `10` gives a 0.2 boost, others zero. Rank scores descending, resolving equal values by ladder order `melancholy, chill, steady, upbeat, hype`. Let top and second be the first two unboosted scores, b be boost, t = top + b. Confidence is `min(1, max(0, t / (t + second + 1.1)))`, evaluated left to right. If unboosted top < 0.9, bucket is unknown and score is `round(t * 12)`; otherwise bucket is the highest ranked bucket and score is `round(min(100, max(0, t * 18)))`. Category never affects bucket selection. Return bucket, score, confidence, and signals in insertion order.

## Smart ordering

For length > 1, classify each occurrence in input order and append it to its bucket queue, preserving occurrence order. Shuffle each queue by the Fisher–Yates algorithm above, consuming the shared stream in this exact order: `hype, upbeat, steady, chill, melancholy, unknown`. In parallel with classification, retain each profile's original index. To choose the starting bucket, sum `profile.score * (0.5 + profile.confidence / 2)` for each non-unknown bucket, in input order. Iterate ladder `melancholy, chill, steady, upbeat, hype`; select greatest total, breaking exact ties by the smallest original index in that bucket, then ladder order. Missing buckets have total 0 and first index infinity. Consequently all-unknown starts at melancholy (not steady).

For the desired wave, let start be that ladder index, max = 4, direction = −1 if start ≥ floor(max/2), else +1. Cycle starts with start. Until it has 10 indices, attempt current + direction; if outside 0...4, reverse direction and retry without appending, otherwise set current to next and append it. Repeat this cycle as needed; each cycle entry produces 1 desired bucket for input length <10, 2 for length 10...23, or 3 for length ≥24, truncating at input length.

For each desired bucket, choose and remove the first item from a queue as follows. If desired is unknown, pick the first nonempty known queue in ladder order, else unknown if nonempty, else none. Otherwise, use desired if nonempty. Otherwise, if desired is steady or chill and unknown is nonempty, use unknown. Otherwise, among nonempty known buckets minimize absolute ladder-index distance, break ties by larger remaining queue count, then ladder order. If no known queue remains, use unknown if nonempty; otherwise none. Append chosen occurrence. Finally append any leftovers in queue order `hype, upbeat, steady, chill, melancholy, unknown`, preserving each queue's order. This last step mirrors the current implementation even though valid inputs normally exhaust all queues in the wave.

## Evidence boundary

The corpus tests the real TS exports with injected draws and exact consumption, including nonzero and edge draws, duplicate IDs, empty/singleton, duration cutoffs, multilingual and overlap cases, wave sizes, ties and unknown queues. It is a regression corpus, not exhaustive proof of Unicode parity or cross-language conformance. No Swift implementation or Swift test result is asserted here.
