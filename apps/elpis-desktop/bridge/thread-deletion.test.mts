import { test } from "node:test";
import assert from "node:assert/strict";
import { scanDeletionThreads, type DeletionPage, type DeletionPageOptions } from "../lib/thread-deletion.ts";

const row = (id: string) => ({ id, forkedFromId: `source-${id}`, marker: `metadata-${id}` });
type Row = ReturnType<typeof row>;
function pages({
  failMode,
  badMode,
  badCursor,
  malformedRow,
}: { failMode?: boolean; badMode?: boolean; badCursor?: unknown; malformedRow?: unknown } = {}) {
  const rows = {
    false: Array.from({ length: 125 }, (_, index) => row(`active-${index}`)),
    true: Array.from({ length: 125 }, (_, index) => row(`archived-${index}`)),
  };
  rows.true.unshift(row("active-0"));
  const reads: DeletionPageOptions[] = [];
  const readPage = async (options: DeletionPageOptions): Promise<DeletionPage<Row>> => {
    reads.push(options);
    const start = Number(options.cursor || 0),
      next = start + options.limit;
    if (options.archived === failMode && start) throw new Error("Fixture later page failed");
    const data = rows[String(options.archived) as "true" | "false"].slice(start, next);
    if (options.archived === badMode && malformedRow) data[0] = malformedRow as Row;
    return {
      data,
      nextCursor:
        options.archived === badMode && badCursor !== undefined
          ? (badCursor as string | null)
          : next < rows[String(options.archived) as "true" | "false"].length
            ? String(next)
            : null,
    };
  };
  return { rows, reads, readPage };
}

test("deletion scan reads active and archived pages with independent cursors, retaining metadata once per ID", async () => {
  const f = pages(),
    result = await scanDeletionThreads(f.readPage);
  assert.deepEqual(result, [...f.rows.false, ...f.rows.true.slice(1)]);
  assert.deepEqual(f.reads, [
    { archived: false, limit: 100 },
    { archived: false, limit: 100, cursor: "100" },
    { archived: true, limit: 100 },
    { archived: true, limit: 100, cursor: "100" },
  ]);
});

test("deletion scan still reads archived rows when no active rows exist", async () => {
  const f = pages();
  f.rows.false.length = 0;
  assert.deepEqual(await scanDeletionThreads(f.readPage), f.rows.true);
});

for (const archived of [false, true]) {
  test(`deletion scan rejects a later ${archived ? "archived" : "active"} failure before its caller can mutate`, async () => {
    const f = pages({ failMode: archived });
    let mutations = 0;
    await assert.rejects(
      scanDeletionThreads(f.readPage).then(() => mutations++),
      /Fixture later page failed/,
    );
    assert.equal(mutations, 0);
  });
  for (const cursor of ["100", "", 7, undefined])
    test(`deletion scan refuses ${archived ? "archived" : "active"} ${cursor === "100" ? "repeated" : String(cursor)} cursors`, async () => {
      const f = pages({ badMode: archived, badCursor: cursor });
      let mutations = 0;
      const readPage =
        cursor === undefined
          ? async (options: DeletionPageOptions) => {
              const page: Partial<DeletionPage<Row>> = await f.readPage(options);
              if (options.archived === archived) delete page.nextCursor;
              return page as DeletionPage<Row>;
            }
          : f.readPage;
      await assert.rejects(
        scanDeletionThreads(readPage).then(() => mutations++),
        /complete|list|cursor/i,
      );
      assert.equal(mutations, 0);
    });
  for (const malformed of [null, {}, { id: "" }, { id: "   " }, { id: 7 }])
    test(`deletion scan refuses malformed ${archived ? "archived" : "active"} rows ${JSON.stringify(malformed)}`, async () => {
      const f = pages();
      let mutations = 0;
      const readPage = async (options: DeletionPageOptions) => {
        const page = await f.readPage(options);
        if (options.archived === archived) page.data[0] = malformed as Row;
        return page;
      };
      await assert.rejects(
        scanDeletionThreads(readPage).then(() => mutations++),
        /complete|list|row/i,
      );
      assert.equal(mutations, 0);
    });
}

test("deletion scan refuses malformed page data before returning any partial rows", async () => {
  let mutations = 0;
  await assert.rejects(
    scanDeletionThreads(async () => ({ data: null, nextCursor: null }) as unknown as DeletionPage<Row>).then(
      () => mutations++,
    ),
    /complete|list|row/i,
  );
  assert.equal(mutations, 0);
});
