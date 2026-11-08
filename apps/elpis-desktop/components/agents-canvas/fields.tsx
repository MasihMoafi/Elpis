import { useEffect, useId, useState } from "react";
import { Input } from "@/components/ui/input";
import { LANGUAGES } from "@/lib/canvas";

/** The language a translation goes into: any he types, with the tuned ones offered as he types; it applies when he leaves
 * the field or presses Enter, so the team is not rebuilt on every letter. */
export function LanguageField({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (name: string) => void;
}) {
  const [text, setText] = useState(value),
    id = useId();
  useEffect(() => {
    setText(value);
  }, [value]);
  const apply = () => {
    const name = text.trim();
    if (name && name !== value) onChange(name);
    else setText(value);
  };
  return (
    <>
      <Input
        className="h-7 w-36"
        list={id}
        aria-label="Language"
        placeholder="Any language"
        value={text}
        disabled={disabled}
        onChange={event => setText(event.target.value)}
        onBlur={apply}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            apply();
          }
          if (event.key === "Escape") setText(value);
        }}
      />
      <datalist id={id}>
        {LANGUAGES.map(language => (
          <option key={language.id} value={language.name} />
        ))}
      </datalist>
    </>
  );
}

/** A count the user types, kept within what Elpis allows: a valid number applies as it is typed; one out of range is
 * refused, saying why, and leaving the field puts the last good number back. */
export function CountField({
  label,
  value,
  min,
  max,
  why,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  why: (typed: number) => string;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value)),
    [error, setError] = useState("");
  useEffect(() => {
    setText(String(value));
  }, [value]);
  const type = (next: string) => {
    setText(next);
    const typed = Number(next);
    if (next === "" || !Number.isInteger(typed) || typed < min || typed > max) {
      setError(next === "" ? "" : why(typed));
      return;
    }
    setError("");
    if (typed !== value) onChange(typed);
  };
  return (
    <label className="canvas-chip canvas-count">
      {label}
      <Input
        className="hud-cut-sm h-6 w-12 px-1.5 text-center tabular-nums md:text-xs"
        inputMode="numeric"
        aria-label={label}
        aria-invalid={Boolean(error)}
        value={text}
        onChange={event => type(event.target.value.replace(/\D/g, ""))}
        onBlur={() => {
          setText(String(value));
          setError("");
        }}
        onKeyDown={event => {
          if (event.key === "Escape") {
            setText(String(value));
            setError("");
          }
        }}
      />
      {error && (
        <span className="canvas-count-error" role="alert">
          {error}
        </span>
      )}
    </label>
  );
}

/** A pattern's shape: the Mother, then a column of agents per wave, in run order. */
export function Shape({ shape }: { shape: number[] }) {
  return (
    <span className="canvas-shape" aria-hidden="true">
      <span>
        <i className="canvas-kind" data-kind="mother" />
      </span>
      {shape.map((count, index) => (
        <span key={index}>
          {Array.from({ length: count }, (_, row) => (
            <i key={row} className="canvas-kind" data-kind="agent" />
          ))}
        </span>
      ))}
    </span>
  );
}
