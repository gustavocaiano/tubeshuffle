# src/lib/shuffle/

## Responsibility

Pure shuffle strategy module. Reorders video arrays for playback without side effects or storage access.

## Design

- `randomShuffle()` uses Fisher-Yates and is labeled Normal in the UI.
- `smartShuffle()` classifies rough energy/mood from metadata and builds a wave-like queue through nearby energy buckets.
- `shuffleVideos()` dispatches based on the simplified `ShufflePreset` union.

## Flow

```text
shuffleVideos(videos, preset)
  -> RANDOM: Fisher-Yates
  -> SMART: metadata-inferred energy flow
```

## Integration

- Consumed by `src/app/playlist/[id]/page.tsx`.
- Preset type comes from `src/types/playlist.ts`.
- Current product caveat: Smart is an explainable metadata-based energy inference, not BPM-perfect audio analysis.
