'use strict';
const { spawn } = require('node:child_process');
// Capture Xvfb's display before VS Code imports the user's login-shell environment.
const child = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit', env: { ...process.env, ELPIS_EDITOR_TEST_DISPLAY: process.env.DISPLAY, ELPIS_EDITOR_TEST_XAUTHORITY:process.env.XAUTHORITY } });
child.on('exit', code => { process.exitCode = code || 0; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
process.on('SIGTERM', () => child.kill('SIGTERM'));
