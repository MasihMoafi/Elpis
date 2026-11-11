import assert from "node:assert/strict";
import { test } from "node:test";
import { storedWorkflowTab } from "../lib/workflows-view.ts";

test("Workflows opens on the Map until he has chosen another view", () => {
  assert.equal(storedWorkflowTab(null), "map");
  assert.equal(storedWorkflowTab(undefined), "map");
  assert.equal(storedWorkflowTab("map"), "map");
});

test("Workflows reopens on the view he last used", () => {
  assert.equal(storedWorkflowTab("board"), "board");
  assert.equal(storedWorkflowTab("scheduled"), "scheduled");
});

test("a stored value that is not a view falls back to the Map", () => {
  assert.equal(storedWorkflowTab("canvas"), "map");
  assert.equal(storedWorkflowTab(""), "map");
});
