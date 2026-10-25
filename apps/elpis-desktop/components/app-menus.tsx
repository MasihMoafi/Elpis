"use client";

import { useEffect, useRef, useState } from "react";
import { Menubar } from "@base-ui/react/menubar";
import { APP_MENUS } from "@/lib/app-menu-commands.cjs";
import { shortcutHint } from "@/lib/shortcuts";
import type { Preferences } from "@/lib/preferences";
import type { AppMenuCommand, NativeMenuCommand } from "@/lib/desktop";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type Action = () => void;
export type AppMenusProps = {
  onNewChat: Action; onOpenFolder: Action; onSettings: Action; onToggleSidebar: Action;
  onBack: Action; onForward: Action; onShortcuts: Action; canGoBack?: boolean; canGoForward?: boolean;
  preferences: Pick<Preferences, "shortcutBindings">; onError: (message: string) => void;
};

/** Base UI owns roving focus, typeahead, pointer switching and Escape. */
export function AppMenus(props: AppMenusProps) {
  const callbacks = useRef(props); callbacks.current = props;
  const [native, setNative] = useState(false);
  const previous = useRef<HTMLElement | null>(null), selection = useRef<Range | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const textSelection = useRef<{ start: number; end: number } | null>(null);
  const pending = useRef<AppMenuCommand | null>(null), chosen = useRef(false);
  const run = (command: AppMenuCommand) => {
    const p = callbacks.current;
    const actions: Partial<Record<AppMenuCommand, Action>> = { "new-chat": p.onNewChat, "open-folder": p.onOpenFolder, settings: p.onSettings, sidebar: p.onToggleSidebar, back: p.onBack, forward: p.onForward, shortcuts: p.onShortcuts };
    if (actions[command]) { actions[command]!(); return; }
    const target = previous.current;
    if (target?.isConnected) {
      target.focus({ preventScroll: true });
      if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && textSelection.current) target.setSelectionRange(textSelection.current.start, textSelection.current.end);
      else if (selection.current?.startContainer.isConnected) { const current = window.getSelection(); current?.removeAllRanges(); current?.addRange(selection.current); }
    }
    void window.elpisDesktop?.menu?.command(command as NativeMenuCommand).catch(cause => callbacks.current.onError(cause instanceof Error ? cause.message : String(cause)));
  };
  useEffect(() => {
    setNative(!!window.elpisDesktop?.menu);
    const stop = window.elpisDesktop?.menu?.subscribe(command => run(command));
    document.addEventListener('focusin', remember);
    document.addEventListener('selectionchange', remember);
    return () => { stop?.(); document.removeEventListener('focusin', remember); document.removeEventListener('selectionchange', remember); };
  }, []); // callbacks.current keeps native-menu actions on the current page state.
  const remember = () => {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement) || target.closest('[role="menubar"], [role="menu"]')) return;
    previous.current = target;
    textSelection.current = (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && target.selectionStart !== null ? { start: target.selectionStart, end: target.selectionEnd ?? target.selectionStart } : null;
    const current = window.getSelection(); selection.current = current?.rangeCount ? current.getRangeAt(0).cloneRange() : null;
  };
  const finish = (open: boolean) => {
    if (open || !pending.current) return;
    const command = pending.current; pending.current = null;
    trigger.current?.focus({ preventScroll: true });
    run(command);
  };
  return <div className="app-menus" onPointerDownCapture={remember} onKeyDownCapture={remember}>
    <Menubar className="app-menubar" aria-label="Application">
      {APP_MENUS.map(group => <DropdownMenu key={group.label} onOpenChangeComplete={finish} onOpenChange={open => { if (open) chosen.current = false; }}>
        <DropdownMenuTrigger onFocus={event => { trigger.current = event.currentTarget; }} render={<Button variant="ghost" size="sm" className="app-menu-trigger" />}>{group.label}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="app-menu-content" finalFocus={() => chosen.current ? false : true}>
          {group.items.map((item, index) => 'separator' in item ? <DropdownMenuSeparator key={index} /> : <DropdownMenuItem key={item.id}
            disabled={item.target === 'native' && !native || item.id === 'back' && !props.canGoBack || item.id === 'forward' && !props.canGoForward}
            onClick={() => { chosen.current = true; pending.current = item.id; }}>
            <span>{item.label}</span><span className="kbd-hint" aria-hidden="true">{'shortcut' in item ? shortcutHint(item.shortcut, props.preferences) : 'hint' in item ? item.hint : 'accelerator' in item ? item.accelerator.replace('CommandOrControl', 'Ctrl') : undefined}</span>
          </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>)}
    </Menubar>
  </div>;
}
