"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { ViewBoundary } from "@/components/view-boundary";
import { appStorage } from "@/lib/projects";

const LoveSpot = dynamic(() => import("@/components/love-spot"), { ssr: false, loading: () => <p role="status">Opening Love Spot…</p> });

/** The dock uses the same editor and bridge as Elpis, without the chat workspace. */
export default function LoveSpotWindow() {
  const [dark, setDark] = useState(false);
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    document.title = "Love Spot · Elpis";
    setDesktop(!!window.elpisDesktop);
    const media = matchMedia("(prefers-color-scheme: dark)");
    const refresh = () => {
      const saved = appStorage().getItem("elpis-theme");
      const source = saved === "dark" || saved === "light" ? saved : "system";
      const dark = source === "dark" || (source === "system" && media.matches);
      setDark(dark); document.documentElement.classList.toggle("dark", dark);
      window.elpisDesktop?.setTheme?.(dark, { source, background: getComputedStyle(document.body).backgroundColor });
    };
    refresh(); media.addEventListener("change", refresh); window.addEventListener("storage", refresh);
    const stop = window.elpisDesktop?.storage?.onChange?.(key => { if (key === "elpis-theme") refresh(); });
    return () => { media.removeEventListener("change", refresh); window.removeEventListener("storage", refresh); stop?.(); };
  }, []);
  return <main className={`flex h-dvh min-w-0 flex-col bg-background text-foreground${dark ? " dark" : ""}`}>
    {desktop && <div className="title-bar shrink-0" aria-hidden="true" />}
    <ViewBoundary label="Love Spot"><LoveSpot dark={dark} onOpenChat={id => { void window.elpisDesktop?.openSessionWindow?.(id); }} /></ViewBoundary>
  </main>;
}
