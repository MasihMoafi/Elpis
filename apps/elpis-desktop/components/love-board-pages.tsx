"use client";

import type { LoveSpotProps } from "./love-board-shared";
import { useLoveSpotPersistence } from "./use-love-spot-persistence";
import type { BoardPage, PageList, Screenshot } from "./love-spot-types.ts";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useReadAloud } from "@/components/read-aloud";
import { useDrawingStyle } from "@/components/drawing-style";
import { api, unreadable, type ProviderSettings } from "@/lib/api";
import { refreshModelCatalog, useModelCatalog } from "@/lib/model-catalog";
import { savedModel } from "@/lib/matilda";
import { LOVE_SPOT_AUDIO } from "@/lib/love-spot-audio";
import { errorText } from "@/lib/error-text.mts";
import type { MatildaVoice } from "./love-board-shared";

export function useLoveBoardPages({ dark, toolbarHost }: LoveSpotProps) {
  const speech = useReadAloud();
  const voiceEnabled = useRef(false);
  const voiceVersion = useRef(0);
  const calling = false;
  // no voice call with her any more (1 Nov)
  const [attempt, setAttempt] = useState(0);
  const [editor, setEditor] = useState<ExcalidrawImperativeAPI>();
  const { notice: noticeStyle, toggle: styleToggle, className: styleClassName } = useDrawingStyle(editor);
  const editorRef = useRef<ExcalidrawImperativeAPI | undefined>(undefined);
  const ready = useCallback((value: ExcalidrawImperativeAPI) => {
    editorRef.current = value;
    setEditor(value);
  }, []);
  const [settings, setSettings] = useState<ProviderSettings | null>(null),
    [whoOpen, setWhoOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false),
    [accountRefresh, setAccountRefresh] = useState(0);
  const { models } = useModelCatalog(),
    [pick, setPick] = useState(savedModel);
  const [screenshots, setScreenshots] = useState<Screenshot[]>([]),
    [choosing, setChoosing] = useState(false);
  const [page, setPage] = useState<BoardPage>(),
    [pages, setPages] = useState<PageList["pages"]>([]),
    [pagesError, setPagesError] = useState("");
  const [pageToDelete, setPageToDelete] = useState<string>(),
    [clearing, setClearing] = useState(false),
    [pagesOpen, setPagesOpen] = useState(false);
  const [pageBusy, setPageBusy] = useState(false),
    [renaming, setRenaming] = useState(false),
    [pageName, setPageName] = useState("");
  const pagesScroll = useRef(0),
    reopenPages = useRef(false),
    queuedPage = useRef<string>(undefined);
  const pagesMenu = useRef<HTMLDivElement>(null);
  // The page list opens where it was left, with the page shown in view (Masih, 5 Nov: "it should remember my position w.r.t. the
  // scroll (so if I'm in the middle, I wouldn't have to scroll again only to find the next note)").
  // Each time the list opens it has no height for a frame or two, and restoring then would land at the top; the scrolling
  // done by the restore itself is not recorded. The shown page's row takes focus, so Up and Down step from it.
  const restoringPages = useRef(false);
  useEffect(() => {
    if (!pagesOpen) return;
    restoringPages.current = true;
    let frames = 0,
      frame = 0;
    const restore = () => {
      const node = pagesMenu.current;
      if ((!node || node.scrollHeight <= node.clientHeight) && frames++ < 30) {
        frame = requestAnimationFrame(restore);
        return;
      }
      if (node) {
        node.scrollTop = pagesScroll.current;
        const row = [...node.querySelectorAll<HTMLElement>("[data-page-name]")].find(
          item => item.dataset.pageName === currentPage.current?.name,
        );
        row?.scrollIntoView({ block: "nearest" });
        row?.focus({ preventScroll: true });
        pagesScroll.current = node.scrollTop;
      }
      restoringPages.current = false;
    };
    frame = requestAnimationFrame(restore);
    return () => {
      cancelAnimationFrame(frame);
      restoringPages.current = false;
    };
  }, [pagesOpen]);
  const lastPoint = useRef<{ x: number; y: number }>(undefined);
  const boardArea = useRef<HTMLDivElement>(null);
  const placingAll = useRef(false);
  const onPage = useCallback((value: BoardPage) => {
    setPage(value);
    loadPages();
  }, []);
  const {
    initial,
    error,
    setError,
    saveStatus,
    report,
    mounted,
    currentPage,
    save,
    receive,
    sendWithBoard,
    opening,
    placingScreenshot,
    persistChange,
    cancelScheduledSaves,
  } = useLoveSpotPersistence({ editor, editorRef, boardArea, dark, attempt, onPage, setScreenshots, setRenaming });
  // A page list that fails is shown in the Pages menu it belongs to; the shared message line is cleared by every save.
  const loadPages = useCallback(() => {
    void api<PageList>("/love-spot/pages")
      .then(data => {
        if (!Array.isArray(data?.pages)) throw unreadable("Love Spot pages");
        if (mounted.current) {
          setPages(data.pages);
          setPagesError("");
        }
      })
      .catch(e => {
        if (mounted.current) setPagesError(errorText(e));
      });
  }, []);
  const reloadAccounts = useCallback(async () => {
    setAccountRefresh(value => value + 1);
    void refreshModelCatalog();
    try {
      const config = await api<ProviderSettings>("/settings");
      if (!config.main || (config.providers !== undefined && !Array.isArray(config.providers)))
        throw unreadable("Love Spot settings");
      if (mounted.current) setSettings(config);
    } catch (e) {
      report(e);
    }
  }, [report]);
  useEffect(() => {
    let active = true;
    void refreshModelCatalog();
    api<ProviderSettings>("/settings")
      .then(config => {
        if (!config.main || (config.providers !== undefined && !Array.isArray(config.providers)))
          throw unreadable("Love Spot settings");
        if (active) setSettings(config);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, [report]);
  useEffect(() => {
    if (!LOVE_SPOT_AUDIO.available) return;
    let active = true;
    void api<MatildaVoice>("/love-spot/voice/settings")
      .then(value => {
        if (active) {
          voiceEnabled.current = value.enabled;
        }
      })
      .catch(cause => {
        if (active) report(cause);
      });
    return () => {
      active = false;
    };
  }, []);
  return {
    speech,
    voiceEnabled,
    voiceVersion,
    calling,
    setAttempt,
    editor,
    noticeStyle,
    styleToggle,
    styleClassName,
    editorRef,
    ready,
    settings,
    whoOpen,
    setWhoOpen,
    accountsOpen,
    setAccountsOpen,
    accountRefresh,
    models,
    pick,
    setPick,
    screenshots,
    setScreenshots,
    choosing,
    setChoosing,
    page,
    pages,
    pagesError,
    pageToDelete,
    setPageToDelete,
    clearing,
    setClearing,
    pagesOpen,
    setPagesOpen,
    pageBusy,
    setPageBusy,
    renaming,
    setRenaming,
    pageName,
    setPageName,
    pagesScroll,
    reopenPages,
    queuedPage,
    pagesMenu,
    restoringPages,
    lastPoint,
    boardArea,
    placingAll,
    initial,
    error,
    setError,
    saveStatus,
    report,
    mounted,
    currentPage,
    save,
    receive,
    sendWithBoard,
    opening,
    placingScreenshot,
    persistChange,
    cancelScheduledSaves,
    loadPages,
    reloadAccounts,
    dark,
    toolbarHost,
  };
}

export type LoveBoardPages = ReturnType<typeof useLoveBoardPages>;
