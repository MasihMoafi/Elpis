// Love Spot pages protocol. Installed only by sync-love-spot.mjs.
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Excalidraw, exportToBlob, restoreElements, serializeAsJSON } from '@excalidraw/excalidraw';
import { applyRemoteScene } from './love-spot-history';
import { MASIH_PEN, lightFiles } from './love-spot';
import { newer } from '../love-spot-order.cjs';
import { createTextJournal, saveWithTextDrafts } from './love-spot-drafts';
import '@excalidraw/excalidraw/index.css';

const board = window.board;

function App({ data }) {
  const [status, setStatus] = useState(''), [error, setError] = useState('');
  const api = useRef(null), saving = useRef(0), viewing = useRef(0), queue = useRef(Promise.resolve());
  const page = useRef(data?.page), revision = useRef(data?.revision), remote = useRef(false);
  const deferred = useRef(null), journal = useRef(null), editing = useRef(false);
  const report = error => { setError(String(error?.message || error)); setStatus('Save failed'); };
  if (!journal.current) journal.current = createTextJournal(report);
  const capture = () => {
    const editor = api.current;
    if (!editor) return;
    const draft = journal.current.capture(editor, page.current);
    const elements = editor.getSceneElementsIncludingDeleted();
    return { ...JSON.parse(serializeAsJSON([], editor.getAppState(), {}, 'local')),
      elements: structuredClone(draft ? elements.map(e => e.id === draft.id ? draft : e) : elements), files: editor.getFiles(), page: page.current };
  };
  const save = (finishEdit = false) => {
    clearTimeout(saving.current);
    const drawing = capture(); if (!drawing) return Promise.resolve(true);
    const protectedIds = journal.current.protectedIds(drawing.elements, drawing.page);
    setStatus('Saving…');
    const work = queue.current.then(async () => {
      const saved = await saveWithTextDrafts(drawing, protectedIds, async outgoing => board.save(JSON.stringify({ ...outgoing, files: await lightFiles(outgoing.elements, outgoing.files) })));
      journal.current.acknowledge(saved.scene.elements, saved.scene.page, finishEdit ? undefined : api.current?.getAppState().editingTextElement?.id);
      if (drawing.page.session === page.current.session) revision.current = saved.revision;
      setError(''); setStatus(JSON.stringify(api.current?.getSceneElementsIncludingDeleted()) === JSON.stringify(drawing.elements) ? 'Saved' : 'Unsaved'); return true;
    }).catch(error => { report(error); return false; });
    queue.current = work.then(() => {}); return work;
  };
  const receive = incoming => {
      const editor = api.current; if (!editor) return;
      if (editor.getAppState().editingTextElement || document.querySelector('textarea.excalidraw-wysiwyg')) { deferred.current = incoming; return; }
      const recovered = journal.current.recover(incoming.elements || [], incoming.page);
      const recovery = JSON.stringify(recovered) !== JSON.stringify(incoming.elements || []);
      incoming = { ...incoming, elements: recovered };
      const switching = page.current?.session !== incoming.page?.session;
      page.current = incoming.page; revision.current = incoming.revision;
      remote.current = true;
      try {
        if (switching) {
          clearTimeout(saving.current); clearTimeout(viewing.current);
          editor.resetScene(); editor.addFiles(Object.values(incoming.files || {}));
          applyRemoteScene(editor, restoreElements(incoming.elements || [], null, { refreshDimensions: true, repairBindings: true }),
            { ...(incoming.appState || {}), selectedElementIds: {}, collaborators: new Map() });
          editor.scrollToContent(editor.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1 });
          if (recovery || Object.keys(incoming.files || {}).length) queueMicrotask(save);
          return;
        }
        const shown = new Map(editor.getSceneElementsIncludingDeleted().map(e => [e.id, e]));
        const screenshot = (incoming.elements || []).find(e => e.type === 'image' && !e.isDeleted && e.id.startsWith('shot-') && !shown.has(e.id));
        const files = Object.values(incoming.files || {}).filter(f => editor.getFiles()[f.id]?.dataURL !== f.dataURL);
        let updated = false;
        for (const element of restoreElements(incoming.elements || [], null, { refreshDimensions: true, repairBindings: true })) {
          const mine = shown.get(element.id);
          if (!mine || newer(element, mine)) { shown.set(element.id, element); updated = true; }
        }
        if (files.length) editor.addFiles(files);
        if (updated) applyRemoteScene(editor, [...shown.values()]);
        if (screenshot) { editor.updateScene({ appState: { selectedElementIds: { [screenshot.id]: true } } }); editor.scrollToContent(screenshot, { fitToViewport: true, viewportZoomFactor: 0.9 }); }
        if (recovery || files.length) queueMicrotask(save);
      } finally { remote.current = false; }
  };
  const ready = editor => {
    if (api.current === editor) return;
    api.current = editor;
    journal.current.acknowledge(data.elements || [], data.page);
    board.onIncoming(receive);
    const elements = journal.current.recover(editor.getSceneElementsIncludingDeleted(), page.current);
    if (JSON.stringify(elements) !== JSON.stringify(editor.getSceneElementsIncludingDeleted())) {
      editor.updateScene({ elements }); queueMicrotask(save);
    }
  };
  useEffect(() => {
    const input = event => { if (event.target.matches?.('textarea.excalidraw-wysiwyg')) capture(); };
    const flush = () => { void save(); };
    const keydown = event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); event.stopImmediatePropagation(); flush(); }
    };
    window.__elpisFlushLoveSpot = () => save(true);
    document.addEventListener('input', input); document.addEventListener('keydown', keydown, true);
    window.addEventListener('blur', flush); window.addEventListener('beforeunload', flush);
    return () => { document.removeEventListener('input', input); document.removeEventListener('keydown', keydown, true); window.removeEventListener('blur', flush); window.removeEventListener('beforeunload', flush); delete window.__elpisFlushLoveSpot; };
  });
  const changed = (elements, appState, files) => {
    if (remote.current) return;
    const active = appState.editingTextElement && api.current?.getSceneElementsIncludingDeleted().find(e => e.id === appState.editingTextElement.id);
    if (active) journal.current.record(active, page.current);
    const ended = editing.current && !active; editing.current = !!active;
    if (!active && deferred.current) { const incoming = deferred.current; deferred.current = null; queueMicrotask(() => receive(incoming)); }
    const drawing = capture(); if (!drawing) return;
    clearTimeout(saving.current);
    saving.current = setTimeout(save, 150);
    if (ended) queueMicrotask(save);
    clearTimeout(viewing.current);
    viewing.current = setTimeout(async () => {
      try {
        await queue.current;
        if (drawing.page?.session !== page.current?.session) return;
        const exportedRevision = revision.current;
        const blob = await exportToBlob({ elements, appState: { ...appState, exportBackground: true }, files,
          mimeType: 'image/png', exportPadding: 24, maxWidthOrHeight: 2400 });
        await board.view(new Uint8Array(await blob.arrayBuffer()), exportedRevision);
      } catch (e) { console.error(e); }
    }, 1500);
  };
  const initial = data && { elements: data.elements || [], files: data.files || {}, scrollToContent: true,
    appState: { ...(data.appState || {}), currentItemStrokeColor: MASIH_PEN, collaborators: new Map() } };
  return <><Excalidraw excalidrawAPI={ready} initialData={initial} onChange={changed} />
    <div className="badge badge-sm badge-ghost" role={error ? 'alert' : 'status'} aria-label="Drawing save status" style={{ position: 'fixed', bottom: 20, right: 100, zIndex: 10, padding: '4px 8px', borderRadius: 6, background: 'var(--color-base-100, Canvas)', color: 'var(--color-base-content, CanvasText)', font: '13px sans-serif' }}>{error || status}</div></>;
}

(async () => {
  const data = JSON.parse(await board.load());
  createRoot(document.getElementById('root')).render(<App data={data} />);
})();
