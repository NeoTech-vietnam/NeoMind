import { createHash } from 'node:crypto';
import ICAL from 'ical.js';

export const focusCalendarLimits = Object.freeze({ maxSourceBytes: 1_048_576, maxHorizonDays: 31,
  maxEvents: 500, maxIterations: 10_000, maxComponents: 2_000 });

export interface FocusCalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  /** All-day ISO midnights encode calendar dates; display them without a local timezone shift. */
  allDay: boolean;
  busy: boolean;
  calendarSource?: string;
}
export interface CalendarWindow { from: string; to: string }
export interface CalendarParseOptions extends CalendarWindow { maxEvents?: number }
export interface CalendarParseResult { events: FocusCalendarEvent[]; warnings: string[]; incomplete: boolean }
export interface FocusSlot { start: string; end: string; durationMinutes: number }
export interface FocusSlotOptions extends CalendarWindow {
  durationMinutes: number;
  limit?: number;
  /** IANA timezone used to interpret all-day calendar dates. Defaults to UTC. */
  timeZone?: string;
}

const dayMs = 86_400_000;
type CalendarComponent = InstanceType<typeof ICAL.Component>;
type CalendarEvent = InstanceType<typeof ICAL.Event>;
type CalendarTime = InstanceType<typeof ICAL.Time>;
type Recurrence = InstanceType<typeof ICAL.Recur>;

function instant(value: string, label: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value))
    throw new Error(`${label} must be an ISO date-time with an explicit timezone.`);
  const result = Date.parse(value);
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const check = new Date(Date.UTC(year!, month! - 1, day!));
  if (!Number.isFinite(result) || check.getUTCFullYear() !== year || check.getUTCMonth() + 1 !== month || check.getUTCDate() !== day)
    throw new Error(`${label} must be a valid ISO date-time with an explicit timezone.`);
  return result;
}

function queryWindow(options: CalendarWindow): { from: number; to: number } {
  const from = instant(options.from, 'from'), to = instant(options.to, 'to');
  if (to <= from || to - from > focusCalendarLimits.maxHorizonDays * dayMs)
    throw new Error('Calendar window must be positive and at most 31 days.');
  return { from, to };
}

function allDayBoundaries(timeZone: string): (value: string) => number {
  let formatter: Intl.DateTimeFormat;
  try {
    if (typeof timeZone !== 'string' || timeZone.length > 100 || !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(timeZone)) throw new Error();
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, calendar: 'iso8601', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch { throw new Error('timeZone must be a valid IANA timezone ID.'); }
  const cache = new Map<string, number>();
  const dateAt = (at: number): number => {
    const parts = formatter.formatToParts(at);
    return Number(parts.find(part => part.type === 'year')!.value) * 10_000 +
      Number(parts.find(part => part.type === 'month')!.value) * 100 + Number(parts.find(part => part.type === 'day')!.value);
  };
  return value => {
    const marker = instant(value, 'all-day event boundary');
    if (new Date(marker).toISOString().slice(10) !== 'T00:00:00.000Z') throw new Error('All-day event boundaries must encode UTC midnight calendar dates.');
    const date = new Date(marker).toISOString().slice(0, 10);
    const cached = cache.get(date);
    if (cached !== undefined) return cached;
    const target = Number(date.replaceAll('-', ''));
    // Search the first valid instant of this date rather than assuming a 24h
    // day or a valid midnight. This handles DST gaps/repeats at midnight too.
    let low = marker - 2 * dayMs, high = marker + 2 * dayMs;
    if (dateAt(low) >= target || dateAt(high) < target) throw new Error('Cannot resolve all-day event date in the selected timeZone.');
    while (high - low > 1) {
      const middle = low + Math.floor((high - low) / 2);
      if (dateAt(middle) >= target) high = middle;
      else low = middle;
    }
    cache.set(date, high);
    return high;
  };
}

function boundedInteger(value: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < 1 || value > maximum)
    throw new Error(`${label} must be an integer from 1 to ${maximum}.`);
  return value;
}

function text(value: unknown, maximum = 240): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum) : '';
}

