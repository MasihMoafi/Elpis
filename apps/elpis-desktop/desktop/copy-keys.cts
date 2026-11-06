'use strict';

import type { Input, WebContents } from 'electron';

// Ctrl+Shift+C copies in terminals; Masih reaches for it in Elpis too. Plain Ctrl+C (and Cmd+C) stay Chromium's own.
function terminalCopy(input: Input | null | undefined) {
  return input?.type === 'keyDown' && input.control === true && input.shift === true && input.alt !== true && input.meta !== true
    && String(input.key).toLowerCase() === 'c';
}

/** Makes Ctrl+Shift+C copy the selection in a window's page. */
function attachCopyKeys(contents: WebContents) {
  contents.on('before-input-event', (event, input) => { if (terminalCopy(input)) { event.preventDefault(); contents.copy(); } });
}

export declare const isTerminalCopy: typeof terminalCopy;
export declare const registerCopyKeys: typeof attachCopyKeys;
module.exports = { isTerminalCopy: terminalCopy, registerCopyKeys: attachCopyKeys };
