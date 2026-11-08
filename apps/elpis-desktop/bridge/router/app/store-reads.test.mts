import { join } from "node:path";
import { it } from "node:test";
import { expect } from "expect";
import { Store } from "./store.mts";
import { directory } from "./store.fixtures.mts";

it("reads `%` and `_` in a key prefix and a search query as written, not as patterns", () => {
  const store = new Store(join(directory, "orchestrator.sqlite"));
  for (const name of ["a%b", "axb", "a_c", "abc"]) store.set(name, 1);
  expect([store.keys("a%").sort(), store.keys("a_").sort()]).toEqual([["a%b"], ["a_c"]]);
  const said = (id: string, text: string) => ({
    id,
    source: "feishu",
    threads: [{ source: "feishu", id: "oc_1:om_1" }],
    actor: { source: "feishu", id: "u" },
    human: true,
    at: "2026-10-01T00:00:00.000Z",
    text,
    meta: {},
  });
  for (const [id, text] of [
    ["p", "grew 50% today"],
    ["q", "grew 500 today"],
    ["r", "see a_b"],
    ["s", "see axb"],
  ])
    store.triggers.save(said(id!, text!));
  expect([store.read.search("50%").map(item => item.id), store.read.search("a_b").map(item => item.id)]).toEqual([
    ["p"],
    ["r"],
  ]);
  store.close();
});
