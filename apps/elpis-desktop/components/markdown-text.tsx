"use client";

import { createElement, memo, useRef, useState, type HTMLAttributes } from "react";
import { Check, Copy } from "lucide-react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { FileRefLink } from "@/components/file-ref";
import { linkFilePaths, parseHref } from "@/lib/file-refs";

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
  if (!href) return <span>{children}</span>;
  const file = parseHref(href);
  if (file) return <FileRefLink target={file}>{children}</FileRefLink>;
  return <a {...props} href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
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

export const MarkdownText = memo(function MarkdownText({ text }: { text: string }) {
  return <div className="markdown"><Markdown remarkPlugins={PLUGINS} rehypePlugins={HIGHLIGHT} components={components} urlTransform={urlTransform}>{text}</Markdown></div>;
});
