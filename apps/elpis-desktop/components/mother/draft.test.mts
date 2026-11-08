// Adapted from DeepSeek dsh-superagent-prototype (MIT), tests/draft.spec.ts.
import { it } from "node:test";
import { expect } from "expect";
import { draftReducer, merge3, saveBarText, type DraftAction, type DraftState } from "./draft-state.ts";
import type { T } from "./text.ts";

const merged = (base: unknown, mine: unknown, theirs: unknown) => {
  const conflicts: string[][] = [];
  return { value: merge3(base, mine, theirs, conflicts), conflicts };
};

it("takes each key from the side that changed it, through nested records", () => {
  const base = { mode: "observe", model: { provider: "a", model: "x" }, skills: { one: "1", two: "2" } };
  expect(
    merged(
      base,
      { ...base, mode: "auto", skills: { one: "1!", two: "2" } },
      { ...base, model: { provider: "b", model: "x" }, skills: { one: "1", two: "2?" } },
    ),
  ).toEqual({
    value: { mode: "auto", model: { provider: "b", model: "x" }, skills: { one: "1!", two: "2?" } },
    conflicts: [],
  });
});

it("keeps mine where both sides changed a key, and names it by its path", () => {
  const base = { eval: { timeoutSeconds: 120, mode: "off" } };
  expect(
    merged(base, { eval: { timeoutSeconds: 60, mode: "off" } }, { eval: { timeoutSeconds: 300, mode: "auto" } }),
  ).toEqual({ value: { eval: { timeoutSeconds: 60, mode: "auto" } }, conflicts: [["eval", "timeoutSeconds"]] });
});

it("removes a key one side removed, unless the other side changed it", () => {
  const base = { skills: { one: "1", two: "2", three: "3" } };
  expect(merged(base, { skills: { two: "2", three: "3!" } }, { skills: { one: "1", two: "2" } })).toEqual({
    value: { skills: { two: "2", three: "3!" } },
    conflicts: [["skills", "three"]],
  });
});

it("merges lists of named elements element by element, in their order, with what each side added", () => {
  const rule = (id: string, name: string) => ({ id, name, enabled: true });
  const base = [rule("a", "A"), rule("b", "B"), rule("c", "C")];
  // Mine renames a, removes c, and adds d after b; theirs renames b, prepends e, and removes nothing.
  const mine = [rule("a", "A!"), rule("b", "B"), rule("d", "D")];
  const theirs = [rule("e", "E"), rule("a", "A"), rule("b", "B?"), rule("c", "C")];
  expect(merged({ rules: base }, { rules: mine }, { rules: theirs })).toEqual({
    value: { rules: [rule("e", "E"), rule("a", "A!"), rule("b", "B?"), rule("d", "D")] },
    conflicts: [],
  });
  // Chat rows are keyed by chatId; concurrent edits to the same row field conflict on that row only.
  const chats = (listen: string, other: string) => [
    { chatId: "oc_1", listen },
    { chatId: "oc_2", listen: other },
  ];
  expect(merged(chats("mentions", "mentions"), chats("all", "mentions"), chats("none", "all"))).toEqual({
    value: chats("all", "all"),
    conflicts: [["oc_1", "listen"]],
  });
});

it("merges a list without names as a whole", () => {
  expect(merged(["a"], ["a", "b"], ["c"])).toEqual({ value: ["a", "b"], conflicts: [[]] });
  expect(merged(["a"], ["a"], ["c"])).toEqual({ value: ["c"], conflicts: [] });
});

type Value = { mode: string; limit: number };
const saved: Value = { mode: "off", limit: 1 };
const t = ((key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key)) as T;
const after = (
  actions: DraftAction<Value, undefined>[],
  state: DraftState<Value, undefined> = { phase: "clean", seen: 1 },
) => actions.reduce(draftReducer<Value, undefined>, state);
const edit = (value: Value, from = saved, revision = 1): DraftAction<Value, undefined> => ({
  type: "edit",
  value,
  meta: undefined,
  saved: from,
  revision,
});
const arrived = (value: Value, revision: number): DraftAction<Value, undefined> => ({
  type: "revisionArrived",
  saved: value,
  revision,
});

it("saves an edit and shows it until its revision is read back, holding edits and other revisions while the save runs", () => {
  const mine = { mode: "auto", limit: 1 };
  const saving = after([edit(mine), { type: "submit" }]);
  expect(saving).toMatchObject({ phase: "saving", draft: { base: saved, value: mine, revision: 1 } });
  expect(after([edit(saved), arrived(saved, 2), { type: "discard" }], saving)).toBe(saving);
  const waiting = after([{ type: "saved", revision: 2, restarting: true }], saving);
  expect(waiting).toMatchObject({ phase: "awaitingRevision", sent: { value: mine, revision: 2 } });
  expect(saveBarText(t, waiting)).toEqual({ status: "savedRestarting" });
  expect(after([arrived(mine, 2)], waiting)).toEqual({ phase: "clean", seen: 2 });
  expect(after([edit(mine), edit(saved)])).toEqual({ phase: "clean", seen: 1 });
});

