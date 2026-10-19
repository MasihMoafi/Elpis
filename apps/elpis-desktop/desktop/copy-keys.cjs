'use strict';

// Ctrl+Shift+C copies in terminals; Masih reaches for it in Elpis too. Plain Ctrl+C (and Cmd+C) stay Chromium's own.
function isTerminalCopy(input) {
  return input?.type === 'keyDown' && input.control === true && input.shift === true && input.alt !== true && input.meta !== true
    && String(input.key).toLowerCase() === 'c';
}

/** Makes Ctrl+Shift+C copy the selection in a window's page. */
function registerCopyKeys(contents) {
  contents.on('before-input-event', (event, input) => { if (isTerminalCopy(input)) { event.preventDefault(); contents.copy(); } });
}

module.exports = { isTerminalCopy, registerCopyKeys };
