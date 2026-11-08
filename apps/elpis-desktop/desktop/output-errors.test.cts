const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn }: typeof import("node:child_process") = require("node:child_process");
const path = require("node:path");

test("closed output pipes do not crash, but other stream errors remain uncaught", async () => {
  for (const stream of ["stdout", "stderr"] as const) {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      require(${JSON.stringify(path.join(__dirname, "output-errors.cts"))});
      process.on('uncaughtException', error => { process.send({ uncaught: error.code }); process.exit(1); });
      process.on('message', () => {
        process[${JSON.stringify(stream)}].write('closed pipe', error => {
          process.send({ written: error && error.code });
        });
      });
      process.send({ ready: true });
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] },
    );
    const messages: Array<Record<string, string | boolean>> = [];
    child.on("message", (message: Record<string, string | boolean>) => {
      messages.push(message);
      if (message.ready) {
        child[stream]!.destroy();
        child.send("write");
      }
      if (message.written) setImmediate(() => child.disconnect());
    });
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(Error("child timed out"));
      }, 5000);
      child.on("error", reject);
      child.on("exit", (exitCode, exitSignal) => {
        clearTimeout(timer);
        resolve([exitCode, exitSignal]);
      });
    });
    assert.deepEqual([code, signal], [0, null], JSON.stringify(messages));
    assert.equal(
      messages.some(message => message.written === "EPIPE"),
      true,
      JSON.stringify(messages),
    );
    assert.equal(
      messages.some(message => message.uncaught),
      false,
      JSON.stringify(messages),
    );
  }
  for (const code of ["ERR_STREAM_DESTROYED", "EIO"]) {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      require(${JSON.stringify(path.join(__dirname, "output-errors.cts"))});
      process.stdout.emit('error', Object.assign(new Error('test'), { code: ${JSON.stringify(code)} }));
    `,
      ],
      { stdio: "ignore" },
    );
    const exitCode = await new Promise<number | null>(resolve => child.on("exit", resolve));
    assert.equal(exitCode, code === "EIO" ? 1 : 0, code);
  }
});