it("merges another saved revision into a draft, tells a merge from a conflict, and keeps only the conflict across an edit", () => {
  const editing = after([edit({ mode: "auto", limit: 1 })]);
  const merged = after([arrived({ mode: "off", limit: 5 }, 2)], editing);
  expect(merged).toMatchObject({
    phase: "editing",
    seen: 2,
    notice: { kind: "merged", revision: 2 },
    draft: { base: { mode: "off", limit: 5 }, value: { mode: "auto", limit: 5 }, revision: 2 },
  });
  const conflict = after([arrived({ mode: "observe", limit: 1 }, 2)], editing);
  expect(saveBarText(t, conflict)).toEqual({ error: "saveConflict", status: "" });
  expect(after([edit({ mode: "auto", limit: 6 }, { mode: "off", limit: 5 }, 2)], merged).notice).toBeUndefined();
  expect(after([edit({ mode: "auto", limit: 2 }, { mode: "observe", limit: 1 }, 2)], conflict).notice).toMatchObject({
    kind: "conflict",
  });
  // Another save that made the same change leaves nothing to save.
  expect(after([arrived({ mode: "auto", limit: 1 }, 2)], editing)).toEqual({ phase: "clean", seen: 2 });
});

it("keeps a refused save as a draft with why, and words a restored draft unless its block words its drafts itself", () => {
  const saving = after([edit({ mode: "auto", limit: 1 }), { type: "submit" }]);
  expect(saveBarText(t, after([{ type: "refused", notice: { kind: "rebasing" } }], saving))).toEqual({
    status: "saveRebasing",
  });
  const invalid = after([{ type: "refused", notice: { kind: "invalid", fields: ["limit", "mode"] } }], saving);
  expect(invalid.phase).toBe("editing");
  expect(saveBarText(t, invalid)).toEqual({ error: 'invalidSettings {"fields":"limitlistSeparatormode"}', status: "" });
  const restored: DraftState<Value, undefined> = {
    phase: "editing",
    seen: 1,
    notice: { kind: "restored" },
    draft: { base: saved, value: { mode: "auto", limit: 1 }, revision: 1 },
  };
  expect(saveBarText(t, restored)).toEqual({ status: "draftRestored" });
  expect(saveBarText(t, restored, { editing: "Version 1 · 1 change" })).toEqual({ status: "Version 1 · 1 change" });
  expect(
    saveBarText(t, after([arrived({ mode: "off", limit: 3 }, 2)], restored), {
      merged: revision => `Prompts at ${revision}`,
    }),
  ).toEqual({ status: "Prompts at 2" });
});

it("waits for the revision its save made, keeping the value it sent, while an older revision arrives", () => {
  const sent = { mode: "auto", limit: 1 };
  const waiting = after([edit(sent), { type: "submit" }, { type: "saved", revision: 3, restarting: false }]);
  const older = after([arrived(saved, 2)], waiting);
  expect(older).toMatchObject({ phase: "awaitingRevision", seen: 2, sent: { value: sent, revision: 3 } });
  expect(saveBarText(t, older)).toEqual({ status: "saved" });
  expect(after([arrived(sent, 3)], older)).toEqual({ phase: "clean", seen: 3 });
});

it("keeps editing when the browser cannot store the draft, and says so", () => {
  const unstored = after([
    edit({ mode: "auto", limit: 1 }),
    { type: "refused", notice: { kind: "unstored", error: "QuotaExceededError" } },
  ]);
  expect(unstored.phase).toBe("editing");
  expect(saveBarText(t, unstored)).toEqual({ error: 'draftFailed {"error":"QuotaExceededError"}', status: "" });
  expect(after([edit({ mode: "auto", limit: 2 })], unstored).notice).toEqual({
    kind: "unstored",
    error: "QuotaExceededError",
  });
});

it("removes an element of a named list that mine deleted and theirs changed, and names the conflict", () => {
  const rule = (id: string, name: string) => ({ id, name });
  expect(merged([rule("a", "A"), rule("b", "B")], [rule("a", "A")], [rule("a", "A"), rule("b", "B?")])).toEqual({
    value: [rule("a", "A")],
    conflicts: [["b"]],
  });
});
