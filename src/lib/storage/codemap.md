# src/lib/storage/

## Responsibility

Browser IndexedDB persistence for local playlists, occurrence records, play history and metadata. The integrated session checks existing storage before reads; only separate, explicit confirmation can create an absent database.

## Files and boundaries

- `browser-db-target.ts`: immutable production name `tubeshuffle_local`, version `1`. Only the disposable test build replaces this exact constant leaf; no runtime override.
- `browser-db.ts`: v1 schema creation and existing-schema validation. Stores: `playlists`, `videos`, `playHistory`, `meta`. Checks stores/indexes/key paths without repair or upgrade.
- `browser-provisioning.ts`: target-bound existing-only/one-shot creation coordinator, now used by the application session. Handles concurrent creation, blocked/draining and explicit recheck.
- `browser-session.ts`: observable phase/generation, connection ownership, metadata initialization and tracked transactions. Version changes invalidate stale work; no automatic write replay. IDB metadata commit and localStorage marker failure are distinct states.
- `index.ts`: `browserStorage` operation facade. Consumers do not receive raw handles. Each operation captures the generation and awaits transaction completion. The low-level `initializeStorage` export remains for internal/test code; it is not the repository interface.
- `storage-migrations.ts`: preserves the existing metadata policy after schema validation, with separate localStorage read/marker errors. It does not open or copy a legacy database. There is no atomic commit across IDB and localStorage.
- `browser-db-lifecycle.ts` and completion-journal modules remain separate experiments; their existence does not activate a migration or include journal events in v1 exports.

## Flow

```text
repository read / export
  -> facade captures generation
  -> session acquires existing-only, validated handle
  -> initialize missing metadata and separate localStorage marker
  -> generation-bound transaction
  -> request result AND transaction completion

missing database
  -> observable missing state, operations disabled
  -> separate one-shot user confirmation
  -> create + validate, then explicit existing check
  -> ready or recheck/error state (no implicit retry)
```

`savePlaylist` accepts new local playlists only and refuses conflicting existing identities instead of deleting/replacing occurrences. `getPlaylist` sorts stored videos by position. Completed-ID lookup returns exact stored IDs without remapping legacy history. Playlist deletion retains history, so an export can disclose omitted orphan events.

## Integration and evidence

- `playlistRepository` in `src/stores/playlist-store.ts` generates fresh local occurrence UUIDs for new API imports; destructive refresh/reimport stays blocked. Async imports/completions carry the originating storage generation.
- `use-browser-storage.ts`, dashboard/playlist queries and `BrowserStorageNotice` distinguish readiness, missing, incompatible and blocked/partial-effect states. Query keys and export callbacks are bound to generation; missing is not an empty playlist list.
- The transfer snapshot reads playlists/videos/history together. Initialization can write metadata first; export is not read-only end to end. Orphans are omitted with disclosure and kept in source storage; no history/provenance inference.
- `tests/browser/storage-startup/` substitutes only the target leaf and guards every realm, IndexedDB name/version, localStorage key and network entry point. Current synthetic evidence includes 13 scenarios and a separate two-tab run; it does not validate real libraries, Safari, durability or release.
- Current decisions and limits: `docs/plans/browser-storage-phase2.md`. No production schema bump, automatic repair, migration or rollout is implied by the integration.
