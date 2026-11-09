"use client";
import { screenshotDrag, standaloneApp } from "./love-board-shared";
import type { LoveSpotProps } from "./love-board-shared";
import { useLoveBoardPages } from "./love-board-pages";
import { useLoveBoardMatilda } from "./love-board-matilda";
import { LoveSpotControls } from "./love-spot-controls";

import "@/lib/love-spot-assets";

import { createPortal } from "react-dom";
import { Heart, ImagePlus, X } from "lucide-react";
import { ModelsIcon } from "@/components/elpis-icons";
import { ProvidersSettings } from "@/components/providers-settings";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";

import type { AppState, PointerDownState } from "@excalidraw/excalidraw/types";
import { Button } from "@/components/ui/button";

import { ReadAloud, useReadAloud } from "@/components/read-aloud";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ConfirmDelete } from "@/components/confirm-delete";

import { MatildaWho } from "@/components/love-spot-matilda";

import { keepModel } from "@/lib/matilda";

import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";

import "@excalidraw/excalidraw/index.css";
import "./love-spot.css";
export default function LoveSpot(props: LoveSpotProps) {
  // Inside Elpis the app provides her voice, so it outlives the board; the standalone Love Spot brings its own.
  const app = useReadAloud();
  if (app) return <LoveSpotBoard {...props} />;
  return (
    <ReadAloud
      threadId="love-spot"
      enabled
      available={LOVE_SPOT_AUDIO.readAloudAvailable}
      {...(LOVE_SPOT_AUDIO.available ? {} : { unavailableReason: LOVE_SPOT_AUDIO.reason })}
    >
      <LoveSpotBoard {...props} />
    </ReadAloud>
  );
}

