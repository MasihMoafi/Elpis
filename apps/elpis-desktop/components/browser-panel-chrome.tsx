"use client";

import type { Browser } from "./use-browser";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Ellipsis, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type AttachToChat } from "@/components/browser-annotations";
import type { BrowserTab } from "@/lib/desktop";

/** Find in page (Ctrl+F on a page): Enter for the next match, Shift+Enter for the previous one, Escape closes. */
export function FindBar({ browser }: { browser: Browser }) {
  const { state, command } = browser,
    find = state!.find;
  const [text, setText] = useState(find.text);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [find.focus]);
  const search = (value: string, previous = false) =>
    void command("find", { text: value, ...(previous ? { value: "previous" } : {}) });
  return (
    <div className="browser-find" role="search" aria-label="Find in page">
      <Input
        ref={field}
        aria-label="Find in page"
        placeholder="Find in page…"
        value={text}
        spellCheck={false}
        autoComplete="off"
        onChange={event => {
          setText(event.target.value);
          search(event.target.value);
        }}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            search(text, event.shiftKey);
          } else if (event.key === "Escape") {
            event.preventDefault();
            void command("findClose");
          }
        }}
      />
      <span className="browser-find-count" aria-live="polite">
        {text ? (find.matches ? `${find.active} of ${find.matches}` : "No results") : ""}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Previous match"
        disabled={!find.matches}
        onClick={() => search(text, true)}
      >
        <ChevronUp size={14} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Next match"
        disabled={!find.matches}
        onClick={() => search(text)}
      >
        <ChevronDown size={14} />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label="Close find bar"
        onClick={() => void command("findClose")}
      >
        <X size={16} />
      </Button>
    </div>
  );
}

/** The ChatGPT browser's "…" menu: find, zoom, print, screenshots, developer tools and clearing data. */
export function BrowserOptions({
  browser,
  tab,
  onNotice,
  onAttach,
  imagesAllowed,
}: {
  browser: Browser;
  tab?: BrowserTab;
  onNotice: (text: string) => void;
  onAttach?: AttachToChat;
  imagesAllowed: boolean;
}) {
  const { command } = browser,
    page = !!tab && /^https?:/.test(tab.url);
  async function attachScreenshot() {
    const image = (await command("screenshot", { value: "attach" }))?.result?.image;
    if (!image || !onAttach) {
      onNotice("Unable to capture screenshot");
      return;
    }
    if (
      await onAttach(
        [
          {
            id: crypto.randomUUID(),
            name: "Page screenshot.jpg",
            type: "image",
            mimeType: "image/jpeg",
            dataUrl: image,
          },
        ],
        false,
      )
    )
      onNotice("Screenshot added to your message");
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Browser options"
            title="Browser options"
            disabled={!tab}
          />
        }
      >
        <Ellipsis size={16} />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="browser-options">
        <DropdownMenuItem disabled={!page} onClick={() => void command("findOpen")}>
          Find in page
          <kbd className="kbd-hint" aria-hidden="true">
            Ctrl+F
          </kbd>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!page} onClick={() => void command("print")}>
          Print
          <kbd className="kbd-hint" aria-hidden="true">
            Ctrl+P
          </kbd>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!page} onClick={() => void command("external")}>
          Open in external browser
        </DropdownMenuItem>
        <div role="separator" className="browser-options-separator" />
        <div className="browser-zoom-row" role="group" aria-label="Zoom">
          <span>Zoom</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom out"
            disabled={!page}
            onClick={() => void command("zoom", { value: "out" })}
          >
            −
          </Button>
          <button
            data-slot="zoom-reset"
            type="button"
            className="browser-zoom-value"
            title="Reset zoom"
            disabled={!page}
            onClick={() => void command("zoom", { value: "reset" })}
          >
            {tab?.zoom ?? 100}%
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Zoom in"
            disabled={!page}
            onClick={() => void command("zoom", { value: "in" })}
          >
            +
          </Button>
        </div>
        <div role="separator" className="browser-options-separator" />
        <DropdownMenuItem
          disabled={!page}
          onClick={() =>
            void command("screenshot", { value: "copy" }).then(response =>
              onNotice(response?.result?.copied ? "Screenshot saved to clipboard" : "Unable to capture screenshot"),
            )
          }
        >
          Take a screenshot
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!page || !onAttach || !imagesAllowed} onClick={() => void attachScreenshot()}>
          Add a screenshot to your message
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!page} onClick={() => void command("hardReload")}>
          Force reload
          <kbd className="kbd-hint" aria-hidden="true">
            Ctrl+Shift+R
          </kbd>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!page} onClick={() => void command("devtools")}>
          Developer tools
        </DropdownMenuItem>
        <div role="separator" className="browser-options-separator" />
        <DropdownMenuItem
          onClick={() =>
            void command("clearData", { value: "cookies" }).then(
              response => response && onNotice("Browser cookies cleared"),
            )
          }
        >
          Clear cookies
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() =>
            void command("clearData", { value: "cache" }).then(
              response => response && onNotice("Browser cache cleared"),
            )
          }
        >
          Clear cache
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
