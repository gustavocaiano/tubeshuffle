# src/lib/shuffle/

## Responsibility

Pure shuffle strategy module. Reorders video arrays for playback without side effects or storage access.

## Design

- `randomShuffle()` uses Fisher-Yates and is labeled Normal in the UI.
- `smartShuffle()` starts with Fisher-Yates, then greedily swaps adjacent same-artist and same-channel runs.
- `shuffleVideos()` dispatches based on the simplified `ShufflePreset` union.

## Flow

```text
shuffleVideos(videos, preset)
  -> RANDOM: Fisher-Yates
  -> SMART: Fisher-Yates + adjacent diversity passes
```

## Integration

- Consumed by `src/app/playlist/[id]/page.tsx`.
- Preset type comes from `src/types/playlist.ts`.
- Current product caveat: Smart is an explainable spacing algorithm, not an AI/mood/energy classifier.
