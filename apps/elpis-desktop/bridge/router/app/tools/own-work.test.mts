import { it } from "node:test";
import { expect } from "expect";
import { OwnWorkGate, ownWork } from "./own-work.mts";

it("sees an order to a chat, in his words or in the title the router gave it", () => {
  for (const said of [
    "archive these five worker chats from my checks: Count lines; Count words",
    "Archive the five worker chats from router checks",
    "start a new chat named Watch test on the model gpt-6-luna",
    "Start Watch test chat on gpt-6-luna with low effort",
    "tell the legal chat to also update the dashboard",
    "rename Router test chat to Router test done",
    "stop the scraper chat",
    "restore the archived chat Router test done",
  ])
    expect(ownWork(said)).toMatch(/order to one of his chats/);
});

it("sees a change to the router's own models", () => {
  for (const said of [
    "run your workers on gpt-6.1-sol with xhigh effort again",
    "Restore workers to gpt-6.1-sol with xhigh effort",
    "from now on run your workers on the model gpt-6-luna",
  ])
    expect(ownWork(said)).toMatch(/change to your own settings/);
});

it("lets work through", () => {
  for (const said of [
    "count the lines of the file readme.md and report the number here",
    "fix the failing login test in the desktop app",
    "have a worker run the shell command sleep 240 and then report done",
    "write release notes for v0.6.0",
  ])
    expect(ownWork(said)).toBeUndefined();
});

it("refuses such a request once, then lets the same one through, so a real job is never locked out", () => {
  const gate = new OwnWorkGate();
  const job = "rename the chat component and fix its tests";
  expect(gate.check("t1", "Rename chat component", job)).toMatch(/accept it once more/);
  expect(gate.check("t1", "Rename chat component", job)).toBeUndefined();
  expect(gate.check("t2", "Archive old chats", "archive my old chats")).toMatch(/order to one of his chats/);
});

it("sees an order that names the chat first, and a sweep that names none", () => {
  expect(ownWork("in the Rust chat, tell the agent to rebase")).toMatch(/order to one of his chats/);
  expect(ownWork("archive everything older than a week")).toMatch(/order to one of his chats/);
  expect(ownWork("tidy my sidebar")).toMatch(/order to one of his chats/);
});