function cancelled(component: CalendarComponent): boolean {
  return String(component.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

function timeMs(time: CalendarTime): number {
  if (!(time instanceof ICAL.Time)) throw new Error('Invalid calendar time.');
  if (!time.isDate && time.zone === ICAL.Timezone.localTimezone) throw new Error('Unresolved calendar timezone.');
  const result = time.isDate ? Date.UTC(time.year, time.month - 1, time.day) : time.toUnixTime() * 1_000;
  if (!Number.isFinite(result)) throw new Error('Invalid calendar time.');
  return result;
}

function occurrenceIdentity(time: CalendarTime): string {
  return time.isDate ? `date:${time.toString()}` : `instant:${timeMs(time)}`;
}

function validateTimes(component: CalendarComponent): void {
  for (const property of component.getAllProperties()) {
    if (!['dtstart', 'dtend', 'recurrence-id', 'rdate', 'exdate'].includes(property.name)) continue;
    // Time normalizes impossible dates; reject them before the library hydrates values.
    for (const raw of property.toJSON().slice(3)) {
      if (typeof raw !== 'string') throw new Error('Unsupported calendar time value.');
      const match = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d):(\d\d)Z?)?$/.exec(raw);
      if (!match) throw new Error('Invalid calendar time.');
      const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day ||
        Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59 || Number(match[6] ?? 0) > 59)
        throw new Error('Invalid calendar time.');
    }
    for (const value of property.getValues()) {
      // RDATE periods have their own duration semantics, not yet exposed by this adapter.
      if (!(value instanceof ICAL.Time)) throw new Error('Unsupported calendar time value.');
      const tzid = property.getParameter('tzid');
      if (!value.isDate && tzid && value.zone.tzid !== tzid) throw new Error('Unresolved calendar timezone.');
      timeMs(value);
    }
  }
}

/**
 * Constrain the library's inner searches as well as our outer iterator. These
 * safe public-API combinations cover common appointments; unsupported filters
 * are reported as incomplete instead of risking an unbounded impossible rule.
 */
function boundRules(component: CalendarComponent, upper: number, timezoneRule = false): void {
  if (component.hasProperty('exrule')) throw new Error('Unsupported exclusion rule.');
  const properties = component.getAllProperties('rrule');
  if (properties.length > 1) throw new Error('Multiple recurrence rules are unsupported.');
  for (const property of properties) {
    const rule = property.getFirstValue();
    if (!(rule instanceof ICAL.Recur)) throw new Error('Invalid recurrence rule.');
    if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 10_000)
      throw new Error('Invalid recurrence interval.');
    const parts = Object.keys(rule.parts) as (keyof Recurrence['parts'])[];
    const allowed: Record<string, string[]> = {
      SECONDLY: [], MINUTELY: [], HOURLY: [], DAILY: ['BYDAY', 'BYMONTH', 'BYMONTHDAY'],
      WEEKLY: ['BYDAY'], MONTHLY: ['BYDAY', 'BYMONTHDAY', 'BYSETPOS'],
      YEARLY: ['BYMONTH', 'BYDAY', 'BYMONTHDAY', 'BYSETPOS'],
    };
    if (!allowed[rule.freq] || parts.some(part => !allowed[rule.freq]!.includes(part)) ||
      (rule.freq === 'DAILY' && (parts.length > 1 || (parts.length > 0 && rule.interval !== 1))) ||
      (timezoneRule && (rule.freq !== 'YEARLY' || rule.interval !== 1)))
      throw new Error('Unsupported recurrence filter combination.');
    if (rule.count !== null && rule.count !== undefined && (!Number.isInteger(rule.count) || rule.count < 1))
      throw new Error('Invalid recurrence count.');
    for (const part of parts) {
      const values = rule.parts[part];
      if (!Array.isArray(values) || values.length < 1 || values.length > 366) throw new Error('Invalid recurrence parts.');
      for (const value of values) {
        if (part === 'BYDAY') {
          const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(String(value));
          if (!match || (match[1] && (!['MONTHLY', 'YEARLY'].includes(rule.freq) || Number(match[1]) === 0 || Math.abs(Number(match[1])) > (rule.freq === 'MONTHLY' ? 5 : 53))))
            throw new Error('Invalid recurrence weekday.');
        } else {
          const maximum = part === 'BYMONTH' ? 12 : part === 'BYMONTHDAY' ? 31 : 366;
          if (!Number.isInteger(value) || Number(value) === 0 || Math.abs(Number(value)) > maximum || (part === 'BYMONTH' && Number(value) < 0))
            throw new Error('Invalid recurrence value.');
        }
      }
    }
    // Mutates only this freshly parsed component; no global timezone registry.
    const cutoff = ICAL.Time.fromJSDate(new Date(upper + dayMs), true);
    if (!rule.until || rule.until.toUnixTime() > cutoff.toUnixTime()) rule.until = cutoff;
  }
}

