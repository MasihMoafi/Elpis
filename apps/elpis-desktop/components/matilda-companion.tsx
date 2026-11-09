"use client";

import { useCompanionState } from "./matilda-companion-state";
import { useCompanionPlacement } from "./matilda-companion-placement";
import { MOODS, HerVoiceControls } from "./matilda-voice";
export { moodFromWords } from "./matilda-voice";

import { createPortal } from "react-dom";

import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { PinIcon, SoundIcon, SoundOffIcon } from "@/components/elpis-icons";

import { ContextMenu, ContextMenuContent } from "@/components/ui/context-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { MatildaMiniChat } from "@/components/matilda-mini-chat";
import { MatildaHeartBurst } from "@/components/matilda-heart-burst";
import { MatildaCharacterPicker } from "@/components/matilda-character-picker";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

import { MATILDA_SHOTS, MATILDA_SHOTS_LIGHT } from "@/bridge/matilda-face.cts";
export function MatildaCompanion() {
  const {
    error,
    state,
    floatRef,
    voice,
    shown,
    chrome,
    size,
    hidden,
    chatOpen,
    faceRef,
    grab,
    pull,
    release,
    suppressClick,
    setChatOpen,
    drag,
    put,
    keys,
    mood,
    character,
    act,
    side,
    chatPlace,
    mini,
    track,
    busy,
    pin,
  } = useCompanionPlacement(useCompanionState());
  // Her errors stay in her own place, never over the composer and its Send button (1 Nov): beside her when pinned,
  // under her title-bar button otherwise (where a failed load leaves her).
  const alert = error ? (
    <p role="alert" className="matilda-alert">
      {error}
    </p>
  ) : null;
  const floating = state?.pinned && (
    <section
      ref={floatRef}
      aria-label="Pinned Matilda"
      className="matilda-float"
      data-call={voice.shown || undefined}
      data-controls={shown.top - chrome < 40 ? "below" : "above"}
      style={{
        left: shown.left,
        top: shown.top,
        width: size,
        height: size,
        ...(hidden
          ? {
              clipPath: `polygon(-9999px -9999px, ${size - hidden}px -9999px, ${size - hidden}px 9999px, -9999px 9999px)`,
            }
          : {}),
      }}
    >
      {/* Right-click: Hide, the same as Unpin (5 Nov). Her face is images, so the trigger keeps Electron's image menu out. */}
      <ContextMenu>
        <ContextMenuPrimitive.Trigger className="contents">
          {/* A glass label rather than the system's dark tooltip (5 Nov, Masih: "this should be liquid blur glass"). */}
          <Tooltip content="Chat with Matilda" detail="Drag to move" suppressed={chatOpen} glass>
            <button
              ref={faceRef}
              type="button"
              className="matilda-face"
              data-speaking={voice.speaking || undefined}
              aria-label="Chat with Matilda"
              aria-haspopup="dialog"
              aria-expanded={chatOpen}
              style={{ touchAction: "none" }}
              onPointerDown={grab(false)}
              onPointerMove={pull}
              onPointerUp={release}
              onLostPointerCapture={release}
              onClick={() => {
                if (!suppressClick.current) setChatOpen(open => !open);
              }}
              onPointerCancel={() => {
                const start = drag.current;
                if (start) put(start.left, start.top, start.size);
                release();
              }}
              onKeyDown={keys(false)}
              onPointerEnter={() => mood.setHovered(true)}
              onPointerLeave={() => mood.setHovered(false)}
            >
              {/* A palette with its own character shows her, one picture for every mood (lib/theme-characters.ts). */}
              {character && (
                <img
                  src={character.image}
                  alt="Matilda"
                  data-character={character.name}
                  width={size}
                  height={size}
                  draggable={false}
                  className="matilda-theme-face select-none"
                />
              )}
              {!character && (
                <>
                  <img
                    src={MATILDA_SHOTS_LIGHT.listening}
                    alt="Matilda"
                    width={size}
                    height={size}
                    draggable={false}
                    className="matilda-avatar-light select-none"
                  />
                  <img
                    src={MATILDA_SHOTS.listening}
                    alt=""
                    aria-hidden="true"
                    width={size}
                    height={size}
                    draggable={false}
                    className="matilda-avatar-dark select-none"
                  />
                  {MOODS.flatMap(name => [
                    <img
                      key={`${name}-light`}
                      src={MATILDA_SHOTS_LIGHT[name]}
                      alt=""
                      aria-hidden="true"
                      width={size}
                      height={size}
                      draggable={false}
                      className="matilda-avatar-light matilda-mood select-none"
                      data-mood={name}
                      data-shown={mood.shown === name}
                    />,
                    <img
                      key={`${name}-dark`}
                      src={MATILDA_SHOTS[name]}
                      alt=""
                      aria-hidden="true"
                      width={size}
                      height={size}
                      draggable={false}
                      className="matilda-avatar-dark matilda-mood select-none"
                      data-mood={name}
                      data-shown={mood.shown === name}
                    />,
                  ])}
                </>
              )}
              {voice.speaking && <span className="matilda-speaking-ring" aria-hidden="true" />}
            </button>
          </Tooltip>
        </ContextMenuPrimitive.Trigger>
        <ContextMenuContent>
          <DropdownMenuItem onClick={() => void act("unpin")}>Hide</DropdownMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {chatOpen ? (
        <div className="hud-popover matilda-mini-popup accent-scope" data-side={side} style={chatPlace()}>
          {alert}
          <MatildaMiniChat chat={mini} />
        </div>
      ) : (
        alert && (
          <div className="hud-popover matilda-alert-popup" data-side={side} style={chatPlace()}>
            {alert}
          </div>
        )
      )}
      <button
        type="button"
        className="matilda-resize"
        aria-label="Resize Matilda"
        title="Drag to resize · + and − keys"
        style={{ touchAction: "none" }}
        onPointerDown={grab(true)}
        onPointerMove={pull}
        onPointerUp={release}
        onLostPointerCapture={release}
        onKeyDown={keys(true)}
      />
      <div className="matilda-float-controls">
        <MatildaCharacterPicker compact />
        {/* Only while music plays (or she muted it), as an icon (29 Oct, Masih: "no music is playing!", "I don't want texts; I want visuals"). */}
        {/* Not during her call: no music plays then (5 Nov, Masih: "while call happens no music is playing"). */}
        {!voice.call && track?.canMute && (track.status === "Playing" || track.muted) && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={track.muted ? "Unmute music" : "Mute music"}
            aria-pressed={track.muted}
            disabled={busy}
            onClick={() => void act("toggle-mute")}
          >
            {track.muted ? <SoundOffIcon size={16} /> : <SoundIcon size={16} />}
          </Button>
        )}
        <HerVoiceControls voice={voice} threadId={state?.threadId} />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Unpin Matilda"
          aria-pressed="true"
          onClick={() => void act("unpin")}
        >
          <PinIcon size={16} />
        </Button>
      </div>
    </section>
  );
  return (
    <div className="relative flex min-w-0 shrink-0 items-center gap-1 pr-2">
      <MatildaHeartBurst />
      {!floating && <HerVoiceControls voice={voice} threadId={state?.threadId} />}
      {floating ? (
        createPortal(floating, document.body)
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          className="matilda-pin"
          data-speaking={voice.speaking || undefined}
          aria-label="Pin Matilda"
          title="Pin Matilda"
          disabled={busy}
          onClick={pin}
        >
          <>
            {character ? (
              <img
                className="matilda-pin-face matilda-theme-face"
                src={character.image}
                alt=""
                data-character={character.name}
              />
            ) : (
              <>
                <img className="matilda-pin-face matilda-avatar-light" src={MATILDA_SHOTS_LIGHT.softSmile} alt="" />
                <img className="matilda-pin-face matilda-avatar-dark" src={MATILDA_SHOTS.softSmile} alt="" />
              </>
            )}
            {voice.speaking && <span className="matilda-speaking-ring" aria-hidden="true" />}
          </>
        </Button>
      )}
      {!floating && <MatildaCharacterPicker compact />}
      {!floating && alert && <div className="hud-popover matilda-alert-popup matilda-alert-anchor">{alert}</div>}
    </div>
  );
}
