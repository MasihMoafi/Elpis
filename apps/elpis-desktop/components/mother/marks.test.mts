// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/marks.spec.ts.
import { it } from "node:test";
import { expect } from "expect";
import { zh } from "./locales.ts";
import { decisionMark, reportDot, sourceMark, threadMark, ticketMark } from "./marks.ts";
import type { T } from "./text.ts";
const translator =
  (dictionary: Record<string, string>): T =>
  (key, values) =>
    (dictionary[key] ?? key).replace(/\{(\w+)\}/g, (all, name: string) => String(values?.[name] ?? all));

const t = translator(zh);

it("marks each Ticket stage by whom it waits for, and an ended Ticket by its outcome", () => {
  const marks = [
    { stage: "person", action: "answer" },
    { stage: "person", action: "review" },
    { stage: "person", action: "blocked" },
    { stage: "person", action: "failed" },
    { stage: "person", action: "delivery" },
    { stage: "working", action: "queued" },
    { stage: "working" },
    { stage: "idle" },
  ] as const;
  expect(
    marks.map(stage => {
      const { label, tone, dot, icon } = ticketMark(t, { ...stage, ended: undefined });
      return [label, tone, dot, icon];
    }),
  ).toEqual([
    ["待回答", "warning", "warning", "ask"],
    ["待验收", "warning", "warning", "review"],
    ["待处理受阻", "warning", "warning", "blocked"],
    ["待处理失败", "danger", "error", "alert"],
    ["输入未送达", "warning", "warning", "inbox"],
    ["排队中", "neutral", "idle", "queue"],
    ["执行中", "info", "ongoing", "running"],
    ["等待新触发", "neutral", "idle", "clock"],
  ]);
  const ended = (["completed", "merged", "closed", "dropped", "stopped"] as const).map(outcome =>
    ticketMark(t, { stage: "ended", ended: { at: "", by: outcome === "stopped" ? "human" : "executor", outcome } }),
  );
  expect(ended.map(mark => mark.label)).toEqual(["已完成", "PR 已合并", "PR 已关闭（未合并）", "无需处理", "人工停止"]);
  expect(new Set(ended.map(({ tone, dot, icon }) => `${tone} ${dot} ${icon}`))).toEqual(new Set(["neutral idle stop"]));
  expect(["failed", "blocked", "waiting", "ready", "progress", undefined].map(reportDot)).toEqual([
    "error",
    "warning",
    "warning",
    "done",
    "ongoing",
    "ongoing",
  ]);
});

it("marks each Thread stage, Source state and Decision outcome", () => {
  const threads = (["error", "evaluating", "queued", "subscribed", "dormant", "unsubscribed"] as const).map(stage =>
    threadMark(t, { stage, pending: 2 }),
  );
  expect(threads.map(({ label, dot, icon }) => [label, dot, icon])).toEqual([
    ["轮询失败", "error", "alert"],
    ["评估进行中", "ongoing", "running"],
    ["排队 2", "warning", "queue"],
    ["已订阅", "done", "inbox"],
    ["工单已结束", "idle", "clock"],
    ["未订阅", "idle", "hash"],
  ]);
  const sources = (["missing", "off", "error", "setup", "starting", "paused", "ready"] as const).map(state =>
    sourceMark(t, state),
  );
  expect(sources.map(({ label, dot }) => [label, dot])).toEqual([
    ["插件未安装", "idle"],
    ["已关闭", "idle"],
    ["出错", "error"],
    ["等待部署检查", "idle"],
    ["启动中", "ongoing"],
    ["待处理", "warning"],
    ["运行中", "done"],
  ]);
  const decisions = (["accept", "reopen", "stop", "ignore", "unavailable", "wouldAccept"] as const).map(outcome =>
    decisionMark(t, outcome),
  );
  expect(decisions.map(({ label, tone, dot, icon }) => [label, tone, dot, icon])).toEqual([
    ["接单", "success", "done", "decision"],
    ["续做", "success", "done", "refresh"],
    ["停止", "danger", "idle", "stop"],
    ["忽略", "neutral", "idle", "dismiss"],
    ["未完成", "warning", "warning", "alert"],
    ["忽略（可接单，仅观察）", "warning", "idle", "dismiss"],
  ]);
});