/** Parse untrusted ICS data without network access, alarms, attachments or persistent writes. */
export function parseCalendarIcs(source: string, options: CalendarParseOptions): CalendarParseResult {
  const range = queryWindow(options);
  const maximum = boundedInteger(options.maxEvents ?? focusCalendarLimits.maxEvents, focusCalendarLimits.maxEvents, 'maxEvents');
  if (typeof source !== 'string' || Buffer.byteLength(source, 'utf8') > focusCalendarLimits.maxSourceBytes)
    throw new Error('Calendar source must be text no larger than 1 MiB.');
  const warnings = new Set<string>(), events = new Map<string, FocusCalendarEvent>();
  const warn = (value: string) => warnings.add(value);
  const result = (): CalendarParseResult => ({ events: [...events.values()].sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)).slice(0, maximum), warnings: [...warnings], incomplete: warnings.size > 0 });
  let calendar: CalendarComponent;
  try {
    let depth = 0, components = 0;
    for (const line of source.split(/\r?\n/)) {
      if (/^BEGIN:/i.test(line) && (++depth > 8 || ++components > focusCalendarLimits.maxComponents)) throw new Error('Component limit.');
      if (/^END:/i.test(line)) depth--;
    }
    calendar = new ICAL.Component(ICAL.parse(source.replace(/^\uFEFF/, '')));
    if (calendar.name !== 'vcalendar') throw new Error('Expected VCALENDAR.');
  } catch {
    warn('Calendar data is invalid or exceeds the component limit. No complete agenda is available.');
    return result();
  }

  const calendarSource = text(calendar.getFirstPropertyValue('x-wr-calname'), 80) || undefined;
  const zones = calendar.getAllSubcomponents('vtimezone');
  // Zone expansion is also untrusted recurrence work. Stock ICAL has no implicit IANA database.
  const invalidZones = new Set<string>();
  for (const zone of zones) {
    const tzid = String(zone.getFirstPropertyValue('tzid') ?? '');
    try {
      if (!tzid || zones.length > 32 || zone.getAllSubcomponents().length > 8) throw new Error('Timezone limit.');
      for (const observance of zone.getAllSubcomponents()) {
        const start = observance.getFirstPropertyValue('dtstart');
        if (!(start instanceof ICAL.Time) || start.year < 1800 || start.year > 2200 || !['standard', 'daylight'].includes(observance.name)) throw new Error('Invalid timezone.');
        boundRules(observance, range.to, true);
      }
    } catch { invalidZones.add(tzid); }
  }

  const components = calendar.getAllSubcomponents('vevent');
  const groups = new Map<string, CalendarComponent[]>();
  for (const component of components) {
    const uid = component.getFirstPropertyValue('uid');
    if (typeof uid !== 'string' || uid.length < 1 || uid.length > 1_024) { warn('An event without a valid bounded UID was omitted.'); continue; }
    const group = groups.get(uid) ?? []; group.push(component); groups.set(uid, group);
  }
  let iterations = 0, exhausted = false;
  function project(item: CalendarEvent, start: CalendarTime, end: CalendarTime, uid: string, identity: string): void {
    if (cancelled(item.component)) return;
    const from = timeMs(start), to = timeMs(end);
    if (to < from || start.isDate !== end.isDate) throw new Error('Invalid event duration.');
    // DATE values are labels, not UTC instants. Keep adjacent dates until the
    // planner can apply its actual timezone, including partial-day queries.
    const padding = start.isDate ? dayMs : 0;
    if (from >= range.to + padding || (to <= range.from - padding && !(from === to && from >= range.from - padding))) return;
    const id = `ics:${createHash('sha256').update(`${uid}\0${identity}`).digest('hex').slice(0, 32)}`;
    if (!events.has(id) && events.size >= maximum) {
      warn('Calendar event limit reached; this agenda is incomplete.'); exhausted = true; return;
    }
    events.set(id, { id, title: text(item.summary) || '(Untitled event)', start: new Date(from).toISOString(), end: new Date(to).toISOString(),
      allDay: start.isDate, busy: String(item.component.getFirstPropertyValue('transp') ?? '').toUpperCase() !== 'TRANSPARENT',
      ...(calendarSource ? { calendarSource } : {}) });
  }
  for (const [uid, group] of groups) {
    if (exhausted) break;
    try {
      const masters = group.filter(component => !component.hasProperty('recurrence-id'));
      if (masters.length > 1) throw new Error('Duplicate series identity.');
      if (masters[0] && cancelled(masters[0])) continue;
      const overrides = new Map<string, CalendarEvent>(), cancellations = new Set<string>();
      for (const component of group) {
        for (const property of component.getAllProperties()) {
          if (invalidZones.has(String(property.getParameter('tzid') ?? ''))) throw new Error('Unsupported timezone definition.');
        }
        if (cancelled(component) && !component.hasProperty('recurrence-id')) continue;
        validateTimes(component);
        boundRules(component, range.to);
        if (!component.hasProperty('recurrence-id')) continue;
        if (component.getFirstProperty('recurrence-id')?.getParameter('range')) throw new Error('Range overrides are unsupported.');
        const recurrenceId = component.getFirstPropertyValue('recurrence-id');
        if (!(recurrenceId instanceof ICAL.Time)) throw new Error('Invalid exception time.');
        const identity = occurrenceIdentity(recurrenceId);
        if (overrides.has(identity) || cancellations.has(identity)) throw new Error('Duplicate exception identity.');
        if (cancelled(component)) { cancellations.add(identity); continue; }
        if (!component.hasProperty('dtstart')) throw new Error('Override has no start.');
        overrides.set(identity, new ICAL.Event(component, { exceptions: [], strictExceptions: true }));
      }
      const masterComponent = masters[0];
      if (masterComponent && !cancelled(masterComponent)) {
        if (!masterComponent.hasProperty('dtstart')) throw new Error('Event has no start.');
        const master = new ICAL.Event(masterComponent, { exceptions: [], strictExceptions: true });
        for (const override of overrides.values()) master.relateException(override);
        const isExcluded = (time: CalendarTime) => masterComponent.getAllProperties('exdate').some(property => property.getValues().some((value: CalendarTime) =>
          value.isDate ? value.year === time.year && value.month === time.month && value.day === time.day : timeMs(value) === timeMs(time)));
        const projectOccurrence = (occurrence: CalendarTime) => {
          const identity = occurrenceIdentity(occurrence);
          if (cancellations.has(identity) || isExcluded(occurrence)) return;
          // UTC and local-zone RECURRENCE-ID values denote the same identity.
          const override = overrides.get(identity);
          const detail = override ? { item: override, startDate: override.startDate, endDate: override.endDate } : master.getOccurrenceDetails(occurrence);
          project(detail.item, detail.startDate, detail.endDate, uid, identity);
        };
        // DTSTART belongs to the recurrence set even for an RDATE-only event.
        projectOccurrence(master.startDate);
        if (master.isRecurring()) {
          const iterator = master.iterator();
          let occurrence: CalendarTime | null;
          while (true) {
            if (++iterations > focusCalendarLimits.maxIterations) {
              warn('Calendar recurrence iteration work limit reached; this agenda is incomplete.'); exhausted = true; break;
            }
            occurrence = iterator.next();
            if (!occurrence || timeMs(occurrence) >= range.to + (occurrence.isDate ? dayMs : 0)) break;
            projectOccurrence(occurrence);
            if (exhausted) break;
          }
        }
      }
      // Moved instances can enter the window from an original date outside it.
      for (const [identity, override] of overrides) {
        if (exhausted) break;
        project(override, override.startDate, override.endDate, uid, identity);
      }
    } catch {
      warn('An event or recurrence has invalid dates, an unresolved timezone, or unsupported rules; this agenda is incomplete.');
    }
  }
  return result();
}

