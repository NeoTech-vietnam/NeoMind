const { requestBrowserLocation } = require('./focus-location.cjs');
const { createYouTubePlayer } = require('./focus-youtube.cjs');
const calendarKey = 'neomind.focus.calendarFeed', youtubeKey = 'neomind.focus.youtubeApiKey';
const approvedActions = new Set(['status', 'weather', 'weather-location', 'place-search', 'calendar-import', 'calendar-connect', 'calendar-refresh', 'calendar-disconnect', 'youtube-configure', 'youtube-search', 'youtube-open', 'youtube-player', 'youtube-player-stop']);
const calendarActions = new Set(['calendar-import', 'calendar-connect', 'calendar-refresh', 'calendar-disconnect']);
const safeErrors = new Set([
  'Weather requires valid latitude and longitude.', 'Weather is unavailable. Retry or choose a city; no default location was assumed.',
  'City search is unavailable. Retry later or use current location.', 'Calendar could not be refreshed. Check the private ICS link or import an ICS file.',
  'Use a supported HTTPS Google or Outlook ICS feed.', 'Use a supported HTTPS Google or Outlook ICS feed. Other calendars can be imported from an ICS file.',
  'Connect a calendar feed or import an ICS file first.', 'Calendar connection cancelled.', 'Secure storage is unavailable. Import an ICS file instead.',
  'Secure storage is unavailable. Paste a YouTube link instead.', 'YouTube search configuration cancelled.', 'Enter a valid YouTube API key.',
  'Configure a YouTube Data API key for search, or paste a video/playlist link.',
  'YouTube search is unavailable. Check the API key restrictions/quota, or paste a video or playlist link.',
  'Use an HTTPS YouTube link.', 'Request cancelled.', 'Location request cancelled.',
  'YouTube embedding is unavailable in this remote VS Code window. Choose Open on YouTube.',
  'The YouTube player could not start. Choose Open on YouTube or retry.',
  'Location request timed out. Search for a city or try again.', 'The browser location helper could not start. Search for a city.', 'Browser could not open. Search for a city.',
]);
function createFocusHost({ vscode, context, runtime, alive, post }) {
  const pending = new Map();
  let disposed = false, calendarEpoch = 0, calendarSecretTail = Promise.resolve(), youtubeEpoch = 0, youtubeSession = null;
  const live = () => !disposed && alive();
  const configured = async () => ({ calendarConfigured: Boolean(await context.secrets?.get(calendarKey)), youtubeConfigured: Boolean(await context.secrets?.get(youtubeKey)) });
  async function closeYouTube() { const previous = youtubeSession; youtubeSession = null; try { await previous?.close(); } catch {} }
  function calendarSecret(action) {
    const operation = calendarSecretTail.then(action);
    calendarSecretTail = operation.catch(() => {});
    return operation;
  }
  async function calendarPrompt(signal) {
    const cancellation = typeof vscode.CancellationTokenSource === 'function' ? new vscode.CancellationTokenSource() : null;
    const abort = () => cancellation?.cancel();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      return await vscode.window.showInputBox({ title: 'NeoMind: connect calendar', prompt: 'Paste a private Google Calendar or Outlook ICS link. Stored in VS Code SecretStorage; read-only access.', password: true, ignoreFocusOut: true }, cancellation?.token);
    } finally { signal.removeEventListener('abort', abort); cancellation?.dispose(); }
  }
  async function handle(message) {
    if (!live() || message?.type !== 'focus-space' || typeof message.request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(message.request_id)) return;
    if (message.action === 'cancel') { pending.get(message.request_id)?.controller.abort(); return; }
    if (!approvedActions.has(message.action) || pending.has(message.request_id)) return;
    const calendar = calendarActions.has(message.action), epoch = calendar ? ++calendarEpoch : calendarEpoch;
    const youtube = message.action === 'youtube-player' || message.action === 'youtube-player-stop', playerEpoch = youtube ? ++youtubeEpoch : youtubeEpoch;
    if (calendar) for (const [id, request] of pending) if (request.calendar) {
      pending.delete(id); request.controller.abort();
    }
    if (youtube) for (const [id, request] of pending) if (request.youtube) { pending.delete(id); request.controller.abort(); }
    if (pending.size >= 8) return;
    const controller = new AbortController(); pending.set(message.request_id, { controller, calendar, youtube });
    const current = () => live() && !controller.signal.aborted && (!calendar || epoch === calendarEpoch) && (!youtube || playerEpoch === youtubeEpoch);
    const timeout = setTimeout(() => controller.abort(), ['weather-location', 'calendar-connect', 'youtube-configure'].includes(message.action) ? 125000 : 25000); timeout.unref?.();
    const options = { signal: controller.signal };
    try {
      let data;
      switch (message.action) {
        case 'status': data = await configured(); break;
        case 'weather': data = await runtime.focusWeather(message.latitude, message.longitude, options); break;
        case 'weather-location': {
          const location = await requestBrowserLocation({ signal: controller.signal, open: url => vscode.env.openExternal(vscode.Uri.parse(url)) });
          data = await runtime.focusWeather(location.latitude, location.longitude, options); break;
        }
        case 'place-search': data = await runtime.focusPlaceSearch(message.query, options); break;
        case 'calendar-import': data = { ...runtime.focusCalendar(message.ics, message), configured: false }; break;
        case 'calendar-connect': {
          if (!context.secrets) throw new Error('Secure storage is unavailable. Import an ICS file instead.');
          const feed = await calendarPrompt(controller.signal);
          if (!feed || !current()) throw new Error('Calendar connection cancelled.');
          data = await runtime.focusCalendarFeed(feed, message, options);
          if (!current()) throw new Error('Calendar connection cancelled.');
          await calendarSecret(async () => { if (current()) await context.secrets.store(calendarKey, feed); });
          if (!current()) throw new Error('Calendar connection cancelled.');
          data = { ...data, configured: true }; break;
        }
        case 'calendar-refresh': {
          const feed = await calendarSecret(() => context.secrets?.get(calendarKey));
          if (!current()) throw new Error('Calendar connection cancelled.');
          if (!feed) throw new Error('Connect a calendar feed or import an ICS file first.');
          data = { ...await runtime.focusCalendarFeed(feed, message, options), configured: true }; break;
        }
        // An accepted unlink waits for an already-started write, even if a later
        // calendar action supersedes its UI response. Old writes cannot resurrect it.
        case 'calendar-disconnect': await calendarSecret(() => context.secrets?.delete(calendarKey)); data = { events: [], warnings: [], slots: [], configured: false }; break;
        case 'youtube-configure': {
          if (!context.secrets) throw new Error('Secure storage is unavailable. Paste a YouTube link instead.');
          const key = await vscode.window.showInputBox({ title: 'NeoMind: YouTube search API key', prompt: 'Optional YouTube Data API v3 key for search. Video/playlist links and built-in ambient music work without a key.', password: true, ignoreFocusOut: true });
          if (!key || !live() || controller.signal.aborted) throw new Error('YouTube search configuration cancelled.');
          if (key.length > 256 || /[\x00-\x20\x7f]/.test(key)) throw new Error('Enter a valid YouTube API key.');
          await context.secrets.store(youtubeKey, key); data = await configured(); break;
        }
        case 'youtube-search': {
          const key = await context.secrets?.get(youtubeKey);
          if (!key) throw new Error('Configure a YouTube Data API key for search, or paste a video/playlist link.');
          data = await runtime.focusYouTubeSearch(message.query, key, options); break;
        }
        case 'youtube-player': {
          await closeYouTube();
          if (!current()) throw new Error('Request cancelled.');
          let player;
          try {
            player = await createYouTubePlayer({ url: message.url, signal: controller.signal,
              ...(typeof vscode.env.asExternalUri === 'function' ? { asExternalUri: async url => (await vscode.env.asExternalUri(vscode.Uri.parse(url))).toString() } : {}) });
          } catch (error) {
            if (error instanceof Error && error.message === 'Embedded YouTube is unavailable through this remote connection. Choose Open on YouTube.')
              throw new Error('YouTube embedding is unavailable in this remote VS Code window. Choose Open on YouTube.');
            throw new Error('The YouTube player could not start. Choose Open on YouTube or retry.');
          }
          if (!current()) { await player.close(); throw new Error('Request cancelled.'); }
          let endpoint;
          try { endpoint = new URL(player.url); } catch { await player.close(); throw new Error('The YouTube player could not start. Choose Open on YouTube or retry.'); }
          if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || !endpoint.port || endpoint.username || endpoint.password) {
            await player.close(); throw new Error('YouTube embedding is unavailable in this remote VS Code window. Choose Open on YouTube.');
          }
          youtubeSession = player; data = { url: endpoint.href }; break;
        }
        case 'youtube-player-stop': await closeYouTube(); data = { stopped: true }; break;
        case 'youtube-open': {
          let url;
          try { url = new URL(message.url); } catch { throw new Error('Use an HTTPS YouTube link.'); }
          if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname) || url.username || url.password || url.port)
            throw new Error('Use an HTTPS YouTube link.');
          if (!live() || controller.signal.aborted) throw new Error('Request cancelled.');
          data = { opened: await vscode.env.openExternal(vscode.Uri.parse(url.href)) }; break;
        }
      }
      if (current()) await post({ type: 'focus-space-result', request_id: message.request_id, action: message.action, ok: true, data });
    } catch (error) {
      // Never reflect provider URLs, keys, private feeds or response bodies in the webview.
      const text = error instanceof Error && safeErrors.has(error.message) ? error.message : 'Focus service unavailable. Retry, choose another source, or use an offline feature.';
      if (live() && (!calendar || epoch === calendarEpoch) && (!youtube || playerEpoch === youtubeEpoch)) await post({ type: 'focus-space-result', request_id: message.request_id, action: message.action, ok: false, error: controller.signal.aborted ? 'Request cancelled or timed out. Retry when ready.' : text });
    } finally { clearTimeout(timeout); if (pending.get(message.request_id)?.controller === controller) pending.delete(message.request_id); }
  }
  return { handle, dispose() { disposed = true; youtubeEpoch++; for (const item of pending.values()) item.controller.abort(); pending.clear(); void closeYouTube(); } };
}
module.exports = { createFocusHost };
