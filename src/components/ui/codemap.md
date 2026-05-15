# src/components/ui/

## Responsibility

Reusable UI primitive library generated/adapted from shadcn patterns. Provides styled wrappers for buttons, cards, dialogs, forms, dropdowns, selects, sheets, tabs, tooltips, toast, and other building blocks.

## Design

- Wraps Radix UI primitives with Tailwind class names and `data-slot` attributes.
- Uses `class-variance-authority` for variant systems in components such as `button`, `badge`, and `tabs`.
- Uses `Slot`/`asChild` patterns for polymorphic button/badge rendering.
- Applies focus-visible rings, dark-first variants, disabled states, and aria-invalid styling consistently.
- Dialog, dropdown, switch, and Sonner surfaces are tuned for the app's dark ambient/glass visual system.

## Flow

These components are mostly pure presentational wrappers: callers own state and pass props/events down. Radix primitives handle internal disclosure/menu/dialog mechanics and emit controlled/uncontrolled state changes.

## Integration

- Consumed by route pages and feature components throughout `src/app` and `src/components/playlist`.
- Depends on `cn()` from `src/lib/utils.ts`, Radix packages, lucide icons, Tailwind CSS tokens, and Sonner.
