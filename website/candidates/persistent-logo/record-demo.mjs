// Records the illustrative browser candidate using system ffmpeg; no downloads.
// Start preview.mjs first. Refuses to replace an existing recording.
import { chromium } from '/home/masih/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright-core/index.mjs';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('demo.webm', import.meta.url));
try {
  await access(output);
  throw new Error(`Recording already exists: ${output}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1280 }, reducedMotion: 'no-preference' });
  await page.goto(process.env.ELPIS_DEMO_URL || 'http://127.0.0.1:43127');
  await page.waitForTimeout(1000);
  const encoder = spawn('nice', ['-n', '10', '/usr/bin/ffmpeg', '-hide_banner', '-loglevel', 'error', '-n', '-f', 'image2pipe', '-framerate', '20', '-i', 'pipe:0', '-an', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '1', '-b:v', '0', '-crf', '36', '-pix_fmt', 'yuv420p', output], { stdio: ['pipe', 'ignore', 'pipe'] });
  let encoderError = '';
  encoder.stderr.on('data', chunk => { encoderError += chunk; });
  const completed = new Promise((resolve, reject) => {
    encoder.on('error', reject);
    encoder.on('close', code => code === 0 ? resolve() : reject(new Error(encoderError || `ffmpeg exited ${code}`)));
  });
  const cdp = await page.context().newCDPSession(page);
  let lastTime = -Infinity;
  let frames = 0;
  cdp.on('Page.screencastFrame', event => {
    void cdp.send('Page.screencastFrameAck', { sessionId: event.sessionId });
    const timestamp = event.metadata.timestamp;
    if (timestamp - lastTime >= 0.045) {
      lastTime = timestamp;
      encoder.stdin.write(Buffer.from(event.data, 'base64'));
      frames += 1;
    }
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 82, maxWidth: 1440, maxHeight: 1280, everyNthFrame: 1 });
  await page.waitForTimeout(8000);
  await cdp.send('Page.stopScreencast');
  await cdp.detach();
  encoder.stdin.end();
  await completed;
  console.log(JSON.stringify({ output, frames, nominalSeconds: frames / 20, finalUsed: await page.locator('#used').textContent(), illustrative: true }));
} finally {
  await browser.close();
}
