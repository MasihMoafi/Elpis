import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { startDesktopServer } from "./server.mts";

test("only the split-session document (application and Obsidian) and the Trajectory page (application) may be framed; external embedding remains refused", async () => {
  const client = Object.assign(new EventEmitter(), { close() {}, connected: true });
  const server = await startDesktopServer({ client });
  try {
    const origin = new URL(server.url).origin;
    const normal = await fetch(origin);
    assert.equal(normal.headers.get("x-frame-options"), "DENY");
    const split = await fetch(`${origin}/?pane=1&session=chat-a`);
    // Since 5 Nov (0c91c9604) Obsidian's plugin panes embed it too; X-Frame-Options cannot name app://obsidian.md, so the
    // policy's frame-ancestors alone allows exactly the application and Obsidian.
    assert.equal(split.headers.get("x-frame-options"), null);
    assert.match(
      split.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'self' app:\/\/obsidian\.md(;|$)/,
    );
    // Observability's Trajectory page: the application only.
    const trajectory = await fetch(`${origin}/trajectory/index.html`);
    assert.equal(trajectory.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.match(trajectory.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'(;|$)/);
    const hostile = await fetch(`${origin}/?pane=1`, { headers: { Origin: "https://external.invalid" } });
    assert.equal(hostile.status, 403);
  } finally {
    await server.close();
  }
});
