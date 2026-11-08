import test from "node:test";
import assert from "node:assert/strict";
import { BoundedCache } from "./bounded-cache.mts";

test("derived metadata evicts the least recently read entry and replacements keep the budget", () => {
  const cache = new BoundedCache<string, { value: number }>(2);
  cache.set("first", { value: 1 });
  cache.set("second", { value: 2 });
  assert.equal(cache.get("first")?.value, 1);
  cache.set("third", { value: 3 });
  assert.equal(cache.has("second"), false);
  assert.equal(cache.has("first"), true);
  cache.set("first", { value: 4 });
  cache.set("fourth", { value: 5 });
  assert.deepEqual([...cache.keys()], ["first", "fourth"]);
  assert.equal(cache.get("first")?.value, 4);
  assert.equal(cache.get("absent"), undefined);
  for (let index = 0; index < 10000; index++) cache.set(String(index), { value: index });
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
  assert.throws(() => new BoundedCache(0), RangeError);
});
