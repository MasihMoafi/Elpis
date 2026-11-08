"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { fileAssetUrl } from "@/lib/files-pane";
import { parseHref, resolveRef } from "@/lib/file-refs";
import { WindowedFileEditor } from "@/components/windowed-file-editor";
import { usePreferences } from "@/lib/preferences";
import type { Marks } from "@/components/file-editor";
import type { FileRead } from "@/bridge/files.mts";

/** Large files stay out of the editor and only one bounded slice enters the document. */
export function LargeTextPreview({
  text,
  file,
  pages,
  mtimeMs,
  page: initialPage,
  firstLine,
  marks,
  onSelection,
}: {
  text: string;
  file: { cwd: string; path: string };
  pages: number;
  mtimeMs: number;
  page: number;
  firstLine: number;
  marks: Marks;
  onSelection: (text: string) => void;
}) {
  const [page, setPage] = useState(initialPage);
  const [loaded, setLoaded] = useState({ page: initialPage, firstLine, text, error: "" });
  const { softWrap } = usePreferences();
  const [retry, setRetry] = useState(0);
  const loading = loaded.page !== page && !loaded.error;
  useEffect(() => {
    if (page === initialPage) {
      setLoaded({ page: initialPage, firstLine, text, error: "" });
      return;
    }
    const controller = new AbortController();
    setLoaded(previous => ({ ...previous, error: "" }));
    void api<FileRead>(
      `/file?cwd=${encodeURIComponent(file.cwd)}&path=${encodeURIComponent(file.path)}&page=${page}&mtimeMs=${mtimeMs}`,
      undefined,
      controller.signal,
    )
      .then(result => {
        if (typeof result.content !== "string") throw Error("This page cannot be read as text.");
        if (!controller.signal.aborted)
          setLoaded({ page, firstLine: result.firstLine ?? 1, text: result.content, error: "" });
      })
      .catch(error => {
        if (!controller.signal.aborted) setLoaded(previous => ({ ...previous, error: String(error) }));
      });
    return () => controller.abort();
  }, [page, text, file.cwd, file.path, mtimeMs, retry, initialPage, firstLine]);
  return (
    <>
      <div className="files-bar" role="group" aria-label="Document pages">
        <Button size="xs" variant="ghost" disabled={!page || loading} onClick={() => setPage(page - 1)}>
          Previous page
        </Button>
        <span className="text-xs text-muted-foreground" role="status">
          {loading ? "Reading page…" : `Page ${loaded.page + 1} of ${pages} · Read only`}
        </span>
        <Button size="xs" variant="ghost" disabled={page + 1 >= pages || loading} onClick={() => setPage(page + 1)}>
          Next page
        </Button>
      </div>
      {loaded.error && (
        <div role="alert">
          {loaded.error}{" "}
          <Button size="xs" variant="ghost" onClick={() => setRetry(value => value + 1)}>
            Retry page
          </Button>
        </div>
      )}
      <div role="region" aria-label="Read-only file contents" className="file-view-body">
        <WindowedFileEditor
          key={loaded.page}
          label={`Contents of ${file.path}`}
          value={loaded.text.replace(/\r\n/g, "\n")}
          startLine={loaded.firstLine}
          marks={loaded.page === initialPage ? marks : undefined}
          softWrap={softWrap}
          readOnly
          onSelection={onSelection}
        />
      </div>
    </>
  );
}

const POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";
/** HTML runs in an opaque-origin frame. Only project-local resources are embedded before it starts. */
export function HtmlFilePreview({
  text,
  file,
  label,
  onSelection,
  pages = 1,
  mtimeMs,
}: {
  text: string;
  file: { cwd: string; path: string };
  label: string;
  onSelection?: (text: string) => void;
  pages?: number;
  mtimeMs?: number;
}) {
  const frame = useRef<HTMLIFrameElement>(null),
    loaded = useRef(false);
  const [navigationBlocked, setNavigationBlocked] = useState(false);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source === frame.current?.contentWindow &&
        event.data?.type === "elpis:document-selection" &&
        typeof event.data.text === "string" &&
        event.data.text.trim()
      )
        onSelection?.(event.data.text.slice(0, 24000));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [onSelection]);
  const [preview, setPreview] = useState<{ html: string; warnings: boolean } | null>(null);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setPreview(null);
    loaded.current = false;
    setNavigationBlocked(false);
    const prepare = async () => {
      // Only a displayed HTML preview assembles its document. The Files store retains one source
      // page; navigating away cancels remaining reads and releases the rendered document.
      const parts = [text];
      for (let page = 1; page < pages; page++) {
        const result = await api<{ content?: string }>(
          `/file?cwd=${encodeURIComponent(file.cwd)}&path=${encodeURIComponent(file.path)}&page=${page}&mtimeMs=${mtimeMs}`,
          undefined,
          controller.signal,
        );
        if (typeof result.content !== "string") throw Error("HTML source unavailable");
        parts.push(result.content);
      }
      const template = document.createElement("template");
      template.innerHTML = parts.join("");
      // Template contents stay inert: even images cannot request resources while paths are being checked.
      const doc = template.content;
      const absolute = resolveRef({ path: file.path }, file.cwd).abs,
        folder = absolute.slice(0, absolute.lastIndexOf("/"));
      let warnings = false,
        requests = 0;
      const local = (href: string) => {
        const ref = parseHref(href.replace(/[?#].*$/, ""));
        if (!ref) return null;
        const found = resolveRef({ path: resolveRef(ref, folder).abs }, file.cwd);
        return found.inside ? found.rel : null;
      };
      const resource = async (href: string) => {
        const path = local(href);
        if (!path || ++requests > 32) throw Error("Resource unavailable");
        const result = await api<{ content?: string; size: number }>(
          `/file?cwd=${encodeURIComponent(file.cwd)}&path=${encodeURIComponent(path)}`,
          undefined,
          controller.signal,
        );
        if (typeof result.content !== "string" || result.size > 512 * 1024) throw Error("Resource unavailable");
        return result.content;
      };
      for (const element of doc.querySelectorAll("base,meta[http-equiv],iframe,frame,object,embed")) element.remove();
      for (const element of doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
        try {
          const style = document.createElement("style");
          style.textContent = (await resource(element.getAttribute("href") || "")).replace(/<\/style/gi, "<\\/style");
          element.replaceWith(style);
        } catch {
          warnings = true;
          element.remove();
        }
      }
      for (const element of doc.querySelectorAll<HTMLScriptElement>("script[src]")) {
        try {
          element.textContent = (await resource(element.getAttribute("src") || "")).replace(
            /<\/script/gi,
            "<\\/script",
          );
          element.removeAttribute("src");
          element.removeAttribute("integrity");
        } catch {
          warnings = true;
          element.remove();
        }
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
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
              if (typeof reader.result === "string") resolve(reader.result);
              else reject(new Error("Image unavailable"));
            };
            reader.onerror = () => reject(reader.error ?? new Error("Image unavailable"));
            reader.readAsDataURL(blob);
          });
          element.setAttribute("src", data);
        } catch {
          warnings = true;
          element.removeAttribute("src");
        }
      }
      if (
        [...doc.querySelectorAll("style")].some(style => /@import|url\(/i.test(style.textContent || "")) ||
        [...doc.querySelectorAll('script[type="module"]')].some(script => /\bimport\b/.test(script.textContent || ""))
      )
        warnings = true;
      for (const anchor of doc.querySelectorAll<HTMLAnchorElement>("a[href]"))
        if (!anchor.getAttribute("href")?.startsWith("#")) anchor.removeAttribute("href");
      const selection = document.createElement("script");
      selection.textContent =
        'document.addEventListener("selectionchange",()=>{const text=window.getSelection()?.toString()||"";if(text.trim())parent.postMessage({type:"elpis:document-selection",text:text.slice(0,24000)},"*")})';
      doc.append(selection);
      const policy = document.createElement("meta");
      policy.httpEquiv = "Content-Security-Policy";
      policy.content = POLICY;
      if (!disposed)
        setPreview({
          html: `<!doctype html>\n<html><head>${policy.outerHTML}</head><body>${template.innerHTML}</body></html>`,
          warnings,
        });
    };
    void prepare().catch(() => {
      if (!disposed)
        setPreview({
          html: "<p>This HTML document could not be prepared. Open Source to read it.</p>",
          warnings: true,
        });
    });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [text, file.cwd, file.path, pages, mtimeMs]);
  if (!preview)
    return (
      <p className="files-note" role="status">
        Preparing document…
      </p>
    );
  return (
    <>
      {navigationBlocked && (
        <p className="files-note" role="status">
          Document navigation was blocked. Reopen Preview to restore interactive controls.
        </p>
      )}
      {preview.warnings && (
        <p className="files-note" role="status">
          Some resources are unavailable. Only files inside this project can be loaded.
        </p>
      )}
      <iframe
        key={navigationBlocked ? "static" : "interactive"}
        ref={frame}
        onLoad={() => {
          if (!loaded.current) {
            loaded.current = true;
            return;
          }
          if (!navigationBlocked) {
            loaded.current = false;
            setNavigationBlocked(true);
          }
        }}
        className="file-pdf"
        title={label}
        srcDoc={preview.html}
        name="elpis-file-preview"
        sandbox={navigationBlocked ? "" : "allow-scripts"}
        referrerPolicy="no-referrer"
      />
    </>
  );
}
