import assert from "node:assert/strict";
import { test } from "node:test";
import { AGAIN_AFTER, FULL_AT, sidebarFull, storedTold, toldAfter } from "../lib/sidebar-fill.ts";

// 11 Nov, Masih: "it should ping me whenever it feels the side-bar is full, say 10 conversation without a project".
test("the sidebar is full at ten idle chats outside a project, and she says so once", () => {
  assert.equal(sidebarFull(FULL_AT - 1, null), false);
  assert.equal(sidebarFull(FULL_AT, null), true);
  assert.equal(sidebarFull(FULL_AT + 2, FULL_AT), false, "he was told at ten: two more is not news");
});

test("she says so again only when it has grown by five more, or filled again after a tidy", () => {
  assert.equal(sidebarFull(FULL_AT + AGAIN_AFTER, FULL_AT), true);
  assert.equal(toldAfter(FULL_AT - 4, FULL_AT), null, "a tidy emptied it: what she said is forgotten");
  assert.equal(toldAfter(FULL_AT + 1, FULL_AT), FULL_AT);
  assert.equal(sidebarFull(FULL_AT, toldAfter(FULL_AT - 4, FULL_AT)), true);
});

test("a stored count that is not a count is no memory", () => {
  assert.equal(storedTold("12"), 12);
  for (const value of [null, undefined, "", "0", "-3", "many", "1.5"]) assert.equal(storedTold(value), null);
});
