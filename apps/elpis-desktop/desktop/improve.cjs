'use strict';
const { trustedBrowserSender } = require('./browser-policy.cjs');

function regionRect(bounds, viewport) {
  if (!bounds || !['x', 'y', 'width', 'height'].every(key => Number.isFinite(bounds[key]))) throw Error('Choose a visible region');
  const x = Math.max(0, Math.floor(bounds.x)), y = Math.max(0, Math.floor(bounds.y));
  const width = Math.min(Math.ceil(bounds.width), viewport.width - x), height = Math.min(Math.ceil(bounds.height), viewport.height - y);
  if (width < 1 || height < 1 || bounds.width < 1 || bounds.height < 1) throw Error('Choose a visible region');
  return { x, y, width, height };
}
function registerImprove({ host, origin, ipcMain }) {
  const guard = event => { if (!trustedBrowserSender(event, host.webContents, origin)) throw Error('Elpis application frame required'); };
  ipcMain.handle('elpis:improve:capture', async (event, bounds) => {
    guard(event);
    // DOM rectangles are CSS pixels; capturePage takes device-independent window pixels, including zoom.
    const zoom = host.webContents.getZoomFactor();
    const rect = regionRect(Object.fromEntries(Object.entries(bounds ?? {}).map(([key, value]) => [key, value * zoom])), host.getContentBounds());
    return { image: (await host.webContents.capturePage(rect)).toDataURL() };
  });
  return () => ipcMain.removeHandler('elpis:improve:capture');
}
module.exports = { registerImprove, regionRect };
