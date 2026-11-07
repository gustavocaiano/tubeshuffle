# src/components/layouts/

## Responsibility

Site chrome components: `Navbar` for top navigation/brand identity and `Footer` for bottom branding/CTA/legal copy.

## Design

- `Navbar` is a client component using `next/link` and lucide icons.
- `Footer` is presentational and server-safe.
- Components do not read stores, IndexedDB, or React Query. Navbar uses the route pathname to mark the macOS entry as current.
- Semantic elements (`header`, `nav`, `footer`) support accessibility and layout clarity.

## Flow

No data flow beyond user navigation through `next/link`.

## Integration

- Links route users to `/`, `/dashboard` and `/macos`; browser-library links disable prefetch in shared chrome.
- Consumed by homepage, dashboard, and playlist player pages.
- Styled with global Tailwind tokens and component classes.
