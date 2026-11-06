// When an automation runs next (7 Nov, Masih: "we need a schedule tab in Elpis ... you can mimic deepseek's"). Rules are
// in this computer's local time, as he sets them in the calendar: a local clock time stays put across daylight saving
// (a time that does not exist that night moves forward, as Date does). Pure; bridge/schedule.mjs runs them.
import { BridgeError } from './validate.mjs';

/** @typedef {{ kind: 'once', at: string } | { kind: 'daily' | 'weekdays', time: string } | { kind: 'weekly', days: number[], time: string }
 *  | { kind: 'monthly', day: number, time: string } | { kind: 'every', minutes: number }} Rule */

export const RULE_KINDS = ['once', 'daily', 'weekdays', 'weekly', 'monthly', 'every'];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/, MOMENT = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;

/** A rule as sent by the page or an agent, checked; throws a BridgeError saying what is wrong. */
export function parseRule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BridgeError('Choose when the automation runs');
  const kind = value.kind;
  if (!RULE_KINDS.includes(kind)) throw new BridgeError(`Repeat must be one of: ${RULE_KINDS.join(', ')}`);
  const time = () => { if (typeof value.time !== 'string' || !TIME.test(value.time)) throw new BridgeError('Time must be HH:MM, 24-hour'); return value.time; };
  if (kind === 'once') {
    const match = typeof value.at === 'string' && MOMENT.exec(value.at);
    // A real calendar date: Date rolls 2026-13-01 over into January instead of refusing it.
    const date = match && new Date(local(value.at)), [, y, mo, d] = match ? match.map(Number) : [];
    if (!date || date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) throw new BridgeError('Date and time must be YYYY-MM-DDTHH:MM');
    return { kind, at: value.at };
  }
  if (kind === 'daily' || kind === 'weekdays') return { kind, time: time() };
  if (kind === 'weekly') {
    const days = Array.isArray(value.days) ? [...new Set(value.days)].sort((a, b) => a - b) : [];
    if (!days.length || days.some(day => !Number.isInteger(day) || day < 1 || day > 7)) throw new BridgeError('Choose at least one weekday (1 is Monday, 7 is Sunday)');
    return { kind, days, time: time() };
  }
  if (kind === 'monthly') {
    if (!Number.isInteger(value.day) || value.day < 1 || value.day > 31) throw new BridgeError('Day of the month must be 1 to 31');
    return { kind, day: value.day, time: time() };
  }
  if (!Number.isInteger(value.minutes) || value.minutes < 1 || value.minutes > 7 * 24 * 60) throw new BridgeError('The interval must be 1 minute to 7 days');
  return { kind, minutes: value.minutes };
}

/** "YYYY-MM-DDTHH:MM" in local time, as milliseconds. */
const local = moment => { const [, y, mo, d, h, mi] = MOMENT.exec(moment).map(Number); return new Date(y, mo - 1, d, h, mi).getTime(); };
const at = (day, time) => { const [h, m] = time.split(':').map(Number); return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime(); };
const isoWeekday = date => date.getDay() || 7;

/** The first run strictly after `after` (ms), or null when the rule has no more. `anchor` (ms) is when an `every` rule
 * started counting: its runs are anchor + k × interval. */
export function nextRun(rule, after, anchor = after) {
  if (rule.kind === 'once') { const time = local(rule.at); return time > after ? time : null; }
  if (rule.kind === 'every') {
    const step = rule.minutes * 60_000;
    return after < anchor ? anchor : anchor + (Math.floor((after - anchor) / step) + 1) * step;
  }
  // Day rules: try each calendar day from the day of `after`; a year covers every monthly day.
  const start = new Date(after);
  for (let offset = 0; offset <= 366; offset++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
    if (rule.kind === 'weekdays' && isoWeekday(day) > 5) continue;
    if (rule.kind === 'weekly' && !rule.days.includes(isoWeekday(day))) continue;
    if (rule.kind === 'monthly') {
      // A month without that day runs on its last day (the 31st in February is the 28th or 29th).
      const last = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
      if (day.getDate() !== Math.min(rule.day, last)) continue;
    }
    const time = at(day, rule.time);
    if (time > after) return time;
  }
  return null;
}

const pad = number => String(number).padStart(2, '0');
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
/** The rule in words, for the list and for agents. */
export function describeRule(rule) {
  if (rule.kind === 'once') { const date = new Date(local(rule.at)); return `Once, ${date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} at ${pad(date.getHours())}:${pad(date.getMinutes())}`; }
  if (rule.kind === 'daily') return `Every day at ${rule.time}`;
  if (rule.kind === 'weekdays') return `Monday to Friday at ${rule.time}`;
  if (rule.kind === 'weekly') return `Every ${rule.days.map(day => WEEKDAYS[day - 1]).join(', ')} at ${rule.time}`;
  if (rule.kind === 'monthly') return `Every month on day ${rule.day} at ${rule.time}`;
  return rule.minutes % 60 === 0 ? `Every ${rule.minutes / 60 === 1 ? 'hour' : `${rule.minutes / 60} hours`}` : `Every ${rule.minutes === 1 ? 'minute' : `${rule.minutes} minutes`}`;
}
