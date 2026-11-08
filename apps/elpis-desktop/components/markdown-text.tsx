"use client";

import { createElement, memo, useMemo, useRef, useState, type HTMLAttributes } from "react";
import { Check, Copy } from "lucide-react";
import Markdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { dollarMath } from "@/lib/dollar-math";
import "katex/dist/katex.min.css";
import { Button } from "@/components/ui/button";
import { FileRefLink } from "@/components/file-ref";
import { linkFilePaths, parseHref, resolveRef } from "@/lib/file-refs";
import { fileAssetUrl, fileScope, useHost } from "@/lib/files-pane";
import { ReplyableImage } from "@/components/image-reply";
import { ExcalidrawDiagram } from "@/components/excalidraw-diagram";
import { markdownPage, type MarkdownPosition } from "@/lib/markdown-page";

/** Copies text and reports the result next to the button. */
export function CopyButton({ text, label }: { text: () => string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text());
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  }
  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        title={label}
        onClick={() => {
          void copy();
        }}
      >
        {state === "copied" ? <Check size={14} /> : <Copy size={14} />}
      </Button>
      <span role="status" className="copy-status">
        {state === "copied" ? "Copied" : state === "failed" ? "Could not copy. Select the text to copy it." : ""}
      </span>
    </>
  );
}

/** A fenced block's language as written after its fence (```ts), from the class Markdown gives its code element. */
function languageOf(node: unknown) {
  const code = (node as { children?: { type: string; properties?: { className?: unknown } }[] } | undefined)
    ?.children?.[0];
  const classes =
    code?.type === "element" && Array.isArray(code.properties?.className) ? code.properties.className.map(String) : [];
  return classes.find(name => name.startsWith("language-"))?.slice("language-".length);
}

/** A code block: coloured by its language (rehype-highlight), named on its bar, with a button that copies the source. */
function CodeBlock({
  language,
  source,
  copyText,
  ...props
}: React.ComponentProps<"pre"> & {
  language?: string | undefined;
  source?: string | undefined;
  copyText?: (() => string | undefined) | undefined;
}) {
  const ref = useRef<HTMLPreElement>(null);
  const diagram = language === "excalidraw";
  return (
    <div className="code-block">
      <div
        className={diagram ? "mb-1 flex items-center justify-end gap-1 text-muted-foreground" : "code-block-bar"}
        role={diagram ? "group" : undefined}
        aria-label={diagram ? "Diagram actions" : undefined}
      >
        {language && <span className="code-block-language">{diagram ? "Diagram" : language}</span>}
        <CopyButton
          label={diagram ? "Copy diagram code" : "Copy code"}
          text={() => copyText?.() ?? source ?? (ref.current?.innerText ?? "").replace(/\n$/, "")}
        />
      </div>
      {diagram ? <ExcalidrawDiagram source={source ?? ""} /> : <pre ref={ref} {...props} />}
    </div>
  );
}

