// The server ui-check renders (ui-check.json "start"): the exported renderer out/ against the parity fixture's mock
// bridge (three chats; no engine, model or network), on the port ui-check gives: node scripts/ui-check-serve.cjs <port>
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// ui-check runs only where its checker is installed, so its Playwright is there too.
process.env.ELPIS_PLAYWRIGHT_PACKAGE ||= path.join(os.homedir(), 'Desktop/p/skills/web-dev/ui-check/node_modules/playwright');
const { fixture } = require('../tests/parity-fixture.cjs');

fixture({ desktop: false }).then(({ page, close }) => {
  const bridge = Number(new URL(page.url()).port);
  net.createServer(client => {
    const upstream = net.connect(bridge, '127.0.0.1');
    client.pipe(upstream).pipe(client);
    for (const end of [client, upstream]) end.on('error', () => { client.destroy(); upstream.destroy(); });
  }).listen(Number(process.argv[2]), '127.0.0.1');
  // ui-check stops the server with SIGTERM; the listening socket would otherwise keep this process alive.
  process.on('SIGTERM', () => Promise.resolve(close()).finally(() => process.exit(0)));
});
