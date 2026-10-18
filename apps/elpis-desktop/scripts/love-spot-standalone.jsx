// Love Spot pages protocol. Installed only by sync-love-spot.mjs.
import { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptureUpdateAction, Excalidraw, exportToBlob, restoreElements, serializeAsJSON } from '@excalidraw/excalidraw';
import { MASIH_PEN, lightFiles } from './love-spot';
import { newer } from '../love-spot-order.cjs';
import '@excalidraw/excalidraw/index.css';

const board = window.board;

function App({ data }) {
  const api = useRef(null), saving = useRef(0), viewing = useRef(0), queue = useRef(Promise.resolve());
  const page = useRef(data?.page), revision = useRef(data?.revision), remote = useRef(false);
  const ready = editor => {
    api.current = editor;
    board.onIncoming(incoming => {
      const switching = page.current?.session !== incoming.page?.session;
      page.current = incoming.page; revision.current = incoming.revision;
      remote.current = true;
      try {
        if (switching) {
          clearTimeout(saving.current); clearTimeout(viewing.current);
          editor.resetScene(); editor.addFiles(Object.values(incoming.files || {}));
          editor.updateScene({ elements: restoreElements(incoming.elements || [], null, { refreshDimensions: true, repairBindings: true }),
            appState: { ...(incoming.appState || {}), selectedElementIds: {}, collaborators: new Map() }, captureUpdate: CaptureUpdateAction.NEVER });
          editor.scrollToContent(editor.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.9, maxZoom: 1 });
          if (Object.keys(incoming.files || {}).length) queueMicrotask(() => changed(editor.getSceneElements(), editor.getAppState(), editor.getFiles()));
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
        if (updated) editor.updateScene({ elements: [...shown.values()], captureUpdate: CaptureUpdateAction.NEVER });
        if (screenshot) { editor.updateScene({ appState: { selectedElementIds: { [screenshot.id]: true } } }); editor.scrollToContent(screenshot, { fitToViewport: true, viewportZoomFactor: 0.9 }); }
        if (files.length) queueMicrotask(() => changed(editor.getSceneElements(), editor.getAppState(), editor.getFiles()));
      } finally { remote.current = false; }
    });
  };
  const changed = (elements, appState, files) => {
    if (remote.current) return;
    const drawing = { ...JSON.parse(serializeAsJSON(elements, appState, files, 'local')), elements: api.current?.getSceneElementsIncludingDeleted() || elements, files, page: page.current };
    clearTimeout(saving.current);
    saving.current = setTimeout(() => {
      queue.current = queue.current.catch(() => {}).then(async () => {
        if (drawing.page?.session !== page.current?.session) return;
        const saved = await board.save(JSON.stringify({ ...drawing, files: await lightFiles(drawing.elements, drawing.files) }));
        if (drawing.page?.session === page.current?.session) revision.current = saved.revision;
      }).catch(console.error);
    }, 400);
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
  return <Excalidraw excalidrawAPI={ready} initialData={initial} onChange={changed} />;
}

(async () => {
  const data = JSON.parse(await board.load());
  createRoot(document.getElementById('root')).render(<App data={data} />);
})();
