"use client";
// The Run time form of an automation, ported from DeepSeek Harness's schedule editor (MIT; packages/client/ui-schedule:
// editor-timing.ts, TaskEditorFields.tsx, DatePicker.tsx, ClockPicker.tsx, TaskRuleControls.tsx, RuleSelectRow.tsx).
// 6 Nov, Masih: "the timing is very un-standard and un-user-friendly ... deepseek's UI can and should also be viewed as a
// source, it's very neat and UX too. So the time and date should be copied." Guided presets write one DTSTART and one
// RRULE (RFC 5545), which bridge/schedule-rules.mjs runs; Custom edits that text directly.
import "@/components/schedule-editor.css";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock } from "lucide-react";
import { Popover, PopoverContent } from "@/components/ui/popover";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { Choice } from "@/components/settings/rows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

// ---- Timing model (editor-timing.ts) ----

export type FrequencyPreset = "once" | "minutely" | "hourly" | "daily" | "weekly" | "monthly" | "advanced";
export type TimingDraft = {
  frequency: FrequencyPreset;
  interval: string;
  /** Local `YYYY-MM-DDTHH:MM:SS` in `timeZone`: the date of a one-time run, the anchor of an interval. */
  start: string;
  timeZone: string;
  rrule: string;
  weekdays: number[];
  monthDay: number;
  /** Daily `HH:MM` clock time. */
  dailyTime: string;
};
const WEEKDAY = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
const FREQUENCY = {
  minutely: "MINUTELY",
  hourly: "HOURLY",
  daily: "DAILY",
  weekly: "WEEKLY",
  monthly: "MONTHLY",
} as const;
const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The current minute in a zone, the anchor of a newly saved minute or hour interval. */
function startInZone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(Date.now());
  const field = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}T${field("hour")}:${field("minute")}:00`;
}

/** A new automation: once, an hour from now, in this computer's zone. */
export function defaultTiming(): TimingDraft {
  const date = new Date(Date.now() + 60 * 60_000),
    local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  const start = `${local.toISOString().slice(0, 16)}:00`;
  return {
    frequency: "once",
    interval: "1",
    start,
    timeZone: systemZone(),
    rrule: "",
    weekdays: [((local.getUTCDay() + 6) % 7) + 1],
    monthDay: Number(start.slice(8, 10)),
    dailyTime: start.slice(11, 16),
  };
}

/** One DTSTART and one RRULE for the form's choices. */
export function rruleFromDraft(draft: TimingDraft, intervalFromNow = false): string {
  if (draft.frequency === "advanced") return draft.rrule;
  const anchor =
    intervalFromNow && (draft.frequency === "minutely" || draft.frequency === "hourly")
      ? startInZone(draft.timeZone)
      : draft.start;
  const time = draft.frequency === "daily" ? `${draft.dailyTime}:00` : anchor.slice(11);
  const start = `${anchor.slice(0, 10)}T${time}`.replaceAll(/[-:]/g, "");
  const rule =
    draft.frequency === "once"
      ? "FREQ=DAILY;COUNT=1"
      : draft.frequency === "minutely" || draft.frequency === "hourly"
        ? `FREQ=${FREQUENCY[draft.frequency]};INTERVAL=${draft.interval}`
        : draft.frequency === "daily"
          ? `FREQ=DAILY;INTERVAL=${draft.interval};BYHOUR=${Number(draft.dailyTime.slice(0, 2))};BYMINUTE=${Number(draft.dailyTime.slice(3, 5))}`
          : draft.frequency === "weekly"
            ? `FREQ=WEEKLY;INTERVAL=${draft.interval};BYDAY=${draft.weekdays.map(day => WEEKDAY[day - 1]).join(",")}`
            : `FREQ=MONTHLY;INTERVAL=${draft.interval};BYMONTHDAY=${draft.monthDay},-1;BYSETPOS=1`;
  return `DTSTART;TZID=${draft.timeZone}:${start}\nRRULE:${rule}`;
}

/** A saved rule back into the form; one the presets cannot show opens in Custom, verbatim. */
export function timingFromRule(text: string): TimingDraft {
  const initial = defaultTiming();
  const startMatch = /^DTSTART(?:;TZID=([^:]+))?:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?/m.exec(text);
  const ruleLine = /^RRULE:(.*)$/m.exec(text)?.[1];
  if (!startMatch || ruleLine === undefined) return { ...initial, frequency: "advanced", rrule: text };
  const fields = new Map(ruleLine.split(";").map(pair => pair.split("=") as [string, string]));
  const start = `${startMatch[2]}-${startMatch[3]}-${startMatch[4]}T${startMatch[5]}:${startMatch[6]}:${startMatch[7]}`;
  const base = {
    ...initial,
    start,
    timeZone: startMatch[1] ?? "UTC",
    rrule: text,
    interval: fields.get("INTERVAL") ?? "1",
  };
  const known = new Set(["FREQ", "INTERVAL", "COUNT", "BYDAY", "BYHOUR", "BYMINUTE", "BYMONTHDAY", "BYSETPOS"]);
  if ([...fields.keys()].some(key => !known.has(key))) return { ...base, frequency: "advanced" };
  const freq = fields.get("FREQ");
  if (freq === "DAILY" && fields.get("COUNT") === "1") return { ...base, frequency: "once" };
  if (fields.has("COUNT")) return { ...base, frequency: "advanced" };
  if (freq === "MINUTELY" || freq === "HOURLY")
    return { ...base, frequency: freq === "MINUTELY" ? "minutely" : "hourly" };
  if (freq === "DAILY")
    return {
      ...base,
      frequency: "daily",
      dailyTime: `${(fields.get("BYHOUR") ?? start.slice(11, 13)).padStart(2, "0")}:${(fields.get("BYMINUTE") ?? start.slice(14, 16)).padStart(2, "0")}`,
    };
  if (freq === "WEEKLY" && fields.has("BYDAY"))
    return {
      ...base,
      frequency: "weekly",
      weekdays: fields
        .get("BYDAY")!
        .split(",")
        .map(day => WEEKDAY.indexOf(day as (typeof WEEKDAY)[number]) + 1),
    };
  if (freq === "MONTHLY" && fields.has("BYMONTHDAY"))
    return { ...base, frequency: "monthly", monthDay: Number.parseInt(fields.get("BYMONTHDAY")!, 10) };
  return { ...base, frequency: "advanced" };
}

/** Whether the guided choices can be saved as they stand. */
export function timingValid(draft: TimingDraft): boolean {
  return (
    (draft.frequency === "once" || draft.frequency === "advanced" || /^[1-9]\d*$/.test(draft.interval)) &&
    (draft.frequency !== "weekly" || draft.weekdays.length > 0) &&
    (draft.frequency !== "advanced" || draft.rrule.trim() !== "")
  );
}

// ---- Pickers (DatePicker.tsx, ClockPicker.tsx) ----

const pad = (value: number) => String(value).padStart(2, "0");
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** A month calendar for one date; arrows move the day, Enter picks it. */
function DatePicker({ value, onPick }: { value: string; onPick: (date: string) => void }) {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value),
    today = new Date();
  const [view, setView] = useState(() =>
    parsed?.[1] && parsed[2] && parsed[3]
      ? { year: +parsed[1], month: +parsed[2] - 1, day: +parsed[3] }
      : { year: today.getFullYear(), month: today.getMonth(), day: today.getDate() },
  );
  const cells = useRef(new Map<number, HTMLDivElement>());
  useEffect(() => {
    cells.current.get(view.day)?.focus();
  }, [view]);
  const iso = (day: number) => `${view.year}-${pad(view.month + 1)}-${pad(day)}`,
    todayIso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const shift = (step: number) =>
    setView(current => {
      const months = current.year * 12 + current.month + step,
        year = Math.floor(months / 12),
        month = months % 12;
      return { year, month, day: Math.min(current.day, daysIn(year, month)) };
    });
  const total = daysIn(view.year, view.month),
    offset = (new Date(Date.UTC(view.year, view.month, 1)).getUTCDay() + 6) % 7;
  const weeks = Math.ceil((offset + total) / 7);
  const title = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric", timeZone: "UTC" }).format(
    Date.UTC(view.year, view.month, 1),
  );
  const key = (event: KeyboardEvent, day: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onPick(iso(day));
      return;
    }
    const step = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
    if (!step) return;
    event.preventDefault();
    setView(current => ({ ...current, day: Math.min(Math.max(day + step, 1), total) }));
  };
  return (
    <div className="schedule-calendar">
      <div className="schedule-calendar-head">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="schedule-calendar-nav"
          aria-label="Previous month"
          onClick={() => shift(-1)}
        >
          <ChevronLeft size={14} />
        </Button>
        <span aria-live="polite">{title}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="schedule-calendar-nav"
          aria-label="Next month"
          onClick={() => shift(1)}
        >
          <ChevronRight size={14} />
        </Button>
      </div>
      <div role="grid" aria-label={title} className="schedule-calendar-grid">
        <div role="row" className="schedule-calendar-week">
          {WEEKDAY_NAMES.map(name => (
            <div key={name} role="columnheader" className="schedule-calendar-weekday">
              {name}
            </div>
          ))}
        </div>
        {Array.from({ length: weeks }, (_, week) => (
          <div key={week} role="row" className="schedule-calendar-week">
            {Array.from({ length: 7 }, (_, column) => week * 7 + column - offset + 1).map(day =>
              day < 1 || day > total ? (
                <div key={day} role="gridcell" aria-hidden="true" />
              ) : (
                <div
                  key={day}
                  ref={element => {
                    if (element) cells.current.set(day, element);
                    else cells.current.delete(day);
                  }}
                  role="gridcell"
                  tabIndex={day === view.day ? 0 : -1}
                  aria-selected={iso(day) === value}
                  aria-current={iso(day) === todayIso ? "date" : undefined}
                  className="schedule-calendar-day"
                  onClick={() => onPick(iso(day))}
                  onKeyDown={event => key(event, day)}
                >
                  {day}
                </div>
              ),
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, index) => pad(index)),
  MINUTES = Array.from({ length: 60 }, (_, index) => pad(index));
/** Scrolling hour and minute columns; a pick changes that part of the time at once. */
function ClockPicker({ value, onPick }: { value: string; onPick: (time: string) => void }) {
  const picked = [value.slice(0, 2), value.slice(3, 5)];
  const refs = useRef(new Map<string, HTMLDivElement>());
  useEffect(() => {
    for (const [column, option] of picked.entries())
      refs.current.get(`${column}:${option}`)?.scrollIntoView({ block: "center" });
    refs.current.get(`0:${picked[0]}`)?.focus();
  }, []);
  const pick = (column: number, option: string) => {
    const next = [...picked];
    next[column] = option;
    onPick(`${next[0]}:${next[1]}`);
  };
  return (
    <div className="schedule-clock">
      {[
        ["Hour", HOURS],
        ["Minute", MINUTES],
      ].map(([label, options], column) => (
        <div key={label as string} role="listbox" aria-label={label as string} className="schedule-clock-column">
          {(options as string[]).map((option, index, all) => (
            <div
              key={option}
              ref={element => {
                if (element) refs.current.set(`${column}:${option}`, element);
              }}
              role="option"
              aria-selected={option === picked[column]}
              tabIndex={option === picked[column] ? 0 : -1}
              className="schedule-clock-option"
              onClick={() => pick(column, option)}
              onKeyDown={event => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  pick(column, option);
                }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  refs.current
                    .get(
                      `${column}:${all[Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), all.length - 1)]}`,
                    )
                    ?.focus();
                }
                if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
                  event.preventDefault();
                  refs.current.get(`${column === 0 ? 1 : 0}:${picked[column === 0 ? 1 : 0]}`)?.focus();
                }
              }}
            >
              {option}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A trigger showing the value, opening its picker beneath it. */
function PickerRow({
  label,
  shown,
  icon,
  children,
}: {
  label: string;
  shown: string;
  icon: ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false),
    anchor = useRef<HTMLButtonElement>(null);
  return (
    <Row label={label}>
      <Button
        ref={anchor}
        type="button"
        variant="ghost"
        className="schedule-value schedule-picker"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <span>{shown}</span>
        {icon}
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverContent anchor={anchor} align="end" className="schedule-picker-panel" aria-label={label}>
          {open && children(() => setOpen(false))}
        </PopoverContent>
      </Popover>
    </Row>
  );
}

// ---- Rows (TaskRuleControls.tsx, RuleSelectRow.tsx) ----

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="schedule-row">
      <span className="schedule-row-label">{label}</span>
      {children}
    </div>
  );
}

/** A whole-number stepper: typing or the arrows, clamped to its bounds. */
function Stepper({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next));
  return (
    <span className="schedule-stepper" style={{ "--digits": String(value).length } as CSSProperties}>
      <Input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        onChange={event => {
          const next = Number(event.target.value);
          if (event.target.value !== "" && Number.isSafeInteger(next)) onChange(clamp(next));
        }}
      />
      <span className="schedule-stepper-arrows">
        <Button
          type="button"
          variant="ghost"
          aria-label={`Increase ${label.toLowerCase()}`}
          disabled={value >= max}
          onClick={() => onChange(clamp(value + 1))}
        >
          <ChevronUp size={10} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          aria-label={`Decrease ${label.toLowerCase()}`}
          disabled={value <= min}
          onClick={() => onChange(clamp(value - 1))}
        >
          <ChevronDown size={10} />
        </Button>
      </span>
    </span>
  );
}

/** Every IANA zone, labelled with its current UTC offset, nearest the system zone first. */
type ZoneOption = { zone: string; label: string };
function zoneOptions(): ZoneOption[] {
  const now = Date.now(),
    zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [systemZone()];
  const offset = (zone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" })
      .formatToParts(now)
      .find(part => part.type === "timeZoneName")
      ?.value.replace("GMT", "UTC") ?? "UTC";
  return [...new Set(["UTC", systemZone(), ...zones])].map(zone => ({
    zone,
    label: `${zone.replaceAll("_", " ")} (${offset(zone) === "UTC" ? "UTC+0" : offset(zone)})${zone === systemZone() ? " · this computer" : ""}`,
  }));
}

function ZoneRow({ value, onChange }: { value: string; onChange: (zone: string) => void }) {
  const options = useMemo(zoneOptions, []),
    [query, setQuery] = useState("");
  const current: ZoneOption = options.find(option => option.zone === value) ?? { zone: value, label: value };
  return (
    <Row label="Time zone">
      <Combobox
        items={options}
        value={current}
        inputValue={query}
        onInputValueChange={setQuery}
        itemToStringLabel={(option: ZoneOption) => option.label}
        itemToStringValue={(option: ZoneOption) => option.zone}
        onValueChange={(option: ZoneOption | null) => {
          if (option) {
            onChange(option.zone);
            setQuery("");
          }
        }}
      >
        <ComboboxTrigger aria-label="Time zone" className="schedule-value">
          <span className="truncate">{current.label}</span>
          <ChevronDown size={14} />
        </ComboboxTrigger>
        <ComboboxContent className="schedule-zone-menu">
          <ComboboxInput aria-label="Search time zones" placeholder="Search by UTC offset, zone or city" autoFocus />
          <ComboboxEmpty>No matching time zones</ComboboxEmpty>
          <ComboboxList>
            {(option: ZoneOption) => (
              <ComboboxItem key={option.zone} value={option}>
                <span className="truncate pr-6">{option.label}</span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Row>
  );
}

const REPEATS: { value: FrequencyPreset | "weekdays"; label: string }[] = [
  { value: "once", label: "Once" },
  { value: "daily", label: "Every day" },
  { value: "weekdays", label: "Monday to Friday" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Every month" },
  { value: "hourly", label: "Every N hours" },
  { value: "minutely", label: "Every N minutes" },
  { value: "advanced", label: "Custom" },
];

/** The Run time rows: Repeat, then only the controls that preset uses, then the time zone. */
export function ScheduleFields({ draft, onChange }: { draft: TimingDraft; onChange: (draft: TimingDraft) => void }) {
  const change = (patch: Partial<TimingDraft>) => onChange({ ...draft, ...patch });
  const weekdays =
    draft.frequency === "weekly" &&
    draft.weekdays.length === 5 &&
    [1, 2, 3, 4, 5].every(day => draft.weekdays.includes(day));
  const repeat = weekdays ? "weekdays" : draft.frequency;
  const clock = draft.frequency === "daily" ? draft.dailyTime : draft.start.slice(11, 16);
  const unit = { minutely: "minutes", hourly: "hours", daily: "days", weekly: "weeks", monthly: "months" }[
    draft.frequency as string
  ];
  return (
    <section className="schedule-fields" aria-label="Run time">
      <h3>Run time</h3>
      <div className="schedule-rows">
        <Row label="Repeat">
          <Choice
            label="Repeat"
            value={repeat}
            options={REPEATS}
            onChange={value => {
              const frequency = value === "weekdays" ? "weekly" : value;
              change({
                frequency,
                ...(value === "weekdays"
                  ? { weekdays: [1, 2, 3, 4, 5] }
                  : value === "weekly" && weekdays && draft.weekdays[0] !== undefined
                    ? { weekdays: [draft.weekdays[0]] }
                    : {}),
                ...(frequency === "advanced" ? { rrule: rruleFromDraft(draft, true) } : {}),
              });
            }}
          />
        </Row>
        {unit && (
          <Row label={`Every how many ${unit}`}>
            <Stepper
              label="Interval"
              value={Number(draft.interval)}
              min={1}
              max={9999}
              onChange={value => change({ interval: String(value) })}
            />
          </Row>
        )}
        {draft.frequency === "weekly" && (
          <Row label="Weekday">
            <div className="schedule-weekdays" role="group" aria-label="Weekday">
              {WEEKDAY_NAMES.map((name, index) => {
                const day = index + 1,
                  on = draft.weekdays.includes(day);
                return (
                  <Button
                    key={name}
                    type="button"
                    variant="ghost"
                    className="schedule-pill"
                    aria-pressed={on}
                    aria-label={`Weekday ${name}`}
                    onClick={() =>
                      change({
                        weekdays: on ? draft.weekdays.filter(value => value !== day) : [...draft.weekdays, day].sort(),
                      })
                    }
                  >
                    {name}
                  </Button>
                );
              })}
            </div>
          </Row>
        )}
        {draft.frequency === "monthly" && (
          <Row label="Day of the month">
            <Stepper
              label="Day of the month"
              value={draft.monthDay}
              min={1}
              max={31}
              onChange={monthDay => change({ monthDay })}
            />
          </Row>
        )}
        {draft.frequency === "once" && (
          <PickerRow
            label="Date"
            shown={draft.start.slice(0, 10).replaceAll("-", "/")}
            icon={<CalendarDays size={15} />}
          >
            {close => (
              <DatePicker
                value={draft.start.slice(0, 10)}
                onPick={date => {
                  change({ start: `${date}T${draft.start.slice(11)}` });
                  close();
                }}
              />
            )}
          </PickerRow>
        )}
        {draft.frequency !== "advanced" && draft.frequency !== "minutely" && draft.frequency !== "hourly" && (
          <PickerRow label="Time" shown={clock} icon={<Clock size={15} />}>
            {() => (
              <ClockPicker
                value={clock}
                onPick={time =>
                  change(
                    draft.frequency === "daily"
                      ? { dailyTime: time }
                      : { start: `${draft.start.slice(0, 10)}T${time}:00` },
                  )
                }
              />
            )}
          </PickerRow>
        )}
        {draft.frequency !== "advanced" && (
          <ZoneRow value={draft.timeZone} onChange={timeZone => change({ timeZone })} />
        )}
      </div>
      {draft.frequency === "advanced" && (
        <label className="schedule-custom">
          Custom rule (RFC 5545: a DTSTART line and an RRULE line)
          <Textarea
            aria-label="Custom rule"
            value={draft.rrule}
            spellCheck={false}
            onChange={event => change({ rrule: event.target.value })}
          />
        </label>
      )}
    </section>
  );
}
