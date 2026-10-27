"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fileAssetUrl } from "@/lib/files-pane";
import { parseHref, resolveRef } from "@/lib/file-refs";
import { selectPaneContent } from "@/lib/pane-select";

const PAGE = 32000;
/** Large files stay out of the editor and only one bounded slice enters the document. */
export function LargeTextPreview({ text }: { text: string }) {
  const [page, setPage] = useState(0), contents = useRef<HTMLPreElement>(null);
  const pages = Math.max(1, Math.ceil(text.length / PAGE)), current = Math.min(page, pages - 1);
  const boundary = (offset: number) => offset > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(offset)) ? offset - 1 : offset;
  useEffect(() => { if (contents.current) contents.current.scrollTop = 0; }, [current]);
  return <>
    <div className="files-bar" role="group" aria-label="Document pages">
      <Button size="xs" variant="ghost" disabled={!current} onClick={() => setPage(current - 1)}>Previous page</Button>
      <span className="text-xs text-muted-foreground" role="status">Page {current + 1} of {pages} · Read only</span>
      <Button size="xs" variant="ghost" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>Next page</Button>
    </div>
    <pre ref={contents} role="region" aria-label="Read-only file contents" tabIndex={0} onKeyDown={selectPaneContent} className="file-markdown whitespace-pre-wrap font-mono">{text.slice(boundary(current * PAGE), boundary(Math.min(text.length, (current + 1) * PAGE)))}</pre>
  </>;
}

const POLICY = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";
/** HTML runs in an opaque-origin frame. Only project-local resources are embedded before it starts. */
export function HtmlFilePreview({ text, file, label, onSelection }: { text: string; file: { cwd: string; path: string }; label: string; onSelection?: (text: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null), loaded = useRef(false);
  const [navigationBlocked, setNavigationBlocked] = useState(false);
  useEffect(() => {
    const receive = (event: MessageEvent) => { if (event.source === frame.current?.contentWindow && event.data?.type === "elpis:document-selection" && typeof event.data.text === "string" && event.data.text.trim()) onSelection?.(event.data.text.slice(0, 24000)); };
    window.addEventListener("message", receive); return () => window.removeEventListener("message", receive);
  }, [onSelection]);
  const [preview, setPreview] = useState<{ html: string; warnings: boolean } | null>(null);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setPreview(null); loaded.current = false; setNavigationBlocked(false);
    const prepare = async () => {
      const template = document.createElement("template"); template.innerHTML = text;
      // Template contents stay inert: even images cannot request resources while paths are being checked.
      const doc = template.content;
      const absolute = resolveRef({ path: file.path }, file.cwd).abs, folder = absolute.slice(0, absolute.lastIndexOf("/"));
      let warnings = false, requests = 0;
      const local = (href: string) => {
        const ref = parseHref(href.replace(/[?#].*$/, ""));
        if (!ref) return null;
        const found = resolveRef({ path: resolveRef(ref, folder).abs }, file.cwd);
        return found.inside ? found.rel : null;
      };
      const resource = async (href: string) => {
        const path = local(href);
        if (!path || ++requests > 32) throw Error("Resource unavailable");
        const result = await api<{ content?: string; size: number }>(`/file?cwd=${encodeURIComponent(file.cwd)}&path=${encodeURIComponent(path)}`, undefined, controller.signal);
        if (typeof result.content !== "string" || result.size > 512 * 1024) throw Error("Resource unavailable");
        return result.content;
      };
      for (const element of doc.querySelectorAll("base,meta[http-equiv],iframe,frame,object,embed")) element.remove();
      for (const element of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
        try { const style = document.createElement("style"); style.textContent = (await resource(element.getAttribute("href") || "")).replace(/<\/style/gi, "<\\/style"); element.replaceWith(style); }
        catch { warnings = true; element.remove(); }
      }
      for (const element of doc.querySelectorAll<HTMLScriptElement>("script[src]")) {
        try { element.textContent = (await resource(element.getAttribute("src") || "")).replace(/<\/script/gi, "<\\/script"); element.removeAttribute("src"); element.removeAttribute("integrity"); }
        catch { warnings = true; element.remove(); }
      }
      for (const element of doc.querySelectorAll<HTMLImageElement>("img")) {
        element.removeAttribute("srcset");
        const src = element.getAttribute("src") || "";
        if (/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(src)) continue;
        const path = local(src);
        try {
          if (!path || ++requests > 32) throw Error("Image unavailable");
          const response = await fetch(fileAssetUrl(file.cwd, path), { signal: controller.signal });
          if (!response.ok) throw Error("Image unavailable");
          const blob = await response.blob();
          const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
          element.setAttribute("src", data);
        } catch { warnings = true; element.removeAttribute("src"); }
      }
      if ([...doc.querySelectorAll("style")].some(style => /@import|url\(/i.test(style.textContent || "")) || [...doc.querySelectorAll('script[type="module"]')].some(script => /\bimport\b/.test(script.textContent || ""))) warnings = true;
      for (const anchor of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) if (!anchor.getAttribute("href")?.startsWith("#")) anchor.removeAttribute("href");
      const selection = document.createElement("script");
      selection.textContent = 'document.addEventListener("selectionchange",()=>{const text=window.getSelection()?.toString()||"";if(text.trim())parent.postMessage({type:"elpis:document-selection",text:text.slice(0,24000)},"*")})';
      doc.append(selection);
      const policy = document.createElement("meta"); policy.httpEquiv = "Content-Security-Policy"; policy.content = POLICY;
      if (!disposed) setPreview({ html: `<!doctype html>\n<html><head>${policy.outerHTML}</head><body>${template.innerHTML}</body></html>`, warnings });
    };
    void prepare().catch(() => { if (!disposed) setPreview({ html: "<p>This HTML document could not be prepared. Open Source to read it.</p>", warnings: true }); });
    return () => { disposed = true; controller.abort(); };
  }, [text, file.cwd, file.path]);
  if (!preview) return <p className="files-note" role="status">Preparing document…</p>;
  return <>{navigationBlocked && <p className="files-note" role="status">Document navigation was blocked. Reopen Preview to restore interactive controls.</p>}{preview.warnings && <p className="files-note" role="status">Some resources are unavailable. Only files inside this project can be loaded.</p>}<iframe key={navigationBlocked ? "static" : "interactive"} ref={frame} onLoad={() => { if (!loaded.current) { loaded.current = true; return; } if (!navigationBlocked) { loaded.current = false; setNavigationBlocked(true); } }} className="file-pdf" title={label} srcDoc={preview.html} name="elpis-file-preview" sandbox={navigationBlocked ? "" : "allow-scripts"} referrerPolicy="no-referrer" /></>;
}
