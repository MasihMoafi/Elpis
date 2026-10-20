"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

type Prompt = { element: HTMLElement; text: string };
const labelOf = (text: string) => (text.length > 80 ? `${text.slice(0, 79)}…` : text);

/** A thin rail at the transcript's left edge with one tick per prompt, as in Claude's desktop app. A tick scrolls to its
 * prompt; the lit one is the prompt being read: the last one above the top third of the view, or the last of all at the
 * end of the chat. The prompts are the transcript's own turns (`section[data-prompt]`), read from the page after each
 * change, so the rail never keeps a list of its own. With one prompt there is nothing to move between, so it hides. */
export function PromptRail({ scroller, version }: { scroller: RefObject<HTMLElement | null>; version: unknown }) {
  const [prompts, setPrompts] = useState<string[]>([]);
  const [current, setCurrent] = useState(0);
  const elements = useRef<HTMLElement[]>([]);
  const frame = useRef(0);
  const rail = useRef<HTMLElement>(null);
  const read = () => {
    const root = scroller.current; if (!root) return;
    const found: Prompt[] = [...root.querySelectorAll<HTMLElement>("section.turn[data-prompt]")].map(element => ({ element, text: (element.querySelector(".message.user:not(.editing)")?.textContent ?? "").trim() }));
    elements.current = found.map(prompt => prompt.element);
    setPrompts(previous => previous.length === found.length && previous.every((text, index) => text === found[index].text) ? previous : found.map(prompt => prompt.text));
    place();
  };
  const place = () => {
    const root = scroller.current, list = elements.current; if (!root || !list.length) return;
    const top = root.getBoundingClientRect().top, bottom = root.scrollHeight - root.scrollTop - root.clientHeight < 4;
    let index = 0;
    list.forEach((element, at) => { if (element.getBoundingClientRect().top - top <= root.clientHeight / 3) index = at; });
    setCurrent(bottom ? list.length - 1 : index);
  };
  useEffect(read, [version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = scroller.current; if (!root) return;
    const onScroll = () => { cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(place); };
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { root.removeEventListener("scroll", onScroll); cancelAnimationFrame(frame.current); };
  }, [scroller]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { rail.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" }); }, [current]);
  if (prompts.length < 2) return null;
  const goTo = (index: number) => {
    const root = scroller.current, element = elements.current[index]; if (!root || !element) return;
    root.scrollTo({ top: root.scrollTop + element.getBoundingClientRect().top - root.getBoundingClientRect().top - 16, behavior: "smooth" });
    setCurrent(index);
  };
  return <nav ref={rail} className="prompt-rail" aria-label="Prompts">
    {prompts.map((text, index) => <button data-slot="prompt-mark" key={index} type="button" className="prompt-tick" aria-label={`Go to prompt: ${labelOf(text)}`} title={labelOf(text)} aria-current={index === current ? "true" : undefined} onClick={() => goTo(index)}><i /></button>)}
  </nav>;
}