/** Find local proposals only. Callers must not claim free time from an incomplete calendar result. */
export function findFocusSlots(events: readonly FocusCalendarEvent[], options: FocusSlotOptions): FocusSlot[] {
  const range = queryWindow(options);
  const dateBoundary = allDayBoundaries(options.timeZone === undefined ? 'UTC' : options.timeZone);
  const durationMinutes = boundedInteger(options.durationMinutes, focusCalendarLimits.maxHorizonDays * 1_440, 'durationMinutes');
  const limit = boundedInteger(options.limit ?? 8, focusCalendarLimits.maxEvents, 'limit');
  if (!Array.isArray(events) || events.length > focusCalendarLimits.maxEvents) throw new Error('Calendar events must be an array of at most 500 events.');
  const duration = durationMinutes * 60_000;
  const busy: [number, number][] = [];
  for (const event of events) {
    if (!event || typeof event.busy !== 'boolean') throw new Error('Invalid calendar event busy state.');
    const start = event.allDay ? dateBoundary(event.start) : instant(event.start, 'event start');
    const end = event.allDay ? dateBoundary(event.end) : instant(event.end, 'event end');
    if (end < start) throw new Error('Invalid calendar event duration.');
    if (event.busy && end > range.from && start < range.to && end > start)
      busy.push([Math.max(start, range.from), Math.min(end, range.to)]);
  }
  busy.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of busy) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  const slots: FocusSlot[] = [];
  let cursor = range.from;
  function fill(end: number): void {
    while (cursor + duration <= end && slots.length < limit) {
      slots.push({ start: new Date(cursor).toISOString(), end: new Date(cursor + duration).toISOString(), durationMinutes });
      cursor += duration;
    }
  }
  for (const [start, end] of merged) {
    fill(start); cursor = Math.max(cursor, end);
    if (slots.length >= limit) break;
  }
  fill(range.to);
  return slots;
}
