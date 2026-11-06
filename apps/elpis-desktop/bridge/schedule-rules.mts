// When an automation runs next. A rule is RFC 5545 text, one DTSTART and one RRULE, as DeepSeek Harness stores it
// (packages/client/ui-schedule/src/client/editor-timing.ts): "DTSTART;TZID=Asia/Tehran:20261106T090000\nRRULE:FREQ=DAILY".
// 6 Nov, Masih: "the timing is very un-standard and un-user-friendly. Use deepseek's own, if they don't have it, use a
// proper open source implementation." The recurrence comes from the rrule library, as in DeepSeek's
// packages/util/time/src/rrule.ts: rrule enumerates wall-clock times in the rule's zone, and each is resolved to its
// instant here. A local time a daylight-saving change skips is skipped; one it repeats runs once, at the earlier instant.
import rrulePackage from 'rrule';
import { BridgeError } from './validate.mts';

const { rrulestr } = rrulePackage;
const START = /^DTSTART(?:;TZID=([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)*|UTC))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/;
const FREQUENCIES = ['MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];
const DAY = 86_400_000, SCAN_LIMIT = 2000;

/** The offset of a zone at an instant, in milliseconds (local minus UTC). */
function offsetAt(epoch: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(epoch).map(part => [part.type, Number(part.value)]));
  return Date.UTC(parts.year!, parts.month! - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(epoch / 1000) * 1000;
}
/** An instant as UTC-shaped wall time in a zone. */
const wallOf = (epoch: number, timeZone: string) => epoch + offsetAt(epoch, timeZone);
/** UTC-shaped wall time to its earlier instant, or undefined when a forward change skips it. */
function instantOf(wall: number, timeZone: string) {
  const found = [offsetAt(wall - DAY, timeZone), offsetAt(wall + DAY, timeZone)].map(offset => wall - offset).filter(epoch => wallOf(epoch, timeZone) === wall);
  return found.length ? Math.min(...found) : undefined;
}

/** The rule's parts: its zone, its start as wall time, and its RRULE line. */
function parts(text: unknown) {
  const lines = String(text).trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const start = lines.length === 2 && START.exec(lines[0]!);
  if (!start || !lines[1]!.startsWith('RRULE:')) throw new BridgeError('A schedule is a DTSTART line and an RRULE line, e.g. "DTSTART;TZID=Europe/Berlin:20261106T090000\\nRRULE:FREQ=DAILY"');
  const [, timeZone = 'UTC', y, mo, d, h, mi, s] = start;
  try { new Intl.DateTimeFormat('en-US', { timeZone }); } catch { throw new BridgeError(`Unknown time zone: ${timeZone}`); }
  const fields = new Map(lines[1]!.slice(6).split(';').map(pair => pair.split('=') as [string, string]));
  if (!FREQUENCIES.includes(fields.get('FREQ') as string)) throw new BridgeError(`FREQ must be one of ${FREQUENCIES.join(', ')}`);
  if (fields.has('INTERVAL') && !/^[1-9]\d{0,4}$/.test(fields.get('INTERVAL') as string)) throw new BridgeError('INTERVAL must be a whole number from 1');
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return { timeZone, wall, rrule: lines[1]!, fields, line: `DTSTART;TZID=${timeZone}:${y}${mo}${d}T${h}${mi}${s}` };
}
const basic = (wall: number) => new Date(wall).toISOString().replace(/[-:]/g, '').slice(0, 15);
/** The rule over UTC-shaped wall times, which rrule enumerates without zone arithmetic. */
const floating = (rule: { wall: number; rrule: string }) => rrulestr(`DTSTART:${basic(rule.wall)}Z\n${rule.rrule}`);

/** The rule as sent by the page or an agent, checked and normalised; throws a BridgeError saying what is wrong. */
export function parseRule(value: unknown) {
  if (typeof value !== 'string' || value.length > 2000) throw new BridgeError('Choose when the automation runs');
  const rule = parts(value);
  try { floating(rule).after(new Date(rule.wall), true); } catch (error) { throw new BridgeError(`The repeat rule could not be read: ${(error as Error).message}`); }
  return `${rule.line}\n${rule.rrule}`;
}

/** The first run strictly after `after` (ms), or null when the rule has no more. */
export function nextRun(text: unknown, after: number) {
  const rule = parts(text), recurrence = floating(rule);
  // Wall times and instants differ by under a day; start a day early and resolve each wall time.
  let wall = Math.max(rule.wall - 1, wallOf(after, rule.timeZone) - DAY);
  for (let step = 0; step < SCAN_LIMIT; step++) {
    const date = recurrence.after(new Date(wall), false);
    if (!date) return null;
    wall = date.getTime();
    const instant = instantOf(wall, rule.timeZone);
    if (instant !== undefined && instant > after) return instant;
  }
  return null;
}

const WEEKDAYS = { MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday', SU: 'Sunday' };
const UNITS = { MINUTELY: 'minute', HOURLY: 'hour', DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' };
const two = (value: unknown) => String(value).padStart(2, '0');
/** The rule in words, for the list and for agents: "Every weekday at 09:00 (Asia/Tehran)". */
export function describeRule(text: unknown) {
  let rule; try { rule = parts(text); } catch { return 'An unreadable schedule'; }
  const f = rule.fields, interval = Number(f.get('INTERVAL') ?? 1), clock = new Date(rule.wall).toISOString().slice(11, 16);
  const time = `at ${f.has('BYHOUR') ? `${two(f.get('BYHOUR'))}:${two(f.get('BYMINUTE') ?? 0)}` : clock}`, zone = ` (${rule.timeZone})`;
  if (f.get('COUNT') === '1') return `Once, ${new Date(rule.wall).toISOString().slice(0, 10)} ${time}${zone}`;
  const every = (unit: string | undefined) => interval === 1 ? `Every ${unit}` : `Every ${interval} ${unit}s`;
  const freq = f.get('FREQ');
  if (freq === 'MINUTELY' || freq === 'HOURLY') return every((UNITS as Record<string, string>)[freq as string]);
  if (freq === 'WEEKLY' && f.has('BYDAY')) {
    const days = f.get('BYDAY')!.split(',');
    const named = days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every(day => days.includes(day)) ? 'weekday' : days.map(day => (WEEKDAYS as Record<string, string>)[day] ?? day).join(', ');
    return `${interval === 1 ? `Every ${named}` : `Every ${interval} weeks on ${named}`} ${time}${zone}`;
  }
  if (freq === 'MONTHLY' && f.has('BYMONTHDAY')) return `${every('month')} on day ${f.get('BYMONTHDAY')!.split(',')[0]} ${time}${zone}`;
  return `${every((UNITS as Record<string, string>)[freq as string])} ${time}${zone}`;
}

/** A rule saved before 6 Nov ({ kind: 'daily', time } and so on, in local time) as RFC 5545 text. */
export function legacyRule(rule: string | { kind: string; time?: string; at?: string; days?: number[]; day?: number; minutes?: number }, anchor: number, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (typeof rule === 'string') return rule;
  const local = new Date(anchor), date = `${local.getFullYear()}${two(local.getMonth() + 1)}${two(local.getDate())}`;
  const start = (time: string) => `DTSTART;TZID=${timeZone}:${date}T${time.replace(':', '')}00`;
  if (rule.kind === 'once') return `DTSTART;TZID=${timeZone}:${rule.at!.replace(/[-:]/g, '')}00\nRRULE:FREQ=DAILY;COUNT=1`;
  if (rule.kind === 'daily') return `${start(rule.time!)}\nRRULE:FREQ=DAILY`;
  if (rule.kind === 'weekdays') return `${start(rule.time!)}\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`;
  if (rule.kind === 'weekly') return `${start(rule.time!)}\nRRULE:FREQ=WEEKLY;BYDAY=${rule.days!.map((day: number) => ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'][day - 1]).join(',')}`;
  if (rule.kind === 'monthly') return `${start(rule.time!)}\nRRULE:FREQ=MONTHLY;BYMONTHDAY=${rule.day},-1;BYSETPOS=1`;
  const hours = rule.minutes! % 60 === 0;
  return `${start(`${two(local.getHours())}:${two(local.getMinutes())}`)}\nRRULE:FREQ=${hours ? 'HOURLY' : 'MINUTELY'};INTERVAL=${hours ? rule.minutes! / 60 : rule.minutes}`;
}
