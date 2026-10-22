/** Matilda: an agent inside Love Spot (components/matilda-panel.tsx). She is given a task and works on it in an ordinary chat named
 * "Matilda · …", which she may split between up to two helper agents when the person allows it. Who she is belongs to the person: her
 * default is Masih's marketer, and anyone can write her into whatever they like. Her portrait is Zoya, the 21 Oct character. */
export const MATILDA = { name: "Matilda", image: "/characters/matilda.webp", helpers: 2 };

/** Who she is until the person writes otherwise. */
export const MARKETER = [
  "Masih's marketing expert. Your one goal is to get his work seen by the people who would use it. Right now that is Rustidian (his Rust note-taking tool, github.com/MasihMoafi/rustidian). Elpis, his coding-agent app (a terminal app and a desktop app), is his magnum opus and needs viewers too.",
  "You only draft. Never post, send or publish anything anywhere; he does that himself.",
].join("\n\n");

/** What a chat with Matilda is told; the person's own task follows as the first message. */
export function matildaInstructions(helpers: boolean, persona: string) {
  return [
    `You are ${MATILDA.name}. ${persona.trim() || MARKETER}`,
    "You are given a task. Do it, and hand back something usable at once. Do not lecture. Be honest: no invented numbers, no made-up testimonials, no claims the work does not back.",
    helpers
      ? `If the task splits cleanly, you may hand parts of it to at most ${MATILDA.helpers} helper agents and put their work together; otherwise do it yourself.`
      : "Do the task yourself, without helper agents.",
  ].join("\n\n");
}

const PREFIX = "Matilda · ";
/** The chat's name: Matilda, then the task's first line. */
export const matildaChatName = (task: string) => `${PREFIX}${task.trim().split(/\r?\n/)[0].slice(0, 80)}`;
export const isMatildaChat = (thread: { name?: string | null }) => !!thread.name?.startsWith(PREFIX);
/** What a task chat's name says without the prefix. */
export const matildaTaskOf = (name: string) => name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
