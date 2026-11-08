// Ported from dsh-superagent (MIT), tests/model-surface.spec.ts
import { it } from "node:test";
import assert from "node:assert/strict";
import { checkedImText, IM_WORDS } from "./text.mts";

it("enforces the word limit", () => {
  const words = (count: number) => Array.from({ length: count }, () => "word").join(" ");
  assert.equal(checkedImText(words(IM_WORDS)), words(IM_WORDS));
  assert.throws(() => checkedImText(words(IM_WORDS + 1)), new RegExp(`maximum is ${IM_WORDS}`));
});
