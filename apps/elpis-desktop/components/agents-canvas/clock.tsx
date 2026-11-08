import { useEffect, useState } from "react";

/** The run's clock, as Deus Ex's tracing timer: minutes and seconds since the run started, stopping when it ends. */
export function RunClock({ since, until }: { since: number; until?: number | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (until !== undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since, until]);
  return <strong>{clock((until ?? now) - since)}</strong>;
}

/** A span of time as mm:ss. */
export const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
};
