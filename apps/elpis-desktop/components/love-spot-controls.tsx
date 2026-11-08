"use client";

import type { BoardPage, PageList } from "./love-spot-types.ts";

import { type KeyboardEvent as ReactKeyboardEvent } from "react";

import { Check, ChevronDown, Pin, Trash2 } from "lucide-react";
import { PlusIcon, ModelsIcon } from "@/components/elpis-icons";

import { Button } from "@/components/ui/button";

import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { Dictation } from "@/components/dictation";

import { ModelPicker } from "@/components/model-picker";

import { MatildaSwitch } from "@/components/matilda-switch";
import { MatildaCharacterPicker } from "@/components/matilda-character-picker";

import "@excalidraw/excalidraw/index.css";
import "./love-spot.css";

import type { ComponentProps, RefObject } from "react";
type PageControls = {
  page: BoardPage | undefined;
  pages: PageList["pages"];
  pagesOpen: boolean;
  setPagesOpen(open: boolean): void;
  loadPages(): void;
  pageBusy: boolean;
  editorReady: boolean;
  pagesMenu: RefObject<HTMLDivElement | null>;
  restoringPages: RefObject<boolean>;
  pagesScroll: RefObject<number>;
  stepPage(event: ReactKeyboardEvent<HTMLDivElement> & { preventBaseUIHandler?: () => void }): void;
  setPageName(name: string): void;
  setRenaming(value: boolean): void;
  currentKept: boolean;
  changePage(
    action: "new" | "switch" | "rename" | "delete" | "keep" | "release" | "clear",
    name?: string,
  ): Promise<unknown>;
  setClearing(value: boolean): void;
  reopenPages: RefObject<boolean>;
  setPageToDelete(name: string | undefined): void;
  pagesError: string;
  renaming: boolean;
  pageName: string;
};
type Props = {
  pageControls: PageControls;
  model: ComponentProps<typeof ModelPicker>;
  dictation: ComponentProps<typeof Dictation>;
  replies: ComponentProps<typeof MatildaSwitch>;
  accountsButton: boolean;
  onAccounts(): void;
  replying: boolean;
  saveStatus: string;
};

