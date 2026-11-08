"use strict";

// The allowed values of each multiple-choice preference, read by both the renderer and the desktop store.
const choices = {
  sendShortcut: ["enter", "modEnter"],
  followUp: ["steer", "queue"],
  turnNotifications: ["never", "unfocused", "always"],
  transcriptSize: ["s", "m", "l"],
  transcriptWidth: ["s", "m", "l"],
  interfaceFont: ["sans", "serif"],
  interfaceSize: ["s", "m", "l"],
  codeSize: ["s", "m", "l"],
  cornerStyle: ["cut", "sharp", "rounded"],
  chatFont: ["default", "sans", "serif", "mono", "system"],
  accent: ["amber", "blue", "teal", "green", "violet", "rose", "orange"],
} as const;

export declare const PREFERENCE_CHOICES: typeof choices;
module.exports = { PREFERENCE_CHOICES: choices };