function MarkdownLink({ href, children, ...props }: React.ComponentProps<"a">) {
  if (!href) return <span>{children}</span>;
  const file = parseHref(href);
  if (file) return <FileRefLink target={file}>{children}</FileRefLink>;
  return (
    <a {...props} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function ChatImage({ src, alt }: { src?: string | undefined; alt?: string | undefined }) {
  const { cwd } = useHost();
  const ref = parseHref(src || "");
  const absolute = ref ? resolveRef(ref, cwd).abs : undefined;
  const scope = absolute?.startsWith("/") ? fileScope(cwd, absolute) : null;
  const url = scope ? fileAssetUrl(scope.cwd, scope.path) : ref ? undefined : src;
  const [failed, setFailed] = useState<string | null>(null);
  if (!url || failed === url)
    return <span className="text-muted-foreground">{alt || "Image"} (image unavailable)</span>;
  return (
    <ReplyableImage src={url} name={alt || "Image"}>
      <img src={url} alt={alt || ""} loading="lazy" onError={() => setFailed(url)} />
    </ReplyableImage>
  );
}

const directional =
  (tag: "p" | "ul" | "ol" | "blockquote" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "th" | "td") =>
  ({ node: _node, ...props }: HTMLAttributes<HTMLElement> & { node?: unknown }) =>
    createElement(tag, { ...props, dir: "auto" });
function codeText(node: unknown): string {
  if (!node || typeof node !== "object") return "";
  if ("value" in node && typeof node.value === "string") return node.value;
  return "children" in node && Array.isArray(node.children) ? node.children.map(codeText).join("") : "";
}
const components: Components = {
  ...Object.fromEntries(
    (["p", "ul", "ol", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6", "th", "td"] as const).map(tag => [
      tag,
      directional(tag),
    ]),
  ),
  pre: ({ node, ...props }) => (
    <CodeBlock
      language={languageOf(node)}
      source={languageOf(node) === "excalidraw" ? codeText(node) : undefined}
      {...props}
    />
  ),
  table: ({ node: _node, ...props }) => (
    <div className="markdown-table" role="region" aria-label="Scrollable table" tabIndex={0}>
      <table {...props} />
    </div>
  ),
  a: ({ node: _node, ...props }) => <MarkdownLink {...props} />,
  img: ({ src, alt }) => <ChatImage src={typeof src === "string" ? src : undefined} alt={alt} />,
};

/** Only blocks that name their language are coloured: guessing one paints plain text and logs in wrong colours. */
/** Math renders with KaTeX, as in the ChatGPT app; a formula still being typed shows its source instead of failing. */
const HIGHLIGHT: NonNullable<React.ComponentProps<typeof Markdown>["rehypePlugins"]> = [
  [rehypeKatex, { throwOnError: false, strict: false }],
  [rehypeHighlight, { detect: false }],
];

/** file:/// links are kept (they are file refs); everything else is Markdown's own check. */
const urlTransform = (url: string) => (url.startsWith("file:///") ? url : defaultUrlTransform(url));
const PLUGINS = [remarkGfm, remarkMath, linkFilePaths];
const noImage = ({ alt }: React.ComponentProps<"img">) => (alt ? <span>{alt}</span> : null);

type MarkdownProps = { text: string; file?: { cwd: string; path: string }; allowImages?: boolean };
function MarkdownBody({
  text,
  file,
  allowImages = true,
  copyCode,
}: MarkdownProps & { copyCode?: ((rendered: string, offset: number) => string | undefined) | undefined }) {
  const source = useMemo(() => dollarMath(text), [text]);
  const rendered = useMemo<Components>(() => {
    let base: Components = allowImages ? components : { ...components, img: noImage };
    if (copyCode)
      base = {
        ...base,
        pre: ({ node, ...props }) => (
          <CodeBlock
            language={languageOf(node)}
            source={languageOf(node) === "excalidraw" ? codeText(node) : undefined}
            copyText={() => copyCode(source, node?.position?.start.offset ?? -1)}
            {...props}
          />
        ),
      };
    if (!file) return base;
    const abs = resolveRef({ path: file.path }, file.cwd).abs,
      folder = abs.slice(0, abs.lastIndexOf("/")) || "/";
    return {
      ...base,
      a: ({ node: _node, href, children, ...props }) => {
        const target = href ? parseHref(href) : null;
        if (target)
          return <FileRefLink target={{ ...target, path: resolveRef(target, folder).abs }}>{children}</FileRefLink>;
        return (
          <MarkdownLink {...props} href={href}>
            {children}
          </MarkdownLink>
        );
      },
      img: !allowImages
        ? noImage
        : ({ src, alt }) => {
            const target = typeof src === "string" ? parseHref(src) : null;
            const found = target ? resolveRef({ path: resolveRef(target, folder).abs }, file.cwd) : null;
            // Documents cannot silently fetch remote resources or files outside the folder the tab was opened in.
            return found?.inside ? (
              <img src={fileAssetUrl(file.cwd, found.rel)} alt={alt ?? ""} loading="lazy" />
            ) : (
              <span className="file-image-unavailable">{alt || "Image"} (image unavailable)</span>
            );
          },
    };
  }, [file?.cwd, file?.path, allowImages, copyCode, source]);
  return (
    <div className="markdown">
      <Markdown remarkPlugins={PLUGINS} rehypePlugins={HIGHLIGHT} components={rendered} urlTransform={urlTransform}>
        {source}
      </Markdown>
    </div>
  );
}

function LongMarkdown(props: MarkdownProps) {
  const [parts, setParts] = useState<MarkdownPosition[]>([{ start: 0, fence: null }]);
  const host = useRef<HTMLDivElement>(null);
  const page = markdownPage(props.text, parts.at(-1)!);
  const move = (next: boolean) => {
    setParts(previous =>
      next && page.next ? [...previous, page.next] : previous.slice(0, Math.max(1, previous.length - 1)),
    );
    requestAnimationFrame(() => host.current?.scrollIntoView({ block: "start" }));
  };
  return (
    <div ref={host}>
      <MarkdownBody {...props} text={page.source} copyCode={page.codeSource} />
      <nav className="join my-2" aria-label="Message parts">
        <Button variant="ghost" size="sm" disabled={parts.length === 1} onClick={() => move(false)}>
          Previous part
        </Button>
        <span className="px-2 py-1 text-muted-foreground">Part {parts.length}</span>
        <Button variant="ghost" size="sm" disabled={!page.next} onClick={() => move(true)}>
          Next part
        </Button>
      </nav>
    </div>
  );
}

export const MarkdownText = memo(function MarkdownText(props: MarkdownProps) {
  return props.text.length > 32000 ? (
    <LongMarkdown key={props.text.slice(0, 64)} {...props} />
  ) : (
    <MarkdownBody {...props} />
  );
});
