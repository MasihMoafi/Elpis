'use strict';

// Electron shows no menu on right-click by itself. This is the ChatGPT app's text menu: spelling
// suggestions, Cut/Copy/Paste/Select all in fields, Copy for selected text, link and image items.
// App objects (chats, projects, tabs, messages) draw their own menu in the page and cancel this one.

const external = (url, origin) => {
  try { const { protocol, origin: target } = new URL(url); return (protocol === 'https:' || protocol === 'http:') && target !== origin; }
  catch { return false; }
};

/** The items for one right-click, from Electron's `context-menu` parameters. Empty when there is nothing to offer. */
function contextMenuTemplate(params, { contents, clipboard, openLink, origin, changeThis }) {
  const flags = params.editFlags ?? {};
  const edit = (label, accelerator, enabled, click) => ({ label, accelerator, registerAccelerator: false, enabled, click });
  const groups = [];
  if (params.isEditable && params.misspelledWord) {
    const word = params.misspelledWord, suggestions = params.dictionarySuggestions ?? [];
    groups.push([
      ...(suggestions.length ? suggestions.map(label => ({ label, click: () => contents.replaceMisspelling(label) })) : [{ label: 'No guesses found', enabled: false }]),
      { type: 'separator' },
      { label: 'Learn spelling', click: () => contents.session.addWordToSpellCheckerDictionary(word) },
    ]);
  }
  if (params.isEditable) {
    groups.push([
      edit('Cut', 'CmdOrCtrl+X', !!flags.canCut, () => contents.cut()),
      edit('Copy', 'CmdOrCtrl+C', !!flags.canCopy, () => contents.copy()),
      edit('Paste', 'CmdOrCtrl+V', !!flags.canPaste, () => contents.paste()),
      edit('Select all', 'CmdOrCtrl+A', !!flags.canSelectAll, () => contents.selectAll()),
    ]);
  } else if (params.selectionText) groups.push([edit('Copy', 'CmdOrCtrl+C', true, () => contents.copy())]);
  if (params.mediaType === 'image') {
    groups.push([
      { label: 'Copy image', click: () => contents.copyImageAt(params.x, params.y) },
      ...(/^(https?:|data:image\/)/i.test(params.srcURL ?? '') ? [{ label: 'Save image as…', click: () => contents.downloadURL(params.srcURL) }] : []),
    ]);
  }
  if (external(params.linkURL, origin)) {
    groups.push([
      ...(openLink ? [{ label: 'Open link', click: () => openLink(params.linkURL) }] : []),
      { label: 'Copy link', click: () => { Promise.resolve(clipboard.writeText(params.linkURL)).catch(() => { /* The clipboard stays as it was. */ }); } },
    ]);
  }
  if (changeThis) groups.push([{ label: 'Change this…', click: () => changeThis({ x: params.x, y: params.y }) }]);
  return groups.flatMap((group, index) => index ? [{ type: 'separator' }, ...group] : group);
}

/** Shows that menu for right-clicks in these web contents. Returns a function that detaches it. */
function attachContextMenu(contents, { Menu, clipboard, openLink, origin, window, changeThis }) {
  const show = (_event, params) => {
    const template = contextMenuTemplate(params, { contents, clipboard, openLink, origin, changeThis });
    if (template.length) Menu.buildFromTemplate(template).popup({ window });
  };
  contents.on('context-menu', show);
  return () => contents.removeListener('context-menu', show);
}

module.exports = { contextMenuTemplate, attachContextMenu };
