import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendarIcs, findFocusSlots, focusCalendarLimits } from '../dist/focus-calendar.js';

const window = { from: '2026-10-23T00:00:00Z', to: '2026-10-26T00:00:00Z' };
const calendar = (...entries) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//NeoMind//Calendar test//EN', ...entries, 'END:VCALENDAR', ''].join('\r\n');
const event = (uid, ...properties) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTAMP:20261001T000000Z', ...properties, 'END:VEVENT'].join('\r\n');

test('imports bounded text-only events, duration, all-day dates and busy status without following calendar content', () => {
  const result = parseCalendarIcs(calendar('X-WR-CALNAME:Coursework',
    event('meeting@example.com', 'DTSTART:20261023T090000Z', 'DURATION:PT1H', 'SUMMARY:Review\\, plan\\nnext', 'ATTACH:https://private.invalid/secret', 'URL:https://private.invalid/token'),
    event('day', 'DTSTART;VALUE=DATE:20261024', 'SUMMARY:Deadline', 'TRANSP:TRANSPARENT'),
    event('cancel', 'DTSTART:20261023T120000Z', 'DTEND:20261023T130000Z', 'STATUS:CANCELLED'),
  ), window);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map(({ id, ...rest }) => rest), [
    { title: 'Review, plan next', start: '2026-10-23T09:00:00.000Z', end: '2026-10-23T10:00:00.000Z', allDay: false, busy: true, calendarSource: 'Coursework' },
    { title: 'Deadline', start: '2026-10-24T00:00:00.000Z', end: '2026-10-25T00:00:00.000Z', allDay: true, busy: false, calendarSource: 'Coursework' },
  ]);
  assert.ok(result.events.every(item => /^ics:[a-f0-9]{32}$/.test(item.id)));
  assert.doesNotMatch(JSON.stringify(result), /private\.invalid|meeting@example/);
  assert.deepEqual(parseCalendarIcs('\uFEFF' + calendar(event('bom', 'DTSTART:20261023T110000Z', 'DURATION:PT1H')), window).warnings, []);
});

test('expands RRULE, RDATE and EXDATE with moved and cancelled same-UID overrides and stable occurrence IDs', () => {
  const master = event('course', 'DTSTART:20261023T090000Z', 'DTEND:20261023T100000Z', 'SUMMARY:Course', 'RRULE:FREQ=DAILY;COUNT=3', 'RDATE:20261025T140000Z', 'EXDATE:20261024T090000Z');
  const moved = event('course', 'RECURRENCE-ID:20261025T090000Z', 'DTSTART:20261025T110000Z', 'DTEND:20261025T120000Z', 'SUMMARY:Moved course');
  const cancelled = event('course', 'RECURRENCE-ID:20261025T140000Z', 'STATUS:CANCELLED');
  const result = parseCalendarIcs(calendar(master, moved, cancelled), window);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.events.map(item => [item.title, item.start]), [
    ['Course', '2026-10-23T09:00:00.000Z'], ['Moved course', '2026-10-25T11:00:00.000Z'],
  ]);
  const original = parseCalendarIcs(calendar(master), window);
  assert.equal(result.events[1].id, original.events.find(item => item.start === '2026-10-25T09:00:00.000Z').id);
});

test('an override moved into the horizon is included even when its original recurrence lies outside it', () => {
  const result = parseCalendarIcs(calendar(
    event('moved', 'DTSTART:20261020T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=2', 'SUMMARY:Original'),
    event('moved', 'RECURRENCE-ID:20261021T090000Z', 'DTSTART:20261023T100000Z', 'DURATION:PT1H', 'SUMMARY:Now in window'),
  ), window);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.events.map(item => item.start), ['2026-10-23T10:00:00.000Z']);
});

test('one UID cannot steal another series override; detached overrides remain explicit events', () => {
  const result = parseCalendarIcs(calendar(
    event('a', 'DTSTART:20261023T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=2', 'SUMMARY:A'),
    event('b', 'RECURRENCE-ID:20261023T090000Z', 'DTSTART:20261023T120000Z', 'DURATION:PT1H', 'SUMMARY:B'),
  ), window);
  assert.deepEqual(result.events.map(item => item.title), ['A', 'B', 'A']);
});

