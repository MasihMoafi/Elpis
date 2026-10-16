"use client";

import { createElement, useRef, useState, type HTMLAttributes, type MouseEvent } from "react";
import { Check, Copy } from "lucide-react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";

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

function CodeBlock(props: React.ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null);
  return <div className="code-block">
    <div className="code-block-bar"><CopyButton label="Copy code" text={() => ref.current?.innerText ?? ""} /></div>
    <pre ref={ref} {...props} />
  </div>;
}

function MarkdownLink({ href, children, ...props }: React.ComponentProps<"a">) {
  const [error, setError] = useState("");
  if (!href) return <span>{children}</span>;
  const local = href.startsWith("/") && !href.startsWith("//");
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
  pre: ({ node: _node, ...props }) => <CodeBlock {...props} />,
  table: ({ node: _node, ...props }) => <div className="markdown-table" role="region" aria-label="Scrollable table" tabIndex={0}><table {...props} /></div>,
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
};

export function MarkdownText({ text }: { text: string }) {
  return <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} components={components}>{text}</Markdown></div>;
}
