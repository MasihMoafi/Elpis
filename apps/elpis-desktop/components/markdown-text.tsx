"use client";

import { createElement, useRef, useState, type HTMLAttributes, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { FileRefLink } from "@/components/file-ref";
import { linkFilePaths, parseHref } from "@/lib/file-refs";
import { useHost } from "@/lib/files-pane";

/** Copies text and reports the result next to the button. */
export function CopyButton({ text, label }: { text: () => string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try { await navigator.clipboard.writeText(text()); setState("copied"); }
    catch { setState("failed"); }
    setTimeout(() => setState("idle"), 2000);
  }
  return <>
    <Button variant="ghost" size="icon-xs" aria-label={label} title={label} onClick={copy}>{state === "copied" ? <Check size={14} /> : <Copy size={14} />}</Button>
    <span role="status" className="copy-status">{state === "copied" ? "Copied" : state === "failed" ? "Could not copy. Select the text to copy it." : ""}</span>
  </>;
}

/** A fenced block's language as written after its fence (```ts), from the class Markdown gives its code element. */
function languageOf(node: unknown) {
  const code = (node as { children?: { type: string; properties?: { className?: unknown } }[] } | undefined)?.children?.[0];
  const classes = code?.type === "element" && Array.isArray(code.properties?.className) ? code.properties.className.map(String) : [];
  return classes.find(name => name.startsWith("language-"))?.slice("language-".length);
}

/** A code block: coloured by its language (rehype-highlight), named on its bar, with a button that copies the source. */
function CodeBlock({ language, ...props }: React.ComponentProps<"pre"> & { language?: string }) {
  const ref = useRef<HTMLPreElement>(null);
  return <div className="code-block">
    <div className="code-block-bar">{language && <span className="code-block-language">{language}</span>}<CopyButton label="Copy code" text={() => (ref.current?.innerText ?? "").replace(/\n$/, "")} /></div>
    <pre ref={ref} {...props} />
  </div>;
}

function MarkdownLink({ href, children, ...props }: React.ComponentProps<"a">) {
  const [error, setError] = useState(""), { attached } = useHost();
  if (!href) return <span>{children}</span>;
  // A file the reply names is a file ref where the Files tab can open it (components/file-ref.tsx).
  const file = parseHref(href);
  if (file && attached) return <FileRefLink target={file}>{children}</FileRefLink>;
  const local = href.startsWith("/") && !href.startsWith("//");
  if (file && !local) return <span>{children}</span>;
  async function openFile(event: MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    setError("");
    const open = window.elpisDesktop?.openFile;
    if (!open) { setError("Local files open in the Elpis desktop app."); return; }
    try { await open(href!); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not open this file."); }
  }
  return <>
    <a {...props} href={href} target={local ? undefined : "_blank"} rel="noreferrer noopener" onClick={local ? openFile : props.onClick}>{children}</a>
    {error && <span role="alert" className="ml-2 text-sm text-destructive">{error}</span>}
  </>;
}

const directional = (tag: "p" | "ul" | "ol" | "blockquote" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "th" | "td") =>
  ({ node: _node, ...props }: HTMLAttributes<HTMLElement> & { node?: unknown }) => createElement(tag, { ...props, dir: "auto" });
const components: Components = {
  ...Object.fromEntries((["p", "ul", "ol", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "th", "td"] as const).map(tag => [tag, directional(tag)])),
  pre: ({ node, ...props }) => <CodeBlock language={languageOf(node)} {...props} />,
  table: ({ node: _node, ...props }) => <div className="markdown-table" role="region" aria-label="Scrollable table" tabIndex={0}><table {...props} /></div>,
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
};

/** Only blocks that name their language are coloured: guessing one paints plain text and logs in wrong colours. */
const HIGHLIGHT: NonNullable<React.ComponentProps<typeof Markdown>["rehypePlugins"]> = [[rehypeHighlight, { detect: false }]];

/** file:/// links are kept (they are file refs); everything else is Markdown's own check. */
const urlTransform = (url: string) => url.startsWith("file:///") ? url : defaultUrlTransform(url);
const PLUGINS = [remarkGfm, linkFilePaths];

export function MarkdownText({ text }: { text: string }) {
  return <div className="markdown"><Markdown remarkPlugins={PLUGINS} rehypePlugins={HIGHLIGHT} components={components} urlTransform={urlTransform}>{text}</Markdown></div>;
}