test('RDATE-only sets retain DTSTART, EXDATE can remove it, and cancelled series do not resurrect overrides', () => {
  const result = parseCalendarIcs(calendar(
    event('rdate', 'DTSTART:20261023T090000Z', 'DURATION:PT1H', 'RDATE:20261024T090000Z', 'SUMMARY:Additional day'),
    event('excluded', 'DTSTART:20261023T120000Z', 'DURATION:PT1H', 'EXDATE:20261023T120000Z', 'SUMMARY:Excluded'),
    event('cancelled-series', 'DTSTART:20261023T150000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=2', 'STATUS:CANCELLED'),
    event('cancelled-series', 'RECURRENCE-ID:20261024T150000Z', 'DTSTART:20261024T160000Z', 'DURATION:PT1H', 'SUMMARY:Still cancelled'),
  ), window);
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.events.map(item => item.start), ['2026-10-23T09:00:00.000Z', '2026-10-24T09:00:00.000Z']);
});

test('honors embedded VTIMEZONE daylight transitions without changing global timezone registry', () => {
  const zone = ['BEGIN:VTIMEZONE', 'TZID:America/Test',
    'BEGIN:DAYLIGHT', 'DTSTART:20070311T020000', 'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0400', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'END:DAYLIGHT',
    'BEGIN:STANDARD', 'DTSTART:20071104T020000', 'TZOFFSETFROM:-0400', 'TZOFFSETTO:-0500', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
  const result = parseCalendarIcs(calendar(zone, event('dst', 'DTSTART;TZID=America/Test:20261031T090000', 'DTEND;TZID=America/Test:20261031T100000', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Daily study')), { from: '2026-10-31T00:00:00Z', to: '2026-11-03T00:00:00Z' });
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.events.map(item => item.start), ['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z', '2026-11-02T14:00:00.000Z']);
  const unresolved = parseCalendarIcs(calendar(event('zone-not-global', 'DTSTART;TZID=America/Test:20261023T090000', 'DURATION:PT1H')), window);
  assert.equal(unresolved.events.length, 0);
  assert.equal(unresolved.incomplete, true);
  const overrides = parseCalendarIcs(calendar(zone,
    event('dst', 'DTSTART;TZID=America/Test:20261031T090000', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:Daily study'),
    event('dst', 'RECURRENCE-ID:20261101T140000Z', 'DTSTART:20261101T160000Z', 'DURATION:PT1H', 'SUMMARY:Moved UTC override'),
    event('dst', 'RECURRENCE-ID:20261102T140000Z', 'STATUS:CANCELLED'),
  ), { from: '2026-10-31T00:00:00Z', to: '2026-11-03T00:00:00Z' });
  assert.equal(overrides.incomplete, false);
  assert.deepEqual(overrides.events.map(item => item.start), ['2026-10-31T13:00:00.000Z', '2026-11-01T16:00:00.000Z']);
  assert.equal(overrides.events[1].id, result.events[1].id);
});

test('monthly nth-weekday and yearly recurrence use library semantics', () => {
  const result = parseCalendarIcs(calendar(
    event('monthly', 'DTSTART:20260925T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3', 'SUMMARY:Monthly'),
    event('yearly', 'DTSTART:20241024T130000Z', 'DURATION:PT1H', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=24', 'SUMMARY:Yearly'),
  ), { from: '2026-10-23T00:00:00Z', to: '2026-10-31T00:00:00Z' });
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.events.map(item => [item.title, item.start]), [['Yearly', '2026-10-24T13:00:00.000Z'], ['Monthly', '2026-10-30T09:00:00.000Z']]);
});

test('floating/unresolved timezones, malformed events and unsupported recurrence never imply a complete free agenda', () => {
  for (const properties of [
    ['DTSTART:20261023T090000', 'DURATION:PT1H'],
    ['DTSTART;TZID=Missing/Zone:20261023T090000', 'DURATION:PT1H'],
    ['DTSTART:20261023T100000Z', 'DTEND:20261023T090000Z'],
    ['DTSTART:20260230T100000Z', 'DURATION:PT1H'],
    ['DTSTART:20261023T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=DAILY;INTERVAL=7;BYDAY=MO'],
    ['DTSTART:20261023T090000Z', 'DURATION:PT1H', 'RDATE;VALUE=PERIOD:20261024T090000Z/PT2H'],
  ]) {
    const result = parseCalendarIcs(calendar(event('unsupported', ...properties)), window);
    assert.equal(result.incomplete, true);
    assert.ok(result.warnings.length > 0);
  }
  const invalid = parseCalendarIcs('not an iCalendar', window);
  assert.deepEqual(invalid.events, []);
  assert.equal(invalid.incomplete, true);
});

test('enforces input, horizon, projected-event and recurrence-work bounds with explicit incomplete warnings', () => {
  assert.throws(() => parseCalendarIcs('x'.repeat(focusCalendarLimits.maxSourceBytes + 1), window), /1 MiB/);
  assert.throws(() => parseCalendarIcs(calendar(), { ...window, from: '2026-10-23' }), /timezone/);
  assert.throws(() => parseCalendarIcs(calendar(), { from: window.from, to: '2026-12-01T00:00:00Z' }), /31 days/);
  assert.throws(() => parseCalendarIcs(calendar(), { ...window, maxEvents: 501 }), /maxEvents/);
  const many = parseCalendarIcs(calendar(event('many', 'DTSTART:20261023T090000Z', 'DURATION:PT1M', 'RRULE:FREQ=MINUTELY;COUNT=100')), { ...window, maxEvents: 3 });
  assert.equal(many.events.length, 3);
  assert.equal(many.incomplete, true);
  const old = parseCalendarIcs(calendar(event('old', 'DTSTART:20000101T090000Z', 'DURATION:PT1H', 'RRULE:FREQ=HOURLY')), window);
  assert.equal(old.incomplete, true);
  assert.match(old.warnings.join(' '), /iteration|work limit/);
});

test('focus planning merges overlaps and back-to-back meetings, ignores transparent events, and clips boundaries', () => {
  const make = (start, end, busy = true) => ({ id: start, title: 'Event', start: `2026-10-23T${start}:00Z`, end: `2026-10-23T${end}:00Z`, busy, allDay: false });
  const events = [make('08:30', '09:30'), make('09:00', '10:00'), make('10:00', '10:30'), make('11:00', '12:00', false), make('12:00', '13:00'), make('16:30', '18:00')];
  const before = JSON.stringify(events);
  assert.deepEqual(findFocusSlots(events, { from: '2026-10-23T09:00:00Z', to: '2026-10-23T17:00:00Z', durationMinutes: 60, limit: 3 }), [
    { start: '2026-10-23T10:30:00.000Z', end: '2026-10-23T11:30:00.000Z', durationMinutes: 60 },
    { start: '2026-10-23T13:00:00.000Z', end: '2026-10-23T14:00:00.000Z', durationMinutes: 60 },
    { start: '2026-10-23T14:00:00.000Z', end: '2026-10-23T15:00:00.000Z', durationMinutes: 60 },
  ]);
  assert.equal(JSON.stringify(events), before);
});

test('focus planning has exact half-open boundaries and fails closed for invalid busy data or unsafe options', () => {
  const options = { from: '2026-10-23T09:00:00Z', to: '2026-10-23T10:00:00Z', durationMinutes: 60 };
  assert.equal(findFocusSlots([], options).length, 1);
  assert.equal(findFocusSlots([{ id: 'busy', title: '', start: options.from, end: options.to, busy: true, allDay: false }], options).length, 0);
  assert.throws(() => findFocusSlots([{ busy: true, start: 'invalid', end: options.to }], options), /event/);
  assert.throws(() => findFocusSlots([], { ...options, durationMinutes: 0 }), /durationMinutes/);
  assert.throws(() => findFocusSlots([], { ...options, limit: 501 }), /limit/);
  assert.throws(() => findFocusSlots(new Array(501).fill({}), options), /500/);
});

test('all-day dates block the whole Asia/Ho_Chi_Minh day, including early and late local hours', () => {
  const options = { from: '2026-10-22T17:00:00Z', to: '2026-10-23T17:00:00Z', durationMinutes: 60, timeZone: 'Asia/Ho_Chi_Minh' };
  const result = parseCalendarIcs(calendar(event('vn-day', 'DTSTART;VALUE=DATE:20261023', 'DTEND;VALUE=DATE:20261024', 'SUMMARY:Busy day')), options);
  assert.equal(result.incomplete, false);
  assert.deepEqual(findFocusSlots(result.events, options), []);
  const narrow = { ...options, from: '2026-10-23T18:00:00Z', to: '2026-10-23T20:00:00Z' };
  const nextDay = parseCalendarIcs(calendar(event('vn-next-day', 'DTSTART;VALUE=DATE:20261024', 'DTEND;VALUE=DATE:20261025')), narrow);
  assert.deepEqual(findFocusSlots(nextDay.events, narrow), [], 'A date marker beyond UTC query end still blocks the actual local early morning');
  assert.deepEqual(findFocusSlots(result.events, { ...options, timeZone: 'UTC', limit: 1 }), [
    { start: '2026-10-22T17:00:00.000Z', end: '2026-10-22T18:00:00.000Z', durationMinutes: 60 },
  ]);
});

test('all-day DST boundaries block both 23-hour and 25-hour days and preserve adjacent-day free slots', () => {
  for (const { date, end, from, to } of [
    { date: '20260308', end: '20260309', from: '2026-03-08T05:00:00Z', to: '2026-03-09T04:00:00Z' },
    { date: '20261101', end: '20261102', from: '2026-11-01T04:00:00Z', to: '2026-11-02T05:00:00Z' },
  ]) {
    const options = { from, to, durationMinutes: 30, timeZone: 'America/New_York' };
    const result = parseCalendarIcs(calendar(event('dst-all-day', `DTSTART;VALUE=DATE:${date}`, `DTEND;VALUE=DATE:${end}`)), options);
    assert.equal(result.incomplete, false);
    assert.deepEqual(findFocusSlots(result.events, options), []);
    if (date === '20261101') assert.deepEqual(findFocusSlots(result.events, { ...options, from: '2026-10-31T04:00:00Z', durationMinutes: 1_440 }), [
      { start: '2026-10-31T04:00:00.000Z', end: '2026-11-01T04:00:00.000Z', durationMinutes: 1_440 },
    ]);
  }
  const midnightGap = { from: '2018-11-04T03:00:00Z', to: '2018-11-05T02:00:00Z', durationMinutes: 30, timeZone: 'America/Sao_Paulo' };
  const result = parseCalendarIcs(calendar(event('midnight-gap', 'DTSTART;VALUE=DATE:20181104', 'DTEND;VALUE=DATE:20181105')), midnightGap);
  assert.deepEqual(findFocusSlots(result.events, midnightGap), [], 'A day whose midnight was skipped still begins at its first valid instant');
});

test('planner validates IANA timezone IDs even for an empty agenda and leaves actual timed instants unchanged', () => {
  const options = { from: '2026-10-23T09:00:00Z', to: '2026-10-23T10:00:00Z', durationMinutes: 60 };
  for (const timeZone of ['Missing/Zone', '+07:00', '', null, 7]) assert.throws(() => findFocusSlots([], { ...options, timeZone }), /timeZone/);
  assert.deepEqual(findFocusSlots([], options), findFocusSlots([], { ...options, timeZone: 'UTC' }));
  const timed = { id: 'timed', title: 'Meeting', start: options.from, end: options.to, busy: true, allDay: false };
  assert.deepEqual(findFocusSlots([timed], { ...options, timeZone: 'Asia/Ho_Chi_Minh' }), []);
});
