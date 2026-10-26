# NeoWeb reference for NeoMind FocusSpace

Inspected on 23 October 2026 (Asia/Saigon). This is pinned source research and a proposed integration design; it does not establish that weather, music, Calendar OAuth, or an Earth transition has run inside NeoMind.

## Source and inspection boundary

The reference is [NeoTech-vietnam/NeoWeb](https://github.com/NeoTech-vietnam/NeoWeb), fetched with `git fetch --no-tags origin main`. Both `origin/main` and `FETCH_HEAD` resolved to **`48570aeb5ef96c83945c404790dfebc5d4b7b811`**, committed `2026-09-06T20:46:01+07:00` (merge of `codex/spotify-controls-sync`). Every source link below uses that full commit. Implementation files were read with `git show <commit>:<path>`, rather than the potentially changed working tree.

The local checkout remained on `codex/spotify-controls-sync`. Its existing modified `.gitattributes`, documentation/schema files and untracked agent/Trellis/Vite files were left alone; there was no checkout, dependency installation, build, app launch, or OAuth action. The local `AGENTS.md` was read as source-repository guidance; its Trellis instructions were not imported into NeoMind. Fetching updated Git metadata only.

`Get-Command rea` found no REA executable on this shell's PATH. REA was **not used or installed**. Ordinary source inspection is also the appropriate first route in NeoMind's existing [REA adoption findings](rea-adoption.md); reverse engineering a shipped artifact is unnecessary while its source is available.

## What main actually contains

| Requested area | Verified NeoWeb implementation | Implication for NeoMind |
| --- | --- | --- |
| Weather/location | No weather provider, `navigator.geolocation`, Open-Meteo/OpenWeather call, or weather widget found in main's `web/app`, `web/components`, `web/lib`, `web/public`, README or docs. | Implement as a new optional provider; do not describe it as copied from NeoWeb. |
| YouTube/default music | No YouTube URL, iframe or YouTube player integration found in those sources. Music uses Spotify's Web API. | A YouTube player and any default selection are new work. |
| Music | Optional Spotify connection, current track/artwork, previous/play/pause/next, active-device controls and lifecycle-aware polling. | Reuse the client/status/lifecycle design, with a separate provider adapter. |
| Calendar | Google Identity Services token client plus a read-only primary-calendar agenda. | Reuse the normalized agenda shape and explicit connection states. |
| Focus | Local 25-minute default; configurable 1–240 minutes; start/pause/resume/finish; persisted sessions and cross-tab ownership. | Reimplement the small timer state machine independently of agents and workflow receipts. |
| Earth zoom | Space-themed dashboard and CSS orbit decoration, not an Earth/camera/3D rendering implementation. | Build the transition on NeoMind's own universe renderer. |

The feature list is corroborated by [README lines 24–43](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/README.md#L24-L43); the actual dashboard composes `FocusCard` and `IntegrationCards` in [dashboard.tsx](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/components/portal/dashboard.tsx#L225-L236). Absence claims are scoped source-search results, not claims about other branches, private services, or a different deployed version.

## Timer: the strongest small reference

The [focus schemas](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/learning-state.ts#L43-L61) separate active state (`heartbeatAt`, `running`) from finished sessions (`endedAt`, `reason`). Both retain an ID, optional topic, start time, credited duration and target duration. The default is [25 minutes](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/learning-state.ts#L96-L109).

[Pure transitions](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/learning-state.ts#L180-L294) accept an injected `now`. Starting twice preserves the active session. A tick credits elapsed time up to the target and closes once; a negative clock delta or gap greater than 65 seconds pauses without crediting that gap. Pause first accounts for the current valid segment; resume resets its heartbeat. Restoring an imported/recovered active session pauses it. This is credited foreground-session time, not simply `deadline - Date.now()`.

The [React hook](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/use-learning-state.ts#L39-L101) persists a tick every 15 seconds, pauses the owned session on `pagehide`, and synchronizes storage events. The [store](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/learning-store.ts#L208-L293) serializes writes through a Web Lock, records one tab's lease, prevents a non-owner from crediting time, and pauses when persistence fails. [Owner recovery](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/learning-store.ts#L116-L127) uses the same 65-second threshold. The [UI](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/components/portal/personal.tsx#L65-L155) interpolates a capped display every second; it is not the persistence authority.

Useful regression specifications already exist for [sleep/backwards clock, pause gaps, exactly-once completion](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/tests/state.test.ts#L120-L169) and [two tabs/stale owner](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/tests/learning-store.test.ts#L171-L278). These tests were inspected, not executed here.

For NeoMind, retain the injected clock and exactly-once transition rules but keep ownership in the extension host, scoped to the project/window policy. Do not import NeoWeb's curriculum, review scheduling, entire learning-state schema, or browser-wide storage key. Explicitly choose whether hiding FocusSpace pauses the timer; NeoWeb's `pagehide` behavior is not a specification for every VS Code visibility change. Focus sessions must never create an agent activity report, mark a task complete, or attest execution.

## Music: Spotify in main; YouTube is a new adapter

[Client construction](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/components/portal/personal.tsx#L42-L64) reads public application client IDs from local settings and sets the Spotify redirect to `location.origin + publicBase()`. With no client ID the provider is `unconfigured`; there is no seeded soundtrack, playlist, downloaded audio or default track. Playback [commands](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/integrations.ts#L260-L325) control an already active Spotify device and send no new track URI/body. The [card](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/components/portal/personal.tsx#L207-L255) attributes Spotify, shows confirmed metadata and links out.

The standalone `SpotifyClient` injects storage, fetch, clock, crypto and navigation ([options and state](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/integrations.ts#L107-L159)). It implements PKCE S256 and random state with the authorization endpoint `https://accounts.spotify.com/authorize` ([connect](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/integrations.ts#L350-L407)), validates callback state/origin/path/age, removes callback query parameters, and exchanges/refreshes through `https://accounts.spotify.com/api/token` ([callback and token lifecycle](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/integrations.ts#L417-L554)). Tokens use session storage; public client IDs use local storage. No client secret is embedded.

Scopes are `user-read-currently-playing`, `user-read-playback-state`, `user-modify-playback-state`. Reads use `GET https://api.spotify.com/v1/me/player?additional_types=track,episode`; play/pause use PUT and next/previous POST under `/v1/me/player/`. [Refresh normalization](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/integrations.ts#L580-L661) extracts only track/show title, artist, artwork, HTTPS Spotify link and playing state. [Polling](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/integrations.ts#L177-L224) uses 5 seconds playing / 15 idle, error backoff and rate-limit cooldown; [visibility/network binding](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/spotify-sync.ts#L3-L24) stops it on hidden/offline/unmount. A successful command leaves playback at its last confirmed value until a read succeeds.

This matches Spotify's official [PKCE flow](https://developer.spotify.com/documentation/web-api/tutorials/code-pkce-flow). Active-device playback control requires Premium; it is not audio playback inside NeoWeb. Spotify also prohibits synchronizing its recordings with visual media, so do not make the Earth animation react to Spotify timing. [Player requirements and policy notes](https://developer.spotify.com/documentation/web-api/reference/start-a-users-playback)

For the requested YouTube alternative, use a separate visible player created from an explicit video/playlist selection. Official URLs are `https://www.youtube.com/embed/VIDEO_ID` and `https://www.youtube.com/iframe_api`; use `enablejsapi=1` and the correct origin only when JavaScript controls are needed. A simple embed does not require adding a YouTube search/catalog service. Do not take Google's sample video ID as a recommended default soundtrack. [Embed parameters](https://developers.google.com/youtube/player_parameters)

Important acceptance limits: the player must remain visible and at least 200×200; scripted playback/autoplay may be blocked; deleted/private/non-embeddable videos and error 153 (missing Referer or equivalent client identity) need actionable fallbacks. Verify actual VS Code webview playback, not only a browser preview. [IFrame API](https://developers.google.com/youtube/iframe_api_reference) Hidden audio-only playback, stripped branding/ads and downloading/extracting the soundtrack are unsuitable; YouTube explicitly disallows background players and separating audio from video. [Developer policies](https://developers.google.com/youtube/terms/developer-policies#i-additional-prohibitions) An “Open on YouTube” action is a practical fallback.

## Calendar: a small read-only agenda

`CalendarClient` has injectable fetch/clock/Google loader, loads `https://accounts.google.com/gsi/client`, and initializes `google.accounts.oauth2.initTokenClient`. It requests only `https://www.googleapis.com/auth/calendar.events.readonly`, verifies that scope was granted, and keeps the short-lived access token in memory. Connecting is an explicit click; there is no refresh-token persistence or silent renewal. [Calendar implementation](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/integrations.ts#L719-L845), [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)

It requests `https://www.googleapis.com/calendar/v3/calendars/primary/events` with `timeMin=now`, `singleEvents=true`, `orderBy=startTime`, `maxResults=10`, `showDeleted=false`. It normalizes `{id,title,start,allDay,url}`, excludes cancelled/invalid dates, and handles expiry, permission/API errors and rate limits. The [query and parser](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/lib/integrations.ts#L847-L924) implement a deliberately small upcoming view, not full calendar synchronization. The [card](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/components/portal/personal.tsx#L374-L454) displays at most five events, preserves all-day date strings and refreshes on request. [Official Calendar v3 events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)

NeoWeb's web-origin OAuth setup must not be copied unchanged into a `vscode-webview:` context. Its registered JavaScript origin/callback assumptions are explicit in [Settings](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/components/portal/personal.tsx#L589-L641) and [deployment guidance](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/docs/deployment.md#L112-L133). Start with an accurately labelled local agenda or external Calendar link; a connected Google agenda needs a separately verified extension/browser authorization path. Never label local demo entries as fetched Calendar events.

## Weather/location: proposed new provider

A small Open-Meteo adapter is a reasonable new option, not an upstream discovery. It can request `https://api.open-meteo.com/v1/forecast` with selected coordinates and `current=temperature_2m,apparent_temperature,weather_code,is_day`, plus `timezone=auto`. Normalize the response to temperature/unit, WMO condition, day/night, provider observation time, fetch time and a stale flag. Open-Meteo's “current” data are weather-model estimates, not a sensor at the user's machine. Cache and refresh on a modest interval, not the animation frame loop. [Official forecast parameters and current data](https://open-meteo.com/en/docs)

Manual city/coordinate selection should work even when geolocation is unavailable. An optional “Use my location” action needs real browser/device permission and a denied/timeout fallback; no evidence here proves geolocation works inside VS Code's webview. Coarse selected coordinates are enough for this UI and should stay out of agent prompts/receipts. [W3C geolocation permission and privacy model](https://www.w3.org/TR/2026/CR-geolocation-20260326/#privacy)

Display Open-Meteo attribution with the weather. Data are CC BY 4.0; the free hosted service is restricted to non-commercial use and its stated request limits, while commercial use needs an appropriate plan. These service terms are separate from a software license. [Data licence](https://open-meteo.com/en/licence), [hosted-service terms](https://open-meteo.com/en/terms)

## Minimal NeoMind seam and Earth transition

Implement an original FocusSpace view alongside the monitor, with a small personal-state controller and optional provider adapters. Keep the existing agent snapshot and model-policy interfaces unchanged. Suggested contract:

```ts
type FocusSpaceState = {
  version: 1;
  timer: {
    id: string; state: 'idle' | 'running' | 'paused' | 'completed';
    targetMs: number; creditedMs: number; heartbeatAt: number | null;
  };
  weather: { status: string; provider: string; observedAt: string | null; stale: boolean };
  music: { provider: 'none' | 'youtube' | 'spotify'; status: string; sourceUrl: string | null };
  agenda: { source: 'local' | 'google'; status: string; fetchedAt: string | null };
};
```

The concrete provider payloads can extend those shells, but OAuth credentials and raw provider responses should never cross into the universe's map/agent snapshot. Bound event counts, IDs, durations and URL schemes at the extension message boundary. Store personal preferences/session state separately from workflow/receipt directories; keep account credentials in the host's credential store when adding host-managed OAuth. Do not transfer NeoWeb's `neoweb.*` browser-storage keys or pre-existing user data.

The Earth transition is a new presentation state, for example `universe → approaching-earth → focus-space`, with a cancel/back path restoring the previous camera and selection. Introduce a distinct destination ID such as `destination:earth`, not a fake configured role or a task node. Use NeoMind's original planet rendering/atmosphere and a bounded camera interpolation; reveal the FocusSpace DOM after the approach, and reverse on Back. Reduced motion can switch views immediately. Hidden/disposed views must stop decorative animation and provider polling; timer ownership needs its own explicit policy. There is no need to bring React, Vinext, the curriculum loader or a second scene framework into the extension.

At inspection, `extensions/vscode-model-bridge/monitor.cjs` emits `default-src 'none'` with only local script/style permissions. A remote iframe, weather request, Google script or artwork therefore needs a deliberate FocusSpace integration boundary. Prefer host-side weather requests plus sanitized message responses; allow only the selected HTTPS player domain for embeds. Do not loosen the entire monitor to `https:`/wildcard scripts. VS Code documents restrictive resource roots/CSP, message passing and state restoration because hidden webview contents can be destroyed. [Official webview lifecycle/security guidance](https://code.visualstudio.com/api/extension-guides/webview)

Useful focused acceptance tests are timer sleep/resume and exactly-once completion; reopen without duplicate session owners; offline/stale weather with no fabricated conditions; denied location; YouTube blocked/non-embeddable/client-identity errors; unconfigured/expired Calendar; and Earth approach/back under reduced motion and panel disposal. These are recommendations, not a claim that integration tests or account playback passed.

## Versions, notices and update strategy

The pinned [package manifest](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/package.json#L1-L95) declares `neolearning-portal@0.1.0`, private, Node ≥22.13.0, React 19.2.8 and Vinext 1.0.0-beta.9. It has no application `license` field. No tracked `LICENSE`, `NOTICE` or `COPYING` file was found in the pinned tree. This inspection therefore establishes no blanket open-source grant for verbatim NeoWeb code/assets; use its architecture as reference and write the NeoMind implementation independently unless ownership/permission is established.

Dependency notices do not license the application: the pinned lockfile records React 19.2.8 (MIT), react-day-picker 9.8.1 (MIT), Zod 4.5.4 (MIT), lucide-react 1.31.0 (ISC), and Vinext 1.0.0-beta.9 (MIT). See [React/calendar entries](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/package-lock.json#L10348-L10375), [Zod](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/package-lock.json#L13625-L13637), [Lucide](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/package-lock.json#L8277-L8290) and [Vinext](https://github.com/NeoTech-vietnam/NeoWeb/blob/48570aeb5ef96c83945c404790dfebc5d4b7b811/web/package-lock.json#L12276-L12291). None is required merely to reproduce these small behaviors with NeoMind's existing DOM/canvas setup.

Spotify's REST API is v1; Calendar is v3; Google Identity Services and YouTube's hosted player scripts have stable URLs rather than immutable package versions. Their behavior, account eligibility and terms can change independently of the NeoWeb commit. Retain this source pin for the design reference, check upstream diffs deliberately, and separately smoke-test provider changes. Avoid cloning or polling the entire NeoWeb application at runtime. No music recordings, artwork or Earth texture assets were copied during this research.
