# src/components/

## Responsibility

Presentation layer for app chrome, playlist-specific UI, reusable shadcn/Radix primitives, cross-cutting providers, FAQ rendering, and render error fallback UI.

## Design

- **Feature components** in `playlist/` compose stores, React Query mutations, toasts, and UI primitives.
- **Layout components** in `layouts/` provide site chrome and navigation.
- **Atomic primitives** in `ui/` wrap Radix primitives and Tailwind token classes, with dark ambient dialog/dropdown/switch/toast surfaces aligned to the app shell.
- **Provider boundary** in `providers.tsx` creates a browser-side QueryClient and mounts dark-styled Sonner toasts.
- **Error boundary** uses React class lifecycle methods to catch render failures.

## Flow

```text
App route
  -> Providers
    -> layout chrome
    -> playlist/page feature component
      -> UI primitive composition
      -> store/repository actions
      -> toast/query refresh/render state
```

## Integration

- `components/playlist/` consumes `stores`, `lib/services`, `lib/shuffle`, and `types`.
- `components/ui/` consumes `cn()` from `src/lib/utils.ts`.
- `providers.tsx` integrates TanStack Query and Sonner.
- `layouts/` uses `next/link` and lucide icons.

## User-Facing Functionality

- Navbar/dashboard navigation and footer CTA.
- Single playlist import modal.
- Batch import modal component exists, but is not currently mounted in active routes.
- Playlist cards with thumbnail, metadata, shuffle/open, sync, and delete actions.
- Shuffle controls for playback navigation, preset selection, re-shuffle, and exclude-watched toggle.
- Queue list with current item highlighting and click-to-play.
- YouTube iframe player with keyboard shortcuts and Media Session controls.
