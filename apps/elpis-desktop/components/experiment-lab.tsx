"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { OptionSelect } from "@/components/ui/option-select";
import { Segmented } from "@/components/settings/rows";
import { api } from "@/lib/api";
import { initialGraph, TEMPLATES, type CanvasGraph } from "@/lib/canvas";
import { labProgress, labStages, labSummary, type LabRecord, type LabStop } from "@/lib/experiment-lab";
import styles from "./experiment-lab.module.css";
type LabResponse = { record: LabRecord | null };

export function ExperimentLab() {
  const [graph, setGraph] = useState<CanvasGraph | null>(null);
  // Read after the departing Workflows page flushes its latest edits on unmount.
  useEffect(() => { setGraph(initialGraph()); }, []);
  return graph ? <Lab graph={graph} /> : null;
}

function Lab({ graph }: { graph: CanvasGraph }) {
  const [pattern, setPattern] = useState(graph.template === "blank" ? "current" : graph.template ?? "current");
  const [task, setTask] = useState(""), [expected, setExpected] = useState(""), [repetitions, setRepetitions] = useState("3"), [stopWhen, setStopWhen] = useState<LabStop>("count");
  const [record, setRecord] = useState<LabRecord | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false);
  const mounted = useRef(true);
  const stages = useMemo(() => labStages(pattern === "current" ? graph : TEMPLATES.find(template => template.id === pattern)!.build()), [pattern, graph]);
  const n = Number(repetitions), running = record?.status === "running";
  const valid = task.trim() && expected.trim() && Number.isInteger(n) && n >= 1 && n <= 10 && stages.length > 0 && stages.length <= 24;
  useEffect(() => {
    mounted.current = true;
    void api<LabResponse>("/experiment-lab").then(({ record: value }) => {
      if (!mounted.current) return;
      setRecord(value);
      if (value?.request) { setTask(value.request.task); setExpected(value.request.expected); setRepetitions(String(value.request.repetitions)); setStopWhen(value.request.stopWhen ?? "count");
        if (TEMPLATES.some(template => template.id === value.request.pattern)) setPattern(value.request.pattern); }
    }).catch(cause => { if (mounted.current) setError(cause.message); }).finally(() => { if (mounted.current) setLoaded(true); });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => { void api<LabResponse>("/experiment-lab").then(({ record: value }) => { if (mounted.current) { setRecord(value); setError(""); } }).catch(cause => { if (mounted.current) setError(cause.message); }); }, 800);
    return () => clearInterval(timer);
  }, [running]);
  const action = async (stop = false) => {
    setBusy(true); setError("");
    try {
      const { record: value } = await api<LabResponse>("/experiment-lab", stop ? { action: "stop" } : { pattern, task, expected, repetitions: n, stopWhen, stages });
      if (mounted.current) setRecord(value);
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const download = () => {
    if (!record) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(record, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = `elpis-experiment-${record.id}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const status = record ? ({ running: "Running", completed: "Completed", stopped: "Stopped", failed: "Failed", interrupted: "Interrupted" }[record.status]) : "Ready";
  return <section aria-label="Lab" className={`min-h-0 flex-1 ${styles.lab}`}>
    <div className={styles.intro}><h1>Lab</h1><p>Does a pattern earn its extra calls? Compare it with one agent on the same task.</p>
      <p className={styles.muted}>ChatGPT subscription · gpt-6-luna · low thinking · fresh context for every stage</p></div>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); if (valid && !running && !busy) void action(); }}>
      <fieldset className={styles.group} disabled={!loaded || running || busy}>
        <legend>Setup</legend>
        <div className={styles.fields}>
          <label>Pattern<OptionSelect aria-label="Pattern" value={pattern} onChange={event => setPattern(event.target.value)}>
            {TEMPLATES.filter(template => template.id !== "blank").map(template => <option key={template.id} value={template.id}>{template.name}</option>)}
            <option value="current">Current board</option>
          </OptionSelect></label>
          <div className={styles.field}><span>Repeat</span>
            <Segmented label="Repeat" value={stopWhen} onChange={setStopWhen} options={[{ value: "count", label: "Fixed number" }, { value: "solved", label: "Until the task finishes" }]} /></div>
          <label className={styles.count}>{stopWhen === "solved" ? "Repetition limit" : "Repetitions"}<Input type="number" aria-label={stopWhen === "solved" ? "Repetition limit" : "Repetitions"} min={1} max={10} step={1} value={repetitions} onChange={event => setRepetitions(event.target.value)} /></label>
        </div>
        <p className={styles.muted}>{stopWhen === "solved"
          ? "Each repetition runs the single agent and the pattern once. It stops when the pattern’s answer matches the expected answer; the limit only bounds a task that never matches. Any error also stops it."
          : "Each repetition runs the single agent and the pattern once, and every repetition runs."}</p>
      </fieldset>
      <fieldset className={styles.group} disabled={!loaded || running || busy}>
        <legend>Task</legend>
        <label>Task<Textarea aria-label="Task" maxLength={8000} rows={3} value={task} placeholder="A self-contained question with an objectively checkable answer" onChange={event => setTask(event.target.value)} /></label>
        <label>Expected answer<Input aria-label="Expected answer" maxLength={2000} value={expected} onChange={event => setExpected(event.target.value)} placeholder="Exact final answer" /></label>
        <p className={styles.muted}>Pass = exact match after trimming surrounding whitespace. The expected answer stays hidden from every agent.</p>
      </fieldset>
      <div className={styles.actions}>
        <Button type="submit" size="sm" disabled={!valid || running || busy || !loaded}>{busy && !running ? "Starting…" : "Run comparison"}</Button>
        {running && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void action(true)}>Stop experiment</Button>}
        <span className={styles.muted}>{Number.isInteger(n) && n > 0 && n <= 10 ? `${stopWhen === "solved" ? "Up to " : ""}${n * (stages.length + 1)} model calls · ${stages.length} stages per pattern trial` : "Choose 1–10 repetitions"}</span>
      </div>
      <p className={styles.muted}>Answer tasks only: the Canvas roles and checks exchange text instead of files. No browsing or repository edits. Multiple final branches add one synthesis call. The latest comparison is saved locally; export it before starting another.</p>
    </form>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {record && <section className={styles.results} aria-label="Experiment results">
      <div className={styles.actions}><h2>Comparison</h2><span role="status">{status} · {labProgress(record).progress}</span><Button size="sm" variant="ghost" onClick={download}>Export JSON</Button></div>
      <p className={styles.next}>{labProgress(record).next}</p>
      <p className={styles.muted}>Recorded pattern: {TEMPLATES.find(template => template.id === record.request.pattern)?.name ?? "Current board"} · {record.model}</p>
      {record.error && <p role="alert" className={styles.error}>{record.error}</p>}
      <div className={styles.tableWrap}><table aria-label="Comparison"><thead><tr><th>Approach</th><th>Passes</th><th>Mean time</th><th>Mean tokens</th></tr></thead>
        <tbody>{(["baseline", "pattern"] as const).map(arm => { const summary = labSummary(record, arm); return <tr key={arm}><th>{arm === "baseline" ? "Single agent" : "Pattern"}</th><td>{summary.passed}/{summary.count}</td><td>{summary.elapsedMs === null ? "—" : `${(summary.elapsedMs / 1000).toFixed(2)} s`}</td><td>{summary.tokens === null ? "Unknown" : Math.round(summary.tokens).toLocaleString()}</td></tr>; })}</tbody></table></div>
      <p className={styles.muted}>All completed trials count, including failures. Unknown tokens are never treated as zero. A single task cannot establish general superiority; model sampling and service load vary. Pair order alternates.</p>
      {record.trials.map((trial, index) => <details key={index} className={styles.trial}><summary>Trial {trial.repetition} · {trial.arm === "baseline" ? "Single agent" : "Pattern"} · {!trial.endedAt ? "Running" : trial.passed ? "Pass" : "Fail"}</summary>
        {trial.error && <p className={styles.error}>{trial.error}</p>}<pre>{trial.answer || "No final answer"}</pre>
        {trial.steps.map((step, index) => <details key={index}><summary>{step.title} · {(step.elapsedMs / 1000).toFixed(2)} s · {step.usage ? `${step.usage.totalTokens} tokens` : "tokens unknown"}</summary><pre>{JSON.stringify(step, null, 2)}</pre></details>)}
      </details>)}
    </section>}
  </section>;
}
