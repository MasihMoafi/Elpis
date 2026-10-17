// Run before Excalidraw registers its font faces so the editor and PNG exporter work offline.
if (typeof window !== "undefined") Object.assign(window, { EXCALIDRAW_ASSET_PATH: "/love-spot-assets/" });
