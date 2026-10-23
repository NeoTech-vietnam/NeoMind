import test from 'node:test';
import assert from 'node:assert/strict';
import { focusWeather, focusPlaceSearch, focusCalendar, focusCalendarFeed, validateCalendarFeed, focusYouTubeSearch } from '../dist/focus-services.js';

const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const calendar = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTART:20261023T030000Z\r\nDTEND:20261023T040000Z\r\nSUMMARY:Design\r\nEND:VEVENT\r\nEND:VCALENDAR`;
const window = { from: '2026-10-23T02:00:00Z', to: '2026-10-23T05:00:00Z', timeZone: 'Asia/Ho_Chi_Minh' };

test('weather and city lookup use fixed providers, bounded results and explicit coordinates', async () => {
  const seen = [];
  const fetcher = async (url, options) => {
    seen.push([url, options]);
    return url.hostname.startsWith('geocoding')
      ? json({ results: Array.from({length: 8}, () => ({name: 'Hanoi', country: 'Vietnam', latitude: 21.03, longitude: 105.85})) })
      : json({ timezone: 'Asia/Ho_Chi_Minh', current: {temperature_2m: 28, apparent_temperature: 31, weather_code: 1, wind_speed_10m: 8},
        daily: { time: ['2026-10-23'], temperature_2m_min: [24], temperature_2m_max: [30], precipitation_probability_max: [20], weather_code: [1] } });
  };
  const forecast = await focusWeather(21.03, 105.85, {fetcher});
  assert.equal(forecast.current.temperature, 28);
  assert.equal(forecast.daily[0].rainProbability, 20);
  assert.match(forecast.attribution, /Open-Meteo.*CC BY 4.0/);
  assert.equal((await focusPlaceSearch('Hanoi', {fetcher})).length, 5);
  assert.deepEqual(seen.map(([url]) => url.hostname), ['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
  assert.equal(seen[0][0].searchParams.get('latitude'), '21.03');
  assert.ok(seen.every(([,options]) => options.redirect === 'error' && options.signal instanceof AbortSignal));
  await assert.rejects(focusWeather(NaN, 0, {fetcher}), /valid latitude/);
  await assert.rejects(focusWeather(91, 0, {fetcher}), /valid latitude/);
  await assert.rejects(focusPlaceSearch('x'.repeat(101), {fetcher}), /bounded/);
});

test('private calendar URLs cannot redirect or reach arbitrary hosts and credentials stay outside results', async () => {
  for (const url of ['http://calendar.google.com/calendar/ical/a.ics', 'https://calendar.google.com.evil.test/calendar/ical/a.ics',
    'https://user:pass@calendar.google.com/calendar/ical/a.ics', 'https://127.0.0.1/private.ics',
    'https://outlook.live.com:8443/owa/calendar/a.ics', 'https://calendar.google.com/calendar/ical/a.ics#fragment']) {
    assert.throws(() => validateCalendarFeed(url), /supported HTTPS/);
  }
  const privateUrl = 'https://calendar.google.com/calendar/ical/private-secret/basic.ics';
  let calls = 0;
  const result = await focusCalendarFeed(privateUrl, window, {fetcher: async (url, options) => {
    calls++; assert.equal(url.href, privateUrl); assert.equal(options.redirect, 'error'); return new Response(calendar);
  }});
  assert.equal(calls, 1); assert.equal(result.events[0].title, 'Design');
  assert.ok(result.slots.length); assert.ok(!JSON.stringify(result).includes('private-secret'));
  await assert.rejects(focusCalendarFeed(privateUrl, window, {fetcher: async () => new Response('a'.repeat(1024 * 1024 + 1))}), /could not be refreshed/);
});

test('incomplete calendar data cannot generate confident free slots', () => {
  const unresolved = calendar.replace('DTSTART:20261023T030000Z', 'DTSTART;TZID=Unknown/Place:20261023T030000');
  const result = focusCalendar(unresolved, window);
  assert.equal(result.incomplete, true); assert.deepEqual(result.slots, []); assert.ok(result.warnings.length);
});

test('YouTube search uses the official API and returns safe IDs without API credentials', async () => {
  const key = 'private-api-key';
  const result = await focusYouTubeSearch('relaxing piano', key, {fetcher: async (url, options) => {
    assert.equal(url.origin, 'https://www.googleapis.com'); assert.equal(url.pathname, '/youtube/v3/search');
    assert.equal(url.searchParams.get('key'), key); assert.equal(url.searchParams.get('videoEmbeddable'), 'true');
    assert.equal(options.redirect, 'error');
    return json({items: [{id:{videoId:'abcdefghijk'},snippet:{title:'Piano',thumbnails:{default:{url:'https://evil.test'}}}},
      {id:{videoId:'<script>'},snippet:{title:'unsafe'}}]});
  }});
  assert.deepEqual(result, [{id:'abcdefghijk',title:'Piano',thumbnail:'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg'}]);
  assert.ok(!JSON.stringify(result).includes(key));
  await assert.rejects(focusYouTubeSearch('music', key, {fetcher: async () => {throw new Error(key);}}), error => !error.message.includes(key));
});

test('provider responses are bounded and cancellation propagates to the request', async () => {
  await assert.rejects(focusWeather(0,0,{fetcher:async()=>new Response('a'.repeat(2 * 1024 * 1024 + 1))}), /Weather is unavailable/);
  const controller = new AbortController();
  let observed;
  const pending = focusPlaceSearch('Paris', {signal:controller.signal, fetcher:async(_url,{signal})=>{
    observed=signal; return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  }});
  controller.abort(); await assert.rejects(pending, /City search is unavailable/); assert.equal(observed.aborted,true);
});
