'use strict';

// The desktop menu and the rendered menubar share labels, ordering and command IDs.
const APP_MENUS = /** @type {const} */ ([
  { label: 'File', items: [
    { id: 'new-chat', label: 'New chat', target: 'renderer', shortcut: 'new-chat' },
    { id: 'new-window', label: 'New window', target: 'native', accelerator: 'CommandOrControl+Shift+N', shortcut: 'new-window' },
    { id: 'open-folder', label: 'Open folder…', target: 'renderer' },
    { separator: true },
    { id: 'settings', label: 'Settings', target: 'renderer', shortcut: 'settings' },
    { separator: true },
    { id: 'close-window', label: 'Close window', target: 'native' },
    { id: 'quit', label: 'Quit Elpis', target: 'native', accelerator: 'CommandOrControl+Q' },
  ] },
  { label: 'Edit', items: [
    { id: 'undo', label: 'Undo', target: 'native', role: 'undo', hint: 'Ctrl+Z' },
    { id: 'redo', label: 'Redo', target: 'native', role: 'redo', hint: 'Ctrl+Shift+Z' },
    { separator: true },
    { id: 'cut', label: 'Cut', target: 'native', role: 'cut', hint: 'Ctrl+X' },
    { id: 'copy', label: 'Copy', target: 'native', role: 'copy', hint: 'Ctrl+C' },
    { id: 'paste', label: 'Paste', target: 'native', role: 'paste', hint: 'Ctrl+V' },
    { id: 'selectAll', label: 'Select all', target: 'native', role: 'selectAll', hint: 'Ctrl+A' },
  ] },
  { label: 'View', items: [
    { id: 'sidebar', label: 'Toggle sidebar', target: 'renderer', shortcut: 'sidebar' },
    { id: 'back', label: 'Back', target: 'renderer', shortcut: 'back' },
    { id: 'forward', label: 'Forward', target: 'renderer', shortcut: 'forward' },
    { separator: true },
    { id: 'zoomIn', label: 'Zoom in', target: 'native', role: 'zoomIn', hint: 'Ctrl++' },
    { id: 'zoomOut', label: 'Zoom out', target: 'native', role: 'zoomOut', hint: 'Ctrl+−' },
    { id: 'resetZoom', label: 'Actual size', target: 'native', role: 'resetZoom', hint: 'Ctrl+0' },
    { separator: true },
    { id: 'fullscreen', label: 'Toggle fullscreen', target: 'native', role: 'togglefullscreen', hint: 'F11' },
  ] },
  { label: 'Help', items: [
    { id: 'shortcuts', label: 'Keyboard shortcuts', target: 'renderer', shortcut: 'shortcuts' },
  ] },
]);

module.exports = { APP_MENUS };
