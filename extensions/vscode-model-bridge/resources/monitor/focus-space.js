/* Original NeoMind FocusSpace UI. Provider requests are mediated by the extension host. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NeoMindFocusSpace = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const minutes = value => clamp(Math.round(Number(value) || 25), 1, 240);
  const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const text = (value, max = 180) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';
  function createTimer(duration = 25) {
    const durationMs = minutes(duration) * 60_000;
    return { durationMs, remainingMs: durationMs, deadline: null, status: 'idle', sessionId: null, lastCompletedId: null, completedSessions: 0 };
  }
  function sanitizeTimer(value, now) {
    const raw = plain(value), timer = createTimer(Number(raw.durationMs) / 60_000);
    timer.remainingMs = Number.isFinite(raw.remainingMs) ? clamp(raw.remainingMs, 0, timer.durationMs) : timer.durationMs;
    timer.completedSessions = Number.isSafeInteger(raw.completedSessions) ? clamp(raw.completedSessions, 0, 1_000_000) : 0;
    timer.sessionId = text(raw.sessionId, 100) || null; timer.lastCompletedId = text(raw.lastCompletedId, 100) || null;
    timer.status = ['idle', 'running', 'paused', 'completed'].includes(raw.status) ? raw.status : 'idle';
    if (timer.status === 'running' && Number.isFinite(raw.deadline) && raw.deadline >= 0) timer.deadline = Math.min(raw.deadline, now + timer.durationMs);
    else if (timer.status === 'running') timer.status = 'paused';
    return timer;
  }
  function tick(timer, now) {
    if (timer.status !== 'running') return timer;
    timer.remainingMs = clamp(Math.min(timer.remainingMs, timer.deadline - now), 0, timer.durationMs);
    if (timer.remainingMs === 0) {
      if (timer.sessionId && timer.lastCompletedId !== timer.sessionId) timer.completedSessions++;
      timer.lastCompletedId = timer.sessionId; timer.status = 'completed'; timer.deadline = null;
    }
    return timer;
  }
  function restoreTimer(raw, now = Date.now()) { return tick(sanitizeTimer(raw, now), now); }
  function updateTimer(raw, action, now = Date.now(), options = {}) {
    let timer = restoreTimer(raw, now);
    if (action === 'reset' || action === 'duration') {
      const next = createTimer(action === 'duration' ? options.minutes : timer.durationMs / 60_000);
      return { ...next, completedSessions: timer.completedSessions, lastCompletedId: timer.lastCompletedId };
    }
    if (action === 'start' && timer.status !== 'running') {
      if (timer.remainingMs === 0) timer.remainingMs = timer.durationMs;
      if (!timer.sessionId || timer.status === 'completed') timer.sessionId = `focus-${now}-${timer.completedSessions}`;
      timer.status = 'running'; timer.deadline = now + timer.remainingMs;
    } else if (action === 'pause' && timer.status === 'running') { timer.status = 'paused'; timer.deadline = null; }
    return timer;
  }
  function parseYouTubeUrl(input, origin) {
    try {
      const url = new URL(String(input));
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      const host = url.hostname.toLowerCase();
      if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(host)) return null;
      const parts = url.pathname.split('/').filter(Boolean);
      let videoId = host === 'youtu.be' ? parts[0] : url.pathname === '/watch' ? url.searchParams.get('v') : ['embed', 'shorts', 'live'].includes(parts[0]) ? parts[1] : null;
      let playlistId = url.searchParams.get('list');
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId ?? '')) videoId = null;
      if (!/^[A-Za-z0-9_-]{2,100}$/.test(playlistId ?? '')) playlistId = null;
      if (!videoId && !playlistId) return null;
      const embed = new URL(`https://www.youtube-nocookie.com/embed/${videoId ?? 'videoseries'}`);
      embed.searchParams.set('enablejsapi', '1'); embed.searchParams.set('playsinline', '1'); embed.searchParams.set('autoplay', '0');
      if (playlistId) embed.searchParams.set('list', playlistId);
      if (origin) { try { const site = new URL(origin); if (['https:', 'http:'].includes(site.protocol)) embed.searchParams.set('origin', site.origin); } catch {} }
      const canonical = new URL(videoId ? 'https://www.youtube.com/watch' : 'https://www.youtube.com/playlist');
      if (videoId) canonical.searchParams.set('v', videoId);
      if (playlistId) canonical.searchParams.set('list', playlistId);
      return { videoId, playlistId, url: canonical.href, embedUrl: embed.href };
    } catch { return null; }
  }
  function create({ vscode, onViewChange = () => {}, getTransitionOrigin } = {}) {
    if (typeof document === 'undefined' || !document.getElementById('focus-space') || !vscode?.postMessage) return null;
    const byId = id => document.getElementById(id), disposers = [], pending = new Map();
    const saved = plain(plain(vscode.getState?.()).focusSpace);
    let timer = restoreTimer(saved.timer), view = saved.view === 'focus' ? 'focus' : 'universe', alive = true, sequence = 0, transition, midpoint, transitionTarget = null;
    let playlist = ['orbital', 'shore', 'rain'].includes(saved.playlist) ? saved.playlist : 'orbital';
    let volume = Number.isFinite(saved.volume) ? clamp(saved.volume, 0, 1) : .35;
    let youtubeUrl = parseYouTubeUrl(saved.youtubeUrl)?.url ?? '', haltMedia = () => {};
    let calendarConfigured = false, importedICS = '', refreshAgenda = () => {}, uiEpoch = 0, agendaRevision = 0;
    const setText = (id, value) => { const node = byId(id); if (node) node.textContent = String(value ?? ''); };
    const listen = (target, event, handler) => { if (target) { target.addEventListener(event, handler); disposers.push(() => target.removeEventListener(event, handler)); } };
    const bind = (id, event, handler) => listen(byId(id), event, handler);
    const notice = message => setText('fs-status', text(message, 300));
    const element = (tag, value = '', className = '') => { const node = document.createElement(tag); node.textContent = String(value); node.className = className; return node; };
    const choice = (label, handler, className = 'fs-button fs-small fs-ghost') => { const node = element('button', label, className); node.type = 'button'; node.addEventListener('click', handler); return node; };
    function persist() {
      try { vscode.setState?.({ ...plain(vscode.getState?.()), focusSpace: { version: 1, view, timer: { ...timer }, playlist, volume, youtubeUrl } }); } catch { notice('Your preferences could not be saved in this window.'); }
    }
    function renderTimer() {
      const seconds = Math.ceil(timer.remainingMs / 1000);
      setText('fs-clock', `${Math.floor(seconds / 60).toString().padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}`);
      setText('fs-timer-label', { idle: 'READY WHEN YOU ARE', running: 'JUST THIS MOMENT', paused: 'A MOMENT TO BREATHE', completed: 'ONE SMALL STEP, COMPLETE' }[timer.status]);
      setText('fs-start', timer.status === 'running' ? 'Ⅱ Pause focus' : timer.status === 'paused' ? '▶ Resume focus' : timer.status === 'completed' ? '▶ Begin again' : '▶ Start focus');
      setText('fs-sessions', `${timer.completedSessions} ${timer.completedSessions === 1 ? 'session' : 'sessions'} completed`);
      byId('fs-ring')?.setAttribute('stroke-dashoffset', String(clamp(100 * (1 - timer.remainingMs / timer.durationMs), 0, 100)));
      for (const duration of [25, 50, 5]) byId(`fs-duration-${duration}`)?.setAttribute('aria-pressed', String(timer.durationMs === duration * 60_000));
      if (byId('fs-duration') && document.activeElement !== byId('fs-duration')) byId('fs-duration').value = String(timer.durationMs / 60_000);
    }
    function changeTimer(action, options) { timer = updateTimer(timer, action, Date.now(), options); renderTimer(); persist(); }
    function cancelPending(matches = () => true) {
      for (const [id, item] of pending) {
        if (!matches(item)) continue;
        window.clearTimeout(item.timeout); pending.delete(id);
        vscode.postMessage({ type: 'focus-space', action: 'cancel', request_id: id }); const error = new Error('Request cancelled.'); error.name = 'AbortError'; item.reject(error);
      }
      if (byId('fs-cancel')) byId('fs-cancel').hidden = ![...pending.values()].some(item => item.action !== 'status');
    }
    function cancelRequests() { uiEpoch++; agendaRevision++; cancelPending(); }
    function clearTransition() {
      window.clearTimeout(transition); window.clearTimeout(midpoint); transitionTarget = null;
      if (byId('fs-transition')) byId('fs-transition').hidden = true;
      document.body.dataset.focusTransition = '';
    }
    function transitionPoint(destination) {
      const width = window.innerWidth || 1280, height = window.innerHeight || 800;
      if (destination === 'universe') {
        try { const point = getTransitionOrigin?.(); if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) return { x: clamp(point.x, 0, width), y: clamp(point.y, 0, height), radius: clamp(point.radius || 40, 8, 250) }; } catch {}
      }
      const rect = byId(destination === 'focus' ? 'fs-earth-stage' : 'field')?.getBoundingClientRect?.();
      return rect?.width ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, radius: destination === 'focus' ? 59 : 40 } : { x: width * .5, y: height * .45, radius: 50 };
    }
    function showView(next, animate = true) {
      if (!alive || transitionTarget === next) return;
      const previous = document.body.dataset.view || 'universe'; clearTransition(); view = next; persist();
      const commit = () => {
        document.body.dataset.view = next;
        if (next === 'universe') { stopYouTube(); cancelRequests(); } else { byId('focus-space')?.focus(); if (calendarConfigured || importedICS) refreshAgenda(); }
        renderAudio();
        onViewChange(next);
      };
      const overlay = byId('fs-transition'), reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (!animate || reduced || previous === next || !overlay) { commit(); return; }
      stopYouTube(); const from = transitionPoint(previous), width = window.innerWidth || 1280, height = window.innerHeight || 800;
      const setPoint = (prefix, point) => { overlay.style.setProperty(`--fs-${prefix}-x`, `${point.x}px`); overlay.style.setProperty(`--fs-${prefix}-y`, `${point.y}px`); overlay.style.setProperty(`--fs-${prefix}-scale`, String(point.radius / 80)); };
      setPoint('from', from); setPoint('to', transitionPoint(next));
      overlay.style.setProperty('--fs-mid-x', `${width / 2}px`); overlay.style.setProperty('--fs-mid-y', `${height / 2}px`); overlay.style.setProperty('--fs-cover', String(Math.hypot(width, height) / 130));
      transitionTarget = next; overlay.hidden = false; document.body.dataset.focusTransition = next === 'focus' ? 'entering' : 'returning';
      midpoint = window.setTimeout(() => { if (!alive) return; commit(); setPoint('to', transitionPoint(next)); }, 620);
      transition = window.setTimeout(clearTransition, 1260);
    }
    function request(action, fields = {}) {
      if (!alive) return Promise.reject(new Error('FocusSpace is closed.'));
      const request_id = `focus-${Date.now()}-${++sequence}-${Math.random().toString(36).slice(2, 9)}`;
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          if (!pending.delete(request_id)) return;
          vscode.postMessage({ type: 'focus-space', action: 'cancel', request_id });
          if (byId('fs-cancel')) byId('fs-cancel').hidden = ![...pending.values()].some(item => item.action !== 'status');
          reject(new Error('The request timed out. Try again when you are ready.'));
        }, ['weather-location', 'calendar-connect', 'youtube-configure'].includes(action) ? 120_000 : 20_000);
        pending.set(request_id, { action, timeout, resolve, reject });
        if (byId('fs-cancel') && action !== 'status') byId('fs-cancel').hidden = false;
        vscode.postMessage({ type: 'focus-space', action, request_id, ...fields });
      });
    }
    async function perform(action, fields, apply, message = 'Loading…') {
      notice(message);
      try { const data = await request(action, fields); if (alive) { apply?.(data); notice('Up to date. A little more space to focus.'); } }
      catch (error) { if (alive && error?.name !== 'AbortError') notice(error instanceof Error ? error.message : 'This connection is unavailable. Try again.'); }
    }
    listen(window, 'message', event => {
      const message = plain(event.data), item = pending.get(message.request_id);
      if (message.type !== 'focus-space-result' || !item || item.action !== message.action || typeof message.ok !== 'boolean') return;
      pending.delete(message.request_id); window.clearTimeout(item.timeout);
      if (byId('fs-cancel')) byId('fs-cancel').hidden = ![...pending.values()].some(entry => entry.action !== 'status');
      if (message.ok) item.resolve(message.data); else item.reject(new Error(text(message.error, 300) || 'This connection is unavailable. Try again.'));
    });
    bind('enter-focus-space', 'click', () => showView('focus')); bind('fs-back', 'click', () => showView('universe'));
    bind('fs-cancel', 'click', () => { cancelRequests(); notice('Request cancelled.'); });
    bind('fs-start', 'click', () => changeTimer(timer.status === 'running' ? 'pause' : 'start'));
    bind('fs-reset', 'click', () => changeTimer('reset'));
    for (const duration of [25, 50, 5]) bind(`fs-duration-${duration}`, 'click', () => changeTimer('duration', { minutes: duration }));
    bind('fs-duration-form', 'submit', event => { event.preventDefault(); changeTimer('duration', { minutes: byId('fs-duration').value }); });
    function agendaRange() {
      const from = new Date(), to = new Date(from); to.setHours(0, 0, 0, 0); to.setDate(to.getDate() + (byId('fs-agenda-range')?.value === '7' ? 7 : 1));
      return { from: from.toISOString(), to: to.toISOString(), durationMinutes: minutes(timer.durationMs / 60_000), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
    }
    function chooseWindow(start, end, label) {
      const length = (Date.parse(end) - Date.parse(start)) / 60_000;
      if (!Number.isFinite(length) || length <= 0) return;
      changeTimer('duration', { minutes: length });
      if (byId('fs-task')) byId('fs-task').value = text(label);
      notice('Time set. Start when you are ready.');
    }
    function applyAgenda(payload) {
      const data = plain(payload), rows = [], gaps = [];
      calendarConfigured = data.configured === true;
      for (const raw of (Array.isArray(data.events) ? data.events : []).slice(0, 150)) {
        const event = plain(raw), start = Date.parse(event.start), end = Date.parse(event.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const row = choice('', () => chooseWindow(event.start, event.end, event.title), 'fs-event');
        const body = element('span'), name = element('strong', text(event.title) || 'Untitled event');
        const when = event.allDay ? `${String(event.start).slice(0, 10)} · All day` : new Date(start).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
        body.append(name, element('small', `${when} · ${event.busy === false ? 'Free' : 'Busy'}`)); row.append(body); rows.push(row);
      }
      for (const raw of (Array.isArray(data.slots) ? data.slots : []).slice(0, 12)) {
        const slot = plain(raw), start = Date.parse(slot.start), end = Date.parse(slot.end);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
        const label = `${new Date(start).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })} · ${Math.round((end - start) / 60_000)} min free`;
        gaps.push(choice(label, () => chooseWindow(slot.start, slot.end, 'A little space to focus'), 'fs-button fs-small fs-slot'));
      }
      byId('fs-agenda-list')?.replaceChildren(...rows);
      byId('fs-slots')?.replaceChildren(...(gaps.length ? gaps : [element('p', 'No free window found in this range. Choose your own pace.', 'fs-muted')]));
      setText('fs-agenda-status', `${importedICS ? 'Imported calendar' : calendarConfigured ? 'Connected calendar' : 'Calendar'} · ${rows.length ? `${rows.length} upcoming ${rows.length === 1 ? 'event' : 'events'}` : 'No events in this window'}`);
      setText('fs-agenda-warnings', (Array.isArray(data.warnings) ? data.warnings : []).slice(0, 5).map(warning => text(warning, 180)).filter(Boolean).join(' '));
      if (byId('fs-calendar-disconnect')) byId('fs-calendar-disconnect').hidden = !calendarConfigured && !importedICS;
      setText('fs-calendar-connect', calendarConfigured ? 'Change calendar' : 'Connect calendar');
    }
    function calendarRequest(action, fields, message, apply = applyAgenda) {
      const revision = ++agendaRevision; cancelPending(item => item.action.startsWith('calendar-'));
      return perform(action, fields, data => { if (revision === agendaRevision) apply(data); }, message);
    }
    refreshAgenda = () => calendarRequest(importedICS ? 'calendar-import' : 'calendar-refresh', { ...agendaRange(), ...(importedICS ? { ics: importedICS } : {}) }, 'Refreshing your horizon…');
    bind('fs-calendar-connect', 'click', () => { importedICS = ''; void calendarRequest('calendar-connect', agendaRange(), 'Complete the calendar connection prompt in VS Code.'); });
    bind('fs-calendar-refresh', 'click', refreshAgenda); bind('fs-agenda-range', 'change', refreshAgenda);
    bind('fs-calendar-import', 'click', () => byId('fs-calendar-file')?.click());
    bind('fs-calendar-file', 'change', async () => {
      const file = byId('fs-calendar-file')?.files?.[0]; if (!file) return;
      const revision = ++agendaRevision; cancelPending(item => item.action.startsWith('calendar-'));
      try {
        if (file.size > 1_048_576) throw new Error('Choose an .ics file no larger than 1 MB.');
        const content = await file.text(); if (!alive || revision !== agendaRevision) return;
        if (content.length > 1_048_576 || !content.includes('BEGIN:VCALENDAR')) throw new Error('This file does not contain a supported iCalendar calendar (1 MB maximum).');
        importedICS = content; await refreshAgenda();
      } catch (error) { notice(error instanceof Error ? error.message : 'The calendar file could not be read.'); }
      finally { if (byId('fs-calendar-file')) byId('fs-calendar-file').value = ''; }
    });
    bind('fs-calendar-disconnect', 'click', () => { importedICS = ''; calendarConfigured = false; applyAgenda({ configured: false, events: [], slots: [] }); void calendarRequest('calendar-disconnect', {}, 'Unlinking calendar…', () => setText('fs-agenda-status', 'Calendar unlinked. Your agenda is no longer displayed.')); });
    let weatherData = null, forecastDays = 3, weatherLabel = 'Your location', weatherRevision = 0;
    function condition(code) {
      return code === 0 ? ['☀', 'Clear skies'] : code <= 2 ? ['⛅', 'Partly cloudy'] : code === 3 ? ['☁', 'Overcast'] : code <= 48 ? ['≋', 'Foggy'] : code < 70 ? ['☂', 'Rain'] : code < 80 ? ['❄', 'Snow'] : code < 90 ? ['☂', 'Showers'] : ['ϟ', 'Thunderstorms'];
    }
    const degrees = value => Number.isFinite(value) ? `${Math.round(value)}°` : '—°';
    function renderWeather() {
      if (!weatherData) return;
      const current = plain(weatherData.current), code = Number.isFinite(current.weatherCode) ? current.weatherCode : null;
      const [icon, label] = code === null ? ['☁', 'Conditions unavailable'] : condition(code);
      const detail = element('div'); detail.append(element('strong', degrees(current.temperature)), element('p', `${weatherLabel} · ${label}`, 'fs-muted'));
      byId('fs-weather-current')?.replaceChildren(element('span', icon, 'fs-weather-glyph'), detail);
      setText('fs-weather-status', `Feels like ${degrees(current.apparent)}${Number.isFinite(current.windSpeed) ? ` · Wind ${Math.round(current.windSpeed)} km/h` : ''} · °C`);
      const days = [];
      for (const raw of (Array.isArray(weatherData.daily) ? weatherData.daily : []).slice(0, forecastDays)) {
        const day = plain(raw); if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date ?? '')) continue;
        const date = new Date(`${day.date}T12:00:00Z`); if (!Number.isFinite(date.getTime())) continue;
        const row = element('div', '', 'fs-forecast-day');
        row.append(element('span', date.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })), element('b', Number.isFinite(day.weatherCode) ? condition(day.weatherCode)[0] : '—'), element('strong', `${degrees(day.minimum)} / ${degrees(day.maximum)}`));
        if (Number.isFinite(day.rainProbability)) row.append(element('small', `${Math.round(clamp(day.rainProbability, 0, 100))}% rain`)); days.push(row);
      }
      byId('fs-forecast')?.replaceChildren(...days);
      setText('fs-weather-attribution', text(weatherData.attribution, 180) || 'Weather by Open-Meteo · CC BY 4.0');
      for (const count of [3, 7]) byId(`fs-forecast-${count}`)?.setAttribute('aria-pressed', String(forecastDays === count));
    }
    function applyWeather(data) { weatherData = plain(data); renderWeather(); }
    function loadWeather(latitude, longitude, name) {
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
      weatherLabel = text(name) || 'Your location'; const revision = ++weatherRevision;
      void perform('weather', { latitude, longitude }, data => { if (revision === weatherRevision) applyWeather(data); }, 'Looking outside your window…');
    }
    bind('fs-place-form', 'submit', event => {
      event.preventDefault(); const query = text(byId('fs-place-query')?.value, 120).trim(); if (!query) return;
      void perform('place-search', { query }, data => {
        const rows = [];
        for (const raw of (Array.isArray(data) ? data : []).slice(0, 8)) {
          const place = plain(raw); if (!Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) continue;
          rows.push(choice([text(place.name, 100), text(place.country, 80)].filter(Boolean).join(', '), () => { byId('fs-place-results')?.replaceChildren(); loadWeather(place.latitude, place.longitude, place.name); }));
        }
        byId('fs-place-results')?.replaceChildren(...rows); setText('fs-weather-status', rows.length ? 'Choose a location above.' : 'No city found. Try a nearby city.');
      }, 'Finding your corner of Earth…');
    });
    bind('fs-weather-location', 'click', () => {
      const epoch = uiEpoch;
      const fallback = () => {
        if (!alive || epoch !== uiEpoch) return;
        weatherLabel = 'Your location'; const revision = ++weatherRevision;
        void perform('weather-location', {}, data => { if (revision === weatherRevision) applyWeather(data); }, 'Complete the browser location prompt, or cancel and search for a city.');
      };
      notice('Allow location access, or search for a city.');
      if (!window.navigator?.geolocation?.getCurrentPosition) return fallback();
      try { window.navigator.geolocation.getCurrentPosition(position => { if (alive && epoch === uiEpoch) loadWeather(position.coords.latitude, position.coords.longitude, 'Your location'); }, fallback, { timeout: 12_000, maximumAge: 600_000, enableHighAccuracy: false }); } catch { fallback(); }
    });
    for (const count of [3, 7]) bind(`fs-forecast-${count}`, 'click', () => { forecastDays = count; renderWeather(); });
    let youtubeFrame = null, youtubeOrigin = null, youtubeLoading = false, youtubeRevision = 0;
    function stopYouTube() {
      const started = youtubeFrame || youtubeLoading;
      youtubeRevision++; youtubeFrame = null; youtubeOrigin = null; youtubeLoading = false;
      byId('fs-youtube-player')?.replaceChildren(); if (byId('fs-youtube-player')) byId('fs-youtube-player').hidden = true;
      if (started) void request('youtube-player-stop').catch(() => {});
    }
    async function loadYouTube(input) {
      const selected = parseYouTubeUrl(input);
      if (!selected) { setText('fs-youtube-status', 'Choose a valid HTTPS YouTube video or playlist link.'); return; }
      stopYouTube(); haltAudio(); youtubeUrl = selected.url; persist();
      if (byId('fs-youtube-url')) byId('fs-youtube-url').value = youtubeUrl;
      if (byId('fs-youtube-open')) byId('fs-youtube-open').hidden = false;
      setText('fs-youtube-status', 'Preparing a local player with its own HTTP identity…');
      const revision = youtubeRevision; youtubeLoading = true;
      try {
        const result = await request('youtube-player', { url: selected.url });
        if (!alive || view !== 'focus' || revision !== youtubeRevision) return;
        const endpoint = new URL(result.url);
        if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || !endpoint.port || endpoint.username || endpoint.password) throw new Error('This player is unavailable in the current window. Choose Open on YouTube.');
        const frame = element('iframe'); frame.id = 'fs-youtube-iframe'; frame.title = 'YouTube music player'; frame.src = endpoint.href;
        frame.allow = 'encrypted-media; picture-in-picture; fullscreen'; frame.referrerPolicy = 'strict-origin-when-cross-origin'; frame.setAttribute('allowfullscreen', '');
        youtubeFrame = frame; youtubeOrigin = endpoint.origin;
        byId('fs-youtube-player')?.replaceChildren(frame); if (byId('fs-youtube-player')) byId('fs-youtube-player').hidden = false;
        setText('fs-youtube-status', 'Press play in the visible player. Nothing starts automatically.');
      } catch (error) {
        if (alive && revision === youtubeRevision && error?.name !== 'AbortError') setText('fs-youtube-status', error instanceof Error ? error.message : 'The player could not start. Choose Open on YouTube.');
      } finally { if (revision === youtubeRevision) youtubeLoading = false; }
    }
    listen(window, 'message', event => {
      if (!alive || !youtubeFrame || event.source !== youtubeFrame.contentWindow || event.origin !== youtubeOrigin) return;
      const value = plain(event.data);
      if (value.type !== 'neomind-youtube') return;
      if (value.event === 'error') {
        const code = Number(value.code); stopYouTube();
        setText('fs-youtube-status', code === 153 ? 'YouTube error 153: player identity was rejected. Choose Open on YouTube.' : 'This video cannot play here. Try another video or Open on YouTube.');
      } else if (value.event === 'ready') setText('fs-youtube-status', 'Player ready. Press play in the visible player.');
    });
    bind('fs-youtube-form', 'submit', event => { event.preventDefault(); void loadYouTube(byId('fs-youtube-url')?.value); });
    bind('fs-youtube-open', 'click', () => { if (youtubeUrl) void perform('youtube-open', { url: youtubeUrl }, null, 'Opening YouTube in your browser…'); });
    bind('fs-youtube-configure', 'click', () => { void perform('youtube-configure', {}, () => setText('fs-youtube-status', 'Search connection saved. Choose a search below.'), 'Complete the YouTube search configuration prompt in VS Code.'); });
    bind('fs-youtube-search-form', 'submit', event => {
      event.preventDefault(); const query = text(byId('fs-youtube-query')?.value, 120).trim(); if (!query) return;
      void perform('youtube-search', { query }, data => {
        const rows = [];
        for (const raw of (Array.isArray(data) ? data : []).slice(0, 10)) {
          const video = plain(raw); if (!/^[A-Za-z0-9_-]{11}$/.test(video.id ?? '')) continue;
          rows.push(choice(text(video.title) || 'Untitled video', () => loadYouTube(`https://www.youtube.com/watch?v=${video.id}`)));
        }
        byId('fs-youtube-results')?.replaceChildren(...rows); setText('fs-youtube-status', rows.length ? 'Choose a result to load its visible player.' : 'No videos found. Try another search.');
      }, 'Searching YouTube…');
    });
    let audio = null, master = null, audioSources = [], audioStarting = false, audioEpoch = 0, backgroundAudioShown = false;
    function renderAudio() {
      const playing = Boolean(audio && !audioStarting);
      for (const id of ['fs-audio-toggle', 'fs-background-toggle']) {
        byId(id)?.setAttribute('aria-pressed', String(playing)); setText(id, playing ? 'Ⅱ Pause ambience' : '▶ Play ambience');
      }
      if (byId('focus-space')) byId('focus-space').dataset.sound = playing ? 'playing' : 'paused';
      if (byId('fs-background-audio')) byId('fs-background-audio').hidden = view !== 'universe' || !backgroundAudioShown;
      setText('fs-background-track', { orbital: 'Orbital drift', shore: 'Quiet shore', rain: 'Distant rain' }[playlist]);
      setText('fs-background-status', playing ? 'Playing across NeoMind views' : 'Paused · resume when ready');
      for (const id of ['fs-volume', 'fs-background-volume']) if (byId(id)) byId(id).value = String(Math.round(volume * 100));
    }
    function haltAudio() {
      audioEpoch++; audioStarting = false;
      for (const source of audioSources) { try { source.stop(); } catch {} } audioSources = [];
      const previous = audio; audio = null; master = null;
      try { const closed = previous?.close(); closed?.catch?.(() => {}); } catch {}
      renderAudio();
    }
    async function startAudio() {
      if (audio || audioStarting || !alive || document.hidden) return;
      const Context = window.AudioContext ?? window.webkitAudioContext;
      if (!Context) { setText('fs-audio-status', 'Ambient sound is unavailable in this browser. You can still use a YouTube link.'); return; }
      stopYouTube(); backgroundAudioShown = true; audioStarting = true; const epoch = ++audioEpoch; renderAudio();
      try {
        const context = new Context(); audio = context; await context.resume();
        if (!alive || epoch !== audioEpoch) { if (audio === context) haltAudio(); return; }
        master = context.createGain(); master.gain.value = 0; master.gain.setTargetAtTime(volume * .22, context.currentTime, .8); master.connect(context.destination);
        const notes = playlist === 'orbital' ? [130.8128, 196, 261.6256] : playlist === 'shore' ? [146.8324, 220] : [174.6141, 261.6256];
        for (const [index, frequency] of notes.entries()) {
          const oscillator = context.createOscillator(), gain = context.createGain();
          oscillator.type = 'sine'; oscillator.frequency.value = frequency + index * .08;
          gain.gain.value = playlist === 'orbital' ? .13 : .035; oscillator.connect(gain); gain.connect(master); oscillator.start(); audioSources.push(oscillator);
        }
        const rate = Math.min(context.sampleRate || 48_000, 48_000), buffer = context.createBuffer(1, rate * 4, rate), data = buffer.getChannelData(0);
        let seed = 0x4e454f, smooth = 0;
        for (let i = 0; i < data.length; i++) { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; const noise = ((seed >>> 0) / 0xffffffff) * 2 - 1; smooth = smooth * .97 + noise * .03; data[i] = playlist === 'rain' ? noise * .12 : smooth * .8; }
        const source = context.createBufferSource(), filter = context.createBiquadFilter(), gain = context.createGain();
        source.buffer = buffer; source.loop = true; filter.type = 'lowpass'; filter.frequency.value = playlist === 'rain' ? 2200 : playlist === 'shore' ? 650 : 280; filter.Q.value = .5;
        gain.gain.value = playlist === 'orbital' ? .12 : .55; source.connect(filter); filter.connect(gain); gain.connect(master); source.start(); audioSources.push(source);
        setText('fs-audio-status', 'Original synthesized sound · continues in Universe.');
      } catch { if (epoch === audioEpoch) { haltAudio(); setText('fs-audio-status', 'Sound could not start. Try Play again, or use a YouTube link.'); } }
      finally { if (epoch === audioEpoch) { audioStarting = false; renderAudio(); } }
    }
    bind('fs-audio-toggle', 'click', () => { if (audio || audioStarting) haltAudio(); else void startAudio(); });
    bind('fs-background-toggle', 'click', () => { if (audio || audioStarting) haltAudio(); else void startAudio(); });
    bind('fs-background-focus', 'click', () => showView('focus'));
    bind('fs-playlist', 'change', () => { const wasPlaying = !!audio; haltAudio(); playlist = ['orbital', 'shore', 'rain'].includes(byId('fs-playlist')?.value) ? byId('fs-playlist').value : 'orbital'; persist(); if (wasPlaying) void startAudio(); });
    function changeVolume(id) { volume = clamp(Number(byId(id)?.value) || 0, 0, 100) / 100; if (master && audio) master.gain.setTargetAtTime(volume * .22, audio.currentTime, .05); setText('fs-volume-value', `${Math.round(volume * 100)}%`); renderAudio(); persist(); }
    bind('fs-volume', 'input', () => changeVolume('fs-volume'));
    bind('fs-background-volume', 'input', () => changeVolume('fs-background-volume'));
    haltMedia = () => { stopYouTube(); haltAudio(); };
    const pulse = window.setInterval(() => {
      if (!alive || timer.status !== 'running') return;
      const previous = timer.status; timer = updateTimer(timer, 'tick'); renderTimer();
      if (previous !== timer.status) { persist(); notice('Focus session complete. Take a breath before the next one.'); }
    }, 1000);
    listen(document, 'visibilitychange', () => { if (byId('focus-space')) byId('focus-space').dataset.hidden = String(document.hidden); if (document.hidden) stopYouTube(); });
    listen(window, 'pagehide', () => { timer = updateTimer(timer, 'tick'); persist(); haltMedia(); cancelRequests(); });
    setText('fs-date', new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }));
    if (byId('fs-playlist')) byId('fs-playlist').value = playlist;
    if (byId('fs-volume')) byId('fs-volume').value = String(Math.round(volume * 100));
    setText('fs-volume-value', `${Math.round(volume * 100)}%`);
    if (byId('fs-youtube-url')) byId('fs-youtube-url').value = youtubeUrl;
    renderTimer(); showView(view, false);
    const statusRevision = agendaRevision;
    void request('status').then(data => { setText('fs-youtube-configure', plain(data).youtubeConfigured ? 'Change search connection' : 'Configure search'); if (statusRevision === agendaRevision) { calendarConfigured = plain(data).calendarConfigured === true; if (calendarConfigured && view === 'focus') refreshAgenda(); } }, () => {});
    return { open: () => showView('focus'), back: () => showView('universe'), getState: () => ({ view, timer: { ...timer }, playlist, volume, youtubeUrl, pending: pending.size }),
      destroy() { if (!alive) return; timer = updateTimer(timer, 'tick'); persist(); haltMedia(); alive = false; window.clearInterval(pulse); clearTransition(); cancelRequests(); for (const dispose of disposers) dispose(); } };
  }
  return { createTimer, restoreTimer, updateTimer, parseYouTubeUrl, create };
});