function LoveSpotBoard(props: Parameters<typeof useLoveBoardPages>[0]) {
  const {
    pages,
    page,
    pagesOpen,
    setPagesOpen,
    loadPages,
    pageBusy,
    editor,
    pagesMenu,
    restoringPages,
    pagesScroll,
    stepPage,
    setPageName,
    setRenaming,
    changePage,
    setClearing,
    reopenPages,
    setPageToDelete,
    pagesError,
    renaming,
    pageName,
    choices,
    models,
    shared,
    pick,
    settings,
    setAccountsOpen,
    reloadAccounts,
    setPick,
    report,
    provider,
    insertion,
    addVoiceNote,
    chooseReplies,
    toolbarHost,
    matilda,
    saveStatus,
    pageToDelete,
    clearing,
    screenshots,
    choosing,
    placeAllScreenshots,
    chooseScreenshot,
    whoOpen,
    setWhoOpen,
    accountsOpen,
    accountRefresh,
    error,
    save,
    setAttempt,
    styleClassName,
    boardArea,
    styleToggle,
    initial,
    ready,
    changed,
    lastPoint,
    dark,
  } = useLoveBoardMatilda(useLoveBoardPages(props));
  // Pages not kept go to the system trash after a week untouched (bridge/love-spot-store.cts, "Page lifecycle").
  const currentKept = !!pages.find(item => item.name === page?.name)?.kept;
  const tools = (
    <LoveSpotControls
      pageControls={{
        page,
        pages,
        pagesOpen,
        setPagesOpen,
        loadPages,
        pageBusy,
        editorReady: !!editor,
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
      }}
      model={{
        choices,
        models,
        model: shared.settings?.model || pick.model || settings?.main.model || "",
        choiceId: pick.choiceId,
        disabled: !choices.length,
        allowCustom: false,
        onConfigure: () => setAccountsOpen(true),
        onKeySaved: () => void reloadAccounts(),
        onChange: value => {
          setPick(value);
          keepModel(value);
          void shared
            .update({
              model: value.model,
              provider: choices.find(choice => choice.id === value.choiceId)?.provider ?? null,
            })
            .catch(report);
        },
      }}
      dictation={{
        provider,
        disabled: !editor || !settings,
        onBusy: () => {},
        selection: insertion,
        onTranscript: addVoiceNote,
        purpose: "Adds a note to the board.",
      }}
      replies={{ settings: shared.settings, onChange: chooseReplies }}
      accountsButton={!toolbarHost}
      onAccounts={() => setAccountsOpen(true)}
      replying={matilda.replying}
      saveStatus={saveStatus}
    />
  );
  return (
    <section className="love-spot accent-scope" aria-label="Love Spot">
      {toolbarHost ? createPortal(tools, toolbarHost) : tools}
      <ConfirmDelete
        request={pageToDelete ?? null}
        names={pageToDelete ? [pageToDelete] : []}
        noun="page"
        description="This page moves to Trash. Deleting the current page opens a blank page so you can keep drawing."
        onDelete={name => changePage("delete", name)}
        onClose={() => {
          setPageToDelete(undefined);
          if (reopenPages.current) {
            reopenPages.current = false;
            setPagesOpen(true);
          }
        }}
      />
      <AlertDialog open={clearing} onOpenChange={setClearing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all pages?</AlertDialogTitle>
            <AlertDialogDescription>
              Every page except this one and the ones you keep moves to Trash, where you can restore it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              type="button"
              variant="destructive"
              disabled={pageBusy}
              onClick={() => {
                setClearing(false);
                void changePage("clear");
              }}
            >
              Delete all pages
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {screenshots.length > 0 && (
        <section className="love-spot-screenshots" aria-label="New screenshots">
          <div className="love-spot-screenshots-heading">
            <strong>New screenshots</strong>
            <span>Only shared when you add them. Click or drag onto the drawing.</span>
            {screenshots.length > 1 && (
              <Button variant="outline" size="sm" disabled={choosing} onClick={() => void placeAllScreenshots()}>
                <ImagePlus aria-hidden="true" />
                Add all
              </Button>
            )}
          </div>
          <ul className="love-spot-screenshots-list">
            {screenshots.map(shot => (
              <li key={shot.id}>
                <Button
                  variant="outline"
                  className="love-spot-screenshot"
                  aria-label={`Add ${shot.name} to drawing`}
                  title={`Add ${shot.name} to drawing`}
                  disabled={choosing}
                  draggable
                  onDragStart={event => {
                    event.dataTransfer.setData(screenshotDrag, shot.id);
                    event.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => void chooseScreenshot(shot.id, "place")}
                >
                  {/* Private previews stay outside Excalidraw and its exported scene. */}
                  <img src={shot.dataURL} alt="" draggable={false} />
                  <span>{shot.name}</span>
                </Button>
                <Button
                  variant="outline"
                  size="icon-xs"
                  className="love-spot-screenshot-dismiss"
                  aria-label={`Dismiss ${shot.name}`}
                  title={`Dismiss ${shot.name}`}
                  disabled={choosing}
                  onClick={() => void chooseScreenshot(shot.id, "dismiss")}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <MatildaWho
        open={whoOpen}
        onOpenChange={setWhoOpen}
        persona={matilda.persona}
        onSave={persona => matilda.keep(persona)}
      />
      {accountsOpen && (
        <AlertDialog open={accountsOpen} onOpenChange={setAccountsOpen}>
          <AlertDialogContent
            role="dialog"
            aria-label="Models & accounts"
            className="flex max-h-[85vh] max-w-2xl flex-col overflow-hidden"
          >
            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              {/* Settings already frames it as a page; here the dialog does (5 Nov: the class on the component nested two pages in Settings). */}
              <div className="settings-page">
                <ProvidersSettings refreshKey={accountRefresh} onChanged={reloadAccounts} standalone={standaloneApp} />
              </div>
            </div>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button type="button" variant="outline" />}>Done</AlertDialogClose>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {error && (
        <div className="love-spot-status" role="alert">
          {error}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (editor) void save();
              else setAttempt(a => a + 1);
            }}
          >
            Retry
          </Button>
        </div>
      )}
      <div className="love-spot-content">
        <div
          className={`love-spot-editor ${styleClassName}`}
          ref={boardArea}
          onDragOverCapture={event => {
            if (event.dataTransfer.types.includes(screenshotDrag)) {
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "copy";
            }
          }}
          onDropCapture={event => {
            const id = event.dataTransfer.getData(screenshotDrag);
            if (id) {
              event.preventDefault();
              event.stopPropagation();
              void chooseScreenshot(id, "place");
            }
          }}
        >
          {styleToggle}
          {initial ? (
            <Excalidraw
              initialData={initial}
              excalidrawAPI={ready}
              onChange={changed}
              onPointerDown={(_tool: AppState["activeTool"], state: PointerDownState) => {
                lastPoint.current = state.origin;
              }}
              theme={dark ? "dark" : "light"}
            >
              {/* Excalidraw's own menu without its links to GitHub, X and Discord and without live collaboration. */}
              <MainMenu>
                <MainMenu.DefaultItems.LoadScene />
                <MainMenu.DefaultItems.SaveToActiveFile />
                <MainMenu.DefaultItems.Export />
                <MainMenu.DefaultItems.SaveAsImage />
                <MainMenu.DefaultItems.CommandPalette className="highlighted" />
                <MainMenu.DefaultItems.SearchMenu />
                <MainMenu.DefaultItems.Help />
                <MainMenu.DefaultItems.ClearCanvas />
                <MainMenu.Separator />
                <MainMenu.Item icon={<Heart size={16} aria-hidden="true" />} onSelect={() => setWhoOpen(true)}>
                  Who Matilda is…
                </MainMenu.Item>
                <MainMenu.Item
                  icon={<ModelsIcon size={16} aria-hidden="true" />}
                  onSelect={() => setAccountsOpen(true)}
                >
                  Models &amp; accounts…
                </MainMenu.Item>
                <MainMenu.DefaultItems.ToggleTheme />
                <MainMenu.DefaultItems.ChangeCanvasBackground />
              </MainMenu>
            </Excalidraw>
          ) : (
            !error && <p role="status">Opening Love Spot…</p>
          )}
        </div>
      </div>
    </section>
  );
}