export function LoveSpotControls({
  pageControls,
  model,
  dictation,
  replies,
  accountsButton,
  onAccounts,
  replying,
  saveStatus,
}: Props) {
  const {
    page,
    pages,
    pagesOpen,
    setPagesOpen,
    loadPages,
    pageBusy,
    editorReady,
    pagesMenu,
    restoringPages,
    pagesScroll,
    stepPage,
    setPageName,
    setRenaming,
    currentKept,
    changePage,
    setClearing,
    reopenPages,
    setPageToDelete,
    pagesError,
    renaming,
    pageName,
  } = pageControls;
  return (
    <div className="navbar love-spot-tools accent-scope">
      <div className="love-spot-pages">
        <DropdownMenu
          open={pagesOpen}
          onOpenChange={open => {
            setPagesOpen(open);
            if (open) loadPages();
          }}
        >
          <DropdownMenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                aria-label="Pages"
                className="max-w-full min-w-20 shrink justify-between"
                disabled={!editorReady || pageBusy}
              />
            }
          >
            <span className="min-w-0 truncate" title={page?.name ?? "Pages"}>
              {page?.name ?? "Pages"}
            </span>
            <ChevronDown aria-hidden="true" size={14} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            ref={pagesMenu}
            onScroll={event => {
              if (pagesOpen && !restoringPages.current) pagesScroll.current = event.currentTarget.scrollTop;
            }}
            onKeyDown={stepPage}
            align="start"
            className="max-h-96 max-w-80 overflow-y-auto"
          >
            <DropdownMenuItem
              onClick={() => {
                setPageName(page?.name ?? "");
                setRenaming(true);
              }}
            >
              Rename page
            </DropdownMenuItem>
            {page && (
              <DropdownMenuItem onClick={() => void changePage(currentKept ? "release" : "keep", page.name)}>
                <Pin aria-hidden="true" fill={currentKept ? "currentColor" : "none"} />
                {currentKept ? "Kept" : "Keep this page"}
              </DropdownMenuItem>
            )}
            {pages.some(item => item.name !== page?.name && !item.kept) && (
              <DropdownMenuItem variant="destructive" onClick={() => setClearing(true)}>
                <Trash2 aria-hidden="true" />
                Delete all pages
              </DropdownMenuItem>
            )}
            {pages.map(item => (
              <DropdownMenuItem
                key={item.name}
                data-page-name={item.name}
                closeOnClick={false}
                onClick={() => void changePage("switch", item.name)}
              >
                <Check aria-hidden="true" className={item.name === page?.name ? "shrink-0" : "invisible shrink-0"} />
                <span className="min-w-0 flex-1">
                  <span className="block whitespace-normal break-words">{item.name}</span>
                  <time
                    className="block text-xs text-muted-foreground"
                    dateTime={new Date(item.modified).toISOString()}
                  >
                    {new Date(item.modified).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                    {item.kept
                      ? ""
                      : item.expires && item.name !== page?.name
                        ? ` · to trash in ${Math.max(1, Math.ceil((item.expires - Date.now()) / 86400000))} d`
                        : ""}
                  </time>
                </span>
                {item.kept && <Pin aria-label="Kept" className="shrink-0" fill="currentColor" />}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Delete page"
                  title={`Delete ${item.name}`}
                  onClick={event => {
                    event.stopPropagation();
                    reopenPages.current = true;
                    setPagesOpen(false);
                    setPageToDelete(item.name);
                  }}
                  onKeyDown={event => event.stopPropagation()}
                >
                  <Trash2 size={14} />
                </Button>
              </DropdownMenuItem>
            ))}
            {pagesError && (
              <DropdownMenuItem disabled className="whitespace-normal text-muted-foreground">
                {pagesError}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="outline"
          size="sm"
          disabled={!editorReady || pageBusy}
          aria-label="New page"
          title="New page"
          onClick={() => void changePage("new")}
        >
          <PlusIcon aria-hidden="true" />
          <span className="love-spot-label">New page</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Delete current page"
          title="Delete current page"
          disabled={!editorReady || pageBusy || !page}
          onClick={() => setPageToDelete(page?.name)}
        >
          <span className="inline-flex flex-row items-center gap-1">
            <Trash2 aria-hidden="true" />
            Delete
          </span>
        </Button>
        {renaming && (
          <form
            className="flex items-center gap-1"
            onSubmit={event => {
              event.preventDefault();
              void changePage("rename", pageName.trim());
            }}
          >
            <Input
              autoFocus
              aria-label="Page name"
              value={pageName}
              maxLength={100}
              className="max-w-48"
              onChange={event => setPageName(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Escape") setRenaming(false);
              }}
            />
            <Button variant="outline" size="sm" type="submit" disabled={pageBusy || !pageName.trim()}>
              Save
            </Button>
            <Button variant="ghost" size="sm" type="button" onClick={() => setRenaming(false)}>
              Cancel
            </Button>
          </form>
        )}
      </div>
      {/* Masih, 23 Oct: "I can't change her model!" It sat inside the ☰ menu's dialog; it belongs on the bar, beside the page. */}
      <div role="group" aria-label="Matilda's model">
        <ModelPicker {...model} />
      </div>
      <div role="group" aria-label="Voice note">
        <Dictation {...dictation} />
      </div>
      <MatildaSwitch {...replies} />
      <MatildaCharacterPicker />
      {accountsButton && (
        <Button
          variant="outline"
          size="sm"
          aria-label="Models & accounts"
          title="Models & accounts"
          className="shrink-0"
          onClick={() => onAccounts()}
        >
          <ModelsIcon aria-hidden="true" />
          <span className="love-spot-label">Models &amp; accounts</span>
        </Button>
      )}
      {replying && (
        <span className="badge badge-sm badge-ghost shrink-0" role="status" aria-label="Matilda status">
          Matilda is writing…
        </span>
      )}
      {saveStatus && (
        <span className="badge badge-sm badge-ghost shrink-0" role="status" aria-label="Drawing save status">
          {saveStatus}
        </span>
      )}
    </div>
  );
}
