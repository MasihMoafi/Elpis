import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const allowed = new Map([['/', ['index.html', 'text/html']], ['/styles.css', ['styles.css', 'text/css']], ['/demo.mjs', ['demo.mjs', 'text/javascript']], ['/fixture.mjs', ['fixture.mjs', 'text/javascript']]]);
const port = Number(process.env.ELPIS_DEMO_PORT || 43127);
createServer(async (request, response) => {
  const asset = allowed.get(new URL(request.url, 'http://127.0.0.1').pathname);
  if (!asset) { response.writeHead(404).end(); return; }
  try {
    const content = await readFile(new URL(asset[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' }).end(content);
  } catch { response.writeHead(500).end('Preview asset unavailable'); }
}).listen(port, '127.0.0.1', () => console.log(`Elpis candidate: http://127.0.0.1:${port}`));
