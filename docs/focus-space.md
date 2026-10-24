# Earth FocusSpace

Open **NeoMind: Open Agent Map**, then choose **Enter Earth · Focus Space**. Earth opens into a calm dashboard; **Back to Universe** returns to the agent view. Reduced-motion preferences disable the zoom animation. Agent model controls remain in the universe inspector.

## Focus time

Choose 25 minutes, 50 minutes, a 5-minute break, or a custom 1–240 minute duration. Start, pause/resume and reset are explicit controls. A saved wall-clock deadline keeps the countdown accurate while editing another tab or returning to the universe. Finishing increments the completed-session count once, including after reopening. This is a personal countdown, not a signed agent work receipt. Timer and player preferences are stored in the webview's VS Code state; appointment titles and imported calendars are not persisted there.

## Calendar and focus windows

Choose **Connect calendar** and paste a private HTTPS iCalendar feed into the native password prompt. Supported feeds are Google Calendar's secret iCal address and Outlook's published ICS URL. They stay in VS Code SecretStorage. Calendar data is fetched read-only when connecting, refreshing or changing the range; private feed URLs are never sent to the webview or committed to the project. **Unlink** removes the stored feed.

For other providers or offline use, export an `.ics` file and choose **Import .ics**. Imports stay in memory until the panel is closed. The limit is 1 MiB. Today and seven-day views show upcoming events; selecting an event sets its title/duration, and a free-window button sets a matching countdown. Starting the session is a separate action.

Recurring events, exceptions, cancellations, timezone transitions and all-day events are considered. Unsupported recurrence/timezone data produces a warning and suppresses free-window suggestions. Windows are suggestions based on this feed alone: they do not book appointments, check other calendars or reserve time. Published feeds may refresh more slowly than the provider's application. This version does not offer account OAuth or write access. [Google iCal export guidance](https://support.google.com/calendar/answer/37648)

## Weather

Search for a city and choose a result, or click **Use my current location**. Desktop VS Code webviews deny geolocation, so NeoMind opens a short-lived loopback page in your normal browser. Click its location button and allow the browser permission to share rounded coordinates with NeoMind; NeoMind uses them for an Open-Meteo forecast. The helper expires after two minutes and closes its local server after completion. Coordinates are not saved in the project. Denied permission, offline providers or timeouts show an error and leave city search available; no default city is presented as your actual location.

Current conditions and three/seven-day forecasts use [Open-Meteo](https://open-meteo.com/en/docs), with attribution in the dashboard. Provider terms and availability apply.

## Music

**Original ambient sound** offers Orbital Drift, Quiet Shore and Distant Rain, synthesized locally with Web Audio. Press **Play ambience** to start, select a soundscape and adjust volume. These work without an account, key or downloaded recordings. Ambience continues during the Earth transition, after **Back to Universe**, and while editing another tab. A compact Universe player provides pause/resume, volume and a return to FocusSpace. Use Pause to stop playback; closing the panel or revoking workspace trust also stops it. Reopening never starts audio automatically.

Paste an HTTPS YouTube video or playlist link and choose **Load**, then press play inside the visible player. NeoMind creates a temporary loopback HTTP player document, which embeds YouTube through the [official IFrame API](https://developers.google.com/youtube/iframe_api_reference). The browser supplies that document's real HTTP origin and referrer, avoiding the opaque VS Code webview identity behind YouTube error 153. No public origin or identity header is fabricated. The player stays visible and does not extract or hide YouTube audio. Returning to Universe stops YouTube and closes its local player helper.

**Find a video → Configure search** optionally stores your YouTube Data API v3 key in SecretStorage; search uses the official API. A key is unnecessary for direct links and built-in soundscapes. Quota, key restrictions, video embedding policy and autoplay rules apply. If the provider still rejects embedding, **Open on YouTube** opens the same selection in the browser. Remote VS Code configurations that forward the helper to an HTTPS tunnel currently use that browser fallback; the parent webview does not permit arbitrary remote player origins. Saved links do not load third-party media automatically.

## Installation and verification

Background ambience across views and the loopback YouTube player require extension 0.7.0 and runtime 0.1.0-alpha.7 or later. After an upgrade, run **Developer: Reload Window**, reopen the map, and restart the NeoMind MCP server to pick up backend fixes. This does not require changes to model providers or project `.gitignore`.

`npm run build` and the focused calendar/services/host/UI tests verify state transitions, recurrence boundaries, cancellation, secret handling and provider contracts with isolated data. `node scripts/preview-monitor.mjs` supplies clearly labeled sample calendar/weather responses for visual QA; it does not establish that a real account, location permission or YouTube playback has succeeded.
