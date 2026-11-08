"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { Popover, PopoverContent } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** A month calendar for one date; arrows move the day, Enter picks it. */
export function DatePicker({ value, onPick }: { value: string; onPick: (date: string) => void }) {
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

export const pad = (value: number) => String(value).padStart(2, "0");
export const HOURS = Array.from({ length: 24 }, (_, index) => pad(index)),
  MINUTES = Array.from({ length: 60 }, (_, index) => pad(index));

/** Scrolling hour and minute columns; a pick changes that part of the time at once. */
export function ClockPicker({ value, onPick }: { value: string; onPick: (time: string) => void }) {
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
export function PickerRow({
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

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="schedule-row">
      <span className="schedule-row-label">{label}</span>
      {children}
    </div>
  );
}

/** A whole-number stepper: typing or the arrows, clamped to its bounds. */
export function Stepper({
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

// ---- Pickers (DatePicker.tsx, ClockPicker.tsx) ----


export const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
