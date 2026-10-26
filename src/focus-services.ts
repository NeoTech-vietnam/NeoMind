import { parseCalendarIcs, findFocusSlots } from './focus-calendar.js';

interface RequestOptions { signal?: AbortSignal; fetcher?: typeof fetch }
const limit = 2 * 1024 * 1024;
function boundedText(value: unknown, name: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${name} must be bounded nonempty text.`);
  return value.trim();
}
async function request(url: URL, options: RequestOptions, maximum = limit): Promise<string> {
  const signal = AbortSignal.any([AbortSignal.timeout(12_000), ...(options.signal ? [options.signal] : [])]);
  const response = await (options.fetcher ?? fetch)(url, { signal, redirect: 'error', headers: { Accept: 'application/json, text/calendar;q=0.9' } });
  if (!response.ok || !response.body) throw new Error('Provider request was unsuccessful.');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) throw new Error('Provider response exceeds the supported size.');
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
function number(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }

export async function focusWeather(latitude: number, longitude: number, options: RequestOptions = {}) {
  if (number(latitude) === null || number(longitude) === null || Math.abs(latitude) > 90 || Math.abs(longitude) > 180)
    throw new Error('Weather requires valid latitude and longitude.');
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.search = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), timezone: 'auto', forecast_days: '7',
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' }).toString();
  try {
    const data = JSON.parse(await request(url, options));
    if (!data.current || !Array.isArray(data.daily?.time)) throw new Error('Invalid weather response.');
    return { location: { latitude, longitude, timezone: typeof data.timezone === 'string' ? data.timezone : 'UTC' },
      current: { temperature: number(data.current.temperature_2m), apparent: number(data.current.apparent_temperature),
        weatherCode: number(data.current.weather_code), windSpeed: number(data.current.wind_speed_10m) },
      daily: data.daily.time.slice(0, 7).map((date: string, index: number) => ({ date,
        minimum: number(data.daily.temperature_2m_min?.[index]), maximum: number(data.daily.temperature_2m_max?.[index]),
        rainProbability: number(data.daily.precipitation_probability_max?.[index]), weatherCode: number(data.daily.weather_code?.[index]) })),
      attribution: 'Weather data by Open-Meteo · CC BY 4.0' };
  } catch { throw new Error('Weather is unavailable. Retry or choose a city; no default location was assumed.'); }
}
export async function focusPlaceSearch(query: string, options: RequestOptions = {}) {
  const name = boundedText(query, 'City search', 100);
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  url.search = new URLSearchParams({ name, count: '5', language: 'en', format: 'json' }).toString();
  try {
    const data = JSON.parse(await request(url, options));
    return (Array.isArray(data.results) ? data.results : []).filter((place: any) => number(place.latitude) !== null && number(place.longitude) !== null)
      .slice(0, 5).map((place: any) => ({ name: String(place.name ?? '').slice(0, 100), country: String(place.country ?? '').slice(0, 100),
        latitude: place.latitude, longitude: place.longitude }));
  } catch { throw new Error('City search is unavailable. Retry later or use current location.'); }
}
export interface FocusCalendarWindow { from?: string; to?: string; durationMinutes?: number; timeZone?: string }
export function focusCalendar(ics: string, window: FocusCalendarWindow = {}) {
  const from = window.from ?? new Date().toISOString(), to = window.to ?? new Date(Date.parse(from) + 7 * 86_400_000).toISOString();
  const parsed = parseCalendarIcs(ics, { from, to, maxEvents: 500 });
  return { ...parsed, slots: parsed.incomplete ? [] : findFocusSlots(parsed.events, { from, to, durationMinutes: window.durationMinutes ?? 25,
    timeZone: window.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone, limit: 8 }) };
}
export function validateCalendarFeed(raw: string): URL {
  let url: URL;
  try { url = new URL(boundedText(raw, 'Calendar feed', 4096)); } catch { throw new Error('Use a supported HTTPS Google or Outlook ICS feed.'); }
  const hosts = new Set(['calendar.google.com', 'outlook.office365.com', 'outlook.office.com', 'outlook.live.com']);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname) || url.username || url.password || (url.port && url.port !== '443') || url.hash ||
      !url.pathname.toLowerCase().endsWith('.ics') || !(url.hostname === 'calendar.google.com' ? url.pathname.startsWith('/calendar/ical/') : url.pathname.startsWith('/owa/calendar/')))
    throw new Error('Use a supported HTTPS Google or Outlook ICS feed. Other calendars can be imported from an ICS file.');
  return url;
}
export async function focusCalendarFeed(raw: string, window: FocusCalendarWindow = {}, options: RequestOptions = {}) {
  const url = validateCalendarFeed(raw);
  try { return focusCalendar(await request(url, options, 1024 * 1024), window); }
  catch { throw new Error('Calendar could not be refreshed. Check the private ICS link or import an ICS file.'); }
}
export async function focusYouTubeSearch(query: string, apiKey: string, options: RequestOptions = {}) {
  const q = boundedText(query, 'YouTube search', 150), key = boundedText(apiKey, 'YouTube API key', 256);
  const url = new URL('https://www.googleapis.com/youtube/v3/search');
  url.search = new URLSearchParams({ part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: '6', q, key }).toString();
  try {
    const data = JSON.parse(await request(url, options));
    return (Array.isArray(data.items) ? data.items : []).filter((item: any) => /^[a-zA-Z0-9_-]{11}$/.test(item.id?.videoId ?? ''))
      .slice(0, 6).map((item: any) => ({ id: item.id.videoId, title: String(item.snippet?.title ?? 'YouTube video').slice(0, 200),
        thumbnail: `https://i.ytimg.com/vi/${item.id.videoId}/mqdefault.jpg` }));
  } catch { throw new Error('YouTube search is unavailable. Check the API key restrictions/quota, or paste a video or playlist link.'); }
}
