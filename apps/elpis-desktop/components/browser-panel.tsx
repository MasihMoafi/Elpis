"use client";

import { FindBar, BrowserOptions } from "./browser-panel-chrome";
import { BrowserDrawing, measure } from "./use-browser";
import type { Browser } from "./use-browser";
export { useBrowser, browserTabActions } from "./use-browser";
export type { Browser } from "./use-browser";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import "@/components/browser-panel.css";
import { ExternalLink, ArrowLeft, ArrowRight, RefreshCw, PenLine, SquareDashedMousePointer, CircleAlert } from "lucide-react";
import { StopIcon } from "@/components/elpis-icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { AnnotationDock, type AttachToChat } from "@/components/browser-annotations";
import { DevServerPreview } from "@/components/dev-server-preview";
import { heldDrawing, holdDrawing, type DrawingDraft } from "@/lib/browser-drawing-store";

import { errorText } from "@/lib/error-text.mts";

/** The page area of the side panel: address bar and the native page view placed over the viewport. `covered` hides the
 * page while something else is on top of it; `onAttach` gives annotations and screenshots to the chat's composer;
 * `imagesAllowed` is false for text-only models. */
export function BrowserPanel({
  browser,
  covered,
  onAttach,
  imagesAllowed = true,
  cwd = "",
  onReturnToChat,
}: {
  browser: Browser;
  covered: boolean;
  onAttach?: AttachToChat;
  imagesAllowed?: boolean;
  cwd?: string;
  onReturnToChat?: () => void;
}) {
  const { api, state, command } = browser;
  const [notice, setNotice] = useState("");
  const [edit, setEdit] = useState<{ tab: string; value: string } | null>(null);
  const [modal, setModal] = useState(false);
  const [drawing, setDrawing] = useState<DrawingDraft | null>(null);
  const [held, setHeld] = useState(() => !!heldDrawing());
  const [drawFailure, setDrawFailure] = useState("");
  const [capturing, setCapturing] = useState(false);
  const drawButton = useRef<HTMLButtonElement>(null);
  const viewport = useRef<HTMLDivElement>(null),
    address = useRef<HTMLInputElement>(null);
  const active = state?.tabs.find(tab => tab.id === state.activeId);
  useEffect(() => {
    const refresh = () =>
      setModal(
        [
          ...document.querySelectorAll(
            '[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"],[data-slot="popover-content"],[data-slot="combobox-content"]',
          ),
        ].some(element => element.getClientRects().length > 0),
      );
    const observer = new MutationObserver(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
    refresh();
    return () => observer.disconnect();
  }, []);
  const layout = useCallback(() => {
    const element = viewport.current;
    if (!api || !element) return;
    const rect = element.getBoundingClientRect();
    // A failed page shows Elpis's explanation instead of Chromium's empty error page.
    api.layout({
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      obscured: covered || modal || !state?.visible || !!active?.failure,
    });
  }, [api, covered, modal, state?.visible, state?.presentation, active?.failure]);
  useEffect(() => {
    if (!state?.visible || !viewport.current) return;
    const observer = new ResizeObserver(layout);
    observer.observe(viewport.current);
    window.addEventListener("resize", layout);
    layout();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", layout);
      api?.layout({ bounds: { x: 0, y: 0, width: 0, height: 0 }, obscured: true });
    };
  }, [api, layout, state?.visible]);
  useEffect(() => {
    if (state?.visible && state.focusAddress) {
      address.current?.focus();
      address.current?.select();
    }
  }, [state?.focusAddress, state?.visible]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 2600);
    return () => clearTimeout(timer);
  }, [notice]);
  // The page is captured before the drawing hides it; a failed capture leaves the page as it was and can be retried.
  async function startDrawing() {
    if (!api || !active || capturing) return;
    const unsent = heldDrawing();
    if (unsent) {
      setDrawing(unsent);
      return;
    }
    setCapturing(true);
    setDrawFailure("");
    try {
      const image = (await api.command("screenshot", { value: "attach" })).result?.image;
      if (!image) throw Error("The page could not be captured.");
      setDrawing({ shot: image, url: active.url, title: active.title, ...(await measure(image)) });
    } catch (e) {
      setDrawFailure(errorText(e));
    } finally {
      setCapturing(false);
    }
  }
  const drawingBlocked = !onAttach
    ? "Drawing needs a chat to add to"
    : !imagesAllowed
      ? "This model does not accept images"
      : "";
  if (!api || !state?.visible) return null;
  const value = edit && edit.tab === active?.id ? edit.value : active?.url === "about:blank" ? "" : (active?.url ?? "");
  return (
    <section className="browser-panel" aria-label="Built-in browser">
      <form
        className="browser-toolbar"
        aria-label="Browser navigation"
        onSubmit={event => {
          event.preventDefault();
          const submitted = value;
          if (!submitted.trim()) return;
          void api
            .command("navigate", { url: submitted })
            .then(() => setEdit(current => (current?.value === submitted ? null : current)))
            .catch(() => {});
        }}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          disabled={!active?.canGoBack}
          onClick={() => void command("back")}
        >
          <ArrowLeft size={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Forward"
          disabled={!active?.canGoForward}
          onClick={() => void command("forward")}
        >
          <ArrowRight size={16} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={active?.loading ? "Stop loading page" : "Reload page"}
          onClick={() => void command(active?.loading ? "stop" : "reload")}
        >
          {active?.loading ? <StopIcon size={16} /> : <RefreshCw size={16} />}
        </Button>
        <div className="browser-address">
          {active?.security === "insecure" && (
            <span className="browser-security" title="This site does not use a secure connection">
              <CircleAlert size={12} aria-hidden="true" />
              <span className="browser-security-text">Not secure</span>
            </span>
          )}
          <Input
            ref={address}
            aria-label="Search or enter a URL"
            placeholder="Search or enter a URL"
            value={value}
            onChange={e => active && setEdit({ tab: active.id, value: e.target.value })}
            onKeyDown={e => {
              if (e.key === "Escape") {
                setEdit(null);
                address.current?.blur();
              }
            }}
            spellCheck={false}
            autoComplete="off"
          />
          {active && active.zoom !== 100 && (
            <button
              data-slot="zoom-reset"
              type="button"
              className="browser-zoom"
              title="Reset zoom to 100%"
              onClick={() => void command("zoom", { value: "reset" })}
            >
              {active.zoom}%
            </button>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="browser-annotate"
          aria-pressed={state.annotating}
          aria-label="Annotate this page"
          title="Annotate: point at items to ask about or change"
          disabled={!active || !/^https?:/.test(active.url)}
          onClick={() => void command("annotate")}
        >
          <SquareDashedMousePointer size={16} aria-hidden="true" />
          <span className="browser-annotate-label">Annotate</span>
          {!state.annotating && !!active?.comments && (
            <span className="browser-badge" aria-label={`${active.comments} pending`}>
              {active.comments}
            </span>
          )}
        </Button>
        <Button
          ref={drawButton}
          type="button"
          variant="ghost"
          size="sm"
          className="browser-annotate"
          aria-label="Draw on this page"
          title={drawingBlocked || "Draw on this page: arrows, pen, shapes and text over a screenshot"}
          disabled={!active || !/^https?:/.test(active.url) || !!drawingBlocked || capturing}
          onClick={() => void startDrawing()}
        >
          <PenLine size={16} aria-hidden="true" />
          <span className="browser-annotate-label">Draw</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="browser-external"
          aria-label="Open in external browser"
          title="Open in external browser"
          disabled={!active || active.url === "about:blank"}
          onClick={() => void command("external")}
        >
          <ExternalLink size={16} />
        </Button>
        <BrowserOptions
          browser={browser}
          {...(active === undefined ? {} : { tab: active })}
          onNotice={setNotice}
          {...(onAttach ? { onAttach } : {})}
          imagesAllowed={imagesAllowed}
        />
      </form>
      <DevServerPreview key={cwd} cwd={cwd} browser={browser} />
      {state.agent && (!state.agent.enabled || state.agent.tabId) && (
        <div
          role="status"
          className="alert flex shrink-0 items-center justify-between gap-3 border-b border-border bg-muted px-3 py-2 text-sm text-foreground"
        >
          <span>
            {!state.agent.enabled
              ? "You have control. Agent browser access is paused."
              : state.agent.tabId === active?.id
                ? "Agent is using this tab"
                : `Agent is using ${state.tabs.find(tab => tab.id === state.agent?.tabId)?.title ?? "a browser tab"}`}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="btn btn-sm btn-ghost shrink-0"
            onClick={() => void command(state.agent?.enabled ? "agentStop" : "agentAllow")}
          >
            {state.agent.enabled ? "Take over" : "Allow agent control"}
          </Button>
        </div>
      )}
      {state.find.open && active && <FindBar browser={browser} />}
      {(browser.error || (active?.error && !active.failure)) && (
        <div role="alert" className="browser-error">
          {browser.error || active?.error}
        </div>
      )}
      {notice && (
        <div role="status" className="browser-notice">
          {notice}
        </div>
      )}
      {drawFailure && (
        <div role="alert" className="browser-error flex items-center justify-between gap-3">
          <span>Drawing could not start: {drawFailure}</span>
          <span className="flex shrink-0 gap-1">
            <Button type="button" variant="outline" size="xs" onClick={() => void startDrawing()}>
              Retry
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={() => setDrawFailure("")}>
              Dismiss
            </Button>
          </span>
        </div>
      )}
      {held && !drawing && (
        <div role="status" className="browser-notice flex items-center justify-between gap-3">
          <span>A drawing is waiting to be added to your message.</span>
          <span className="flex shrink-0 gap-1">
            <Button type="button" variant="outline" size="xs" onClick={() => void startDrawing()}>
              Resume
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                holdDrawing(null);
                setHeld(false);
              }}
            >
              Discard
            </Button>
          </span>
        </div>
      )}
      {active?.url === "about:blank" && (
        <p className="browser-empty">
          Search or enter a web address.<span>Ctrl+L focuses the address</span>
        </p>
      )}
      <div ref={viewport} className="browser-viewport" id="browser-viewport" role="tabpanel">
        {active?.failure && (
          <div className="browser-failure" role="alert">
            <h2>{active.failure.heading}</h2>
            <p>{active.failure.summary}</p>
            <p className="browser-failure-try">Try:</p>
            <ul>
              {active.failure.tips.map(tip => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
            <code>{active.failure.code}</code>
            <Button type="button" size="sm" onClick={() => void command("reload")}>
              Reload
            </Button>
          </div>
        )}
      </div>
      <AnnotationDock browser={browser} {...(onAttach ? { onAttach } : {})} imagesAllowed={imagesAllowed} />
      {drawing && onAttach && (
        <Suspense
          fallback={
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Draw on the page"
              className="absolute inset-0 z-10 grid place-items-center bg-background text-sm text-muted-foreground"
            >
              <p role="status">Opening the drawing tools…</p>
            </div>
          }
        >
          <BrowserDrawing
            draft={drawing}
            dark={document.documentElement.classList.contains("dark")}
            onAttach={onAttach}
            onChat={() => {
              setDrawing(null);
              setHeld(!!heldDrawing());
              onReturnToChat?.();
              requestAnimationFrame(() =>
                document.querySelector<HTMLTextAreaElement>('[aria-label="Message Elpis"]')?.focus(),
              );
            }}
            onClose={() => {
              setDrawing(null);
              setHeld(!!heldDrawing());
              requestAnimationFrame(() => drawButton.current?.focus());
            }}
            onAdded={() => {
              setDrawing(null);
              setHeld(false);
              setNotice("Drawing added to your message");
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
