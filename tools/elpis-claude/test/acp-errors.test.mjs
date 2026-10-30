import test from "node:test";
import assert from "node:assert/strict";
import { acpErrorInfo } from "../acp-errors.mjs";

for (const [message, expected] of [
  ["Individual quota reached. Please upgrade your subscription. Resets in 17h3m6s.", "usageLimitExceeded"],
  ["You have hit your weekly limit.", "usageLimitExceeded"],
  ["usage limit", "usageLimitExceeded"],
  ["rate limit", "rateLimitExceeded"],
  ["Request failed (HTTP 429)", "rateLimitExceeded"],
]) test(`classifies subscription limit: ${message}`, () => {
  assert.equal(acpErrorInfo({ message }), expected);
});

test("uses structured ACP error kinds before message wording", () => {
  assert.equal(acpErrorInfo({ message: "Provider refused the turn", data: { errorKind: "usage_limit_reached" } }), "usageLimitExceeded");
  assert.equal(acpErrorInfo({ message: "Provider refused the turn", errorKind: "rate_limit_error" }), "rateLimitExceeded");
});

for (const message of [
  "The connection ended.",
  "Weekly report failed because the file is missing.",
  "Please review the weekly limit documentation.",
  "Please review the rate limit documentation.",
]) test(`does not classify an unrelated failure: ${message}`, () => {
  assert.equal(acpErrorInfo({ message }), null);
});
