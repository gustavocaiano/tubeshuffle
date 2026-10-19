# macOS media controls

TubeShuffle mirrors the app's ordered queue into YouTube using `loadPlaylist`
and `cuePlaylist`. This lets YouTube's own active media session navigate the
shuffled list. Native next/previous changes are synchronized back to the app;
queue edits retain the current track's position and paused state. YouTube's
own shuffle and repeat are disabled so the app remains responsible for order.

App Media Session handlers advertise play/pause, previous/next track, and absolute
seeking. Relative seek buttons are deliberately omitted so they do not displace
track-skip buttons on compact system controls. The progress bar still seeks.
This addresses the priority issue reported in
[the May 2026 standards discussion](https://github.com/w3c/mediasession/issues/374);
that report concerns Android, so macOS behavior still needs direct verification.
The app's previous button restarts the current track after five seconds.

Natural completion is recorded for the ended track once. YouTube can omit ENDED
between playlist items; forward transitions that reach the previous playing
clock’s projected end are also treated as completion. The transition start time
excludes the next video’s loading delay, so early native skips stay incomplete.
A 200ms timing tolerance accounts for iframe delivery and media clock precision.
YouTube normally
advances the native playlist; a guarded fallback advances the app only if the
iframe remains ended for 1.5 seconds. Native skips do not mark tracks completed.

## Browser limitation and workaround

macOS keyboard and Now Playing buttons can control web playback through the
[Media Session API](https://www.w3.org/TR/mediasession/). Apple discusses Safari
support in [Develop advanced web content](https://developer.apple.com/videos/play/wwdc2021/10030/).

YouTube plays in a cross-origin iframe. Chrome documents that Media Session
calls must come from the frame playing the media, so registering handlers in
TubeShuffle alone does not guarantee that the OS uses them:
[Chrome implementation notes](https://developer.chrome.com/blog/media-session#implementation_notes).
The page cannot modify YouTube's own Media Session because of browser origin
isolation. Re-registering handlers or adding ordinary keyboard listeners cannot
reliably fix OS routing.

**Shortcuts & media keys → Connect media keys** enables an optional workaround:
a ten-second looping silent WAV in the top-level page. Chromium's routing
implementation prefers the top-most eligible media frame, so this makes the
page's own session eligible. It starts only after the user clicks, follows
play/pause, can be disconnected, and releases its blob URL and audio element
when leaving the player. It is not persisted or automatically enabled.

This is a browser-dependent workaround, not a guarantee of macOS integration.
A related [Media Session standards discussion](https://github.com/w3c/mediasession/issues/328)
reports silent-audio behavior differing between browsers. Chromium's routing
logic is visible in [MediaSessionImpl](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/media/session/media_session_impl.cc)
and its [routing tests](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/media/session/media_session_impl_service_routing_unittest.cc).

If a target browser cannot route the controls, an extension with access to both
the page and embedded frame, or a native macOS wrapper owning its media-command
integration, is a separate implementation option. Neither is included here.

## Verification

Automated tests exercise handlers, seek bounds, previous/restart behavior,
iframe readiness, view changes, progress scrubbing, shortcut isolation,
connection refusal, and cleanup. Browser checks cover playback/progress,
view switching without replacing the iframe, Stage seeking and Escape/focus
return, silent-connection activation, and desktop/mobile layout. Queue tests
cover native previous/next, natural completion without double skips, stalled
advancement, repeated videos, pause during loading, stale iframe updates, and
queue editing. The app passes all IDs through without truncating long queues.

Physical media keys and macOS Control Center still require testing on a Mac:

1. Start a track in Safari, then Chrome, and try keyboard play/pause and next/previous.
2. Repeat with the page in the background and from Control Center's Now Playing.
3. If it targets YouTube instead of the queue, connect media keys and repeat.
4. Test previous after five seconds, seeking, track changes, pause/resume, and
   leaving the page. Confirm that no silent session remains after disconnecting.

Playback progress comes from YouTube's documented
[getCurrentTime/getDuration/seekTo API](https://developers.google.com/youtube/iframe_api_reference).
