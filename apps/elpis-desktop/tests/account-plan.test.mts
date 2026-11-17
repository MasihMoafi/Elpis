import test from "node:test";
import assert from "node:assert/strict";
import { accountPlanLabel } from "../lib/account-plan.mts";

test("known plans have a readable label", () => {
  assert.equal(accountPlanLabel("plus"), "Plus");
  assert.equal(accountPlanLabel(" PRO "), "Pro");
});
test("internal or unfamiliar plan codes are never shown as subscription names", () => {
  assert.equal(accountPlanLabel("prolite"), null);
  assert.equal(accountPlanLabel("new_internal_plan"), null);
  assert.equal(accountPlanLabel("constructor"), null);
});
test("a missing plan leaves the person's account name usable", () => {
  assert.equal(accountPlanLabel(null), null);
  assert.equal(accountPlanLabel(undefined), null);
  assert.equal(accountPlanLabel(""), null);
});
