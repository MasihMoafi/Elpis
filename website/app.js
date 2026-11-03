import { admissionStateAt, DEMO_TOKENS } from "./assets/demo-state.mjs?v=refined-20261015b";
import { CATEGORIES, CONTEXT_EXAMPLE, demoSnapshot, ledgerMarkup, updateLedger, sourceProjection, compactTokens } from "./assets/context-ledger.mjs?v=audit-repairs-20261015";

function applyCategoryPalette() {
  const theme = document.documentElement.dataset.theme === "elpis-light" ? "light" : "dark";
  CATEGORIES.forEach(category => document.documentElement.style.setProperty(`--category-${category.key}`, category[theme]));
}
applyCategoryPalette();
new MutationObserver(applyCategoryPalette).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
const demoLedger = document.querySelector('[data-native-ledger="demo"]');
if (demoLedger) demoLedger.innerHTML = ledgerMarkup(demoSnapshot(admissionStateAt(0)), { compact: true });
const exampleLedger = document.querySelector('[data-native-ledger="example"]');
if (exampleLedger) exampleLedger.innerHTML = ledgerMarkup(CONTEXT_EXAMPLE, { interactive: true });
// One fixed explanation lives outside both Ledgers, so hover cannot change
// the trigger's height, move a row, or alter either pane's scroll position.
const ledgerHelp = document.createElement('div');
ledgerHelp.className = 'native-help-text';
ledgerHelp.id = 'ledger-explanation';
ledgerHelp.setAttribute('role', 'tooltip');
ledgerHelp.hidden = true;
document.body.append(ledgerHelp);
let helpTrigger;
let helpPinned = false;
function closeExplanations() {
  ledgerHelp.hidden = true;
  helpTrigger?.removeAttribute('aria-describedby');
  helpTrigger?.setAttribute('aria-expanded', 'false');
  helpTrigger = undefined;
  helpPinned = false;
}
function showExplanation(button, text, pinned = false) {
  if (helpTrigger && helpTrigger !== button) closeExplanations();
  helpTrigger = button;
  helpPinned = pinned;
  ledgerHelp.textContent = text;
  ledgerHelp.hidden = false;
  button.setAttribute('aria-describedby', ledgerHelp.id);
  const anchor = button.getBoundingClientRect();
  const box = ledgerHelp.getBoundingClientRect();
  ledgerHelp.style.left = `${Math.max(12, Math.min(anchor.left, document.documentElement.clientWidth - box.width - 12))}px`;
  ledgerHelp.style.top = `${Math.max(12, anchor.bottom + box.height + 8 < innerHeight ? anchor.bottom + 8 : anchor.top - box.height - 8)}px`;
}

if (exampleLedger) {
  const sources = CONTEXT_EXAMPLE.sources.map(source => ({ ...source }));
  exampleLedger.querySelectorAll('[data-ledger-switch]').forEach(button => button.addEventListener('click', () => {
    const enabled = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(enabled));
    button.dataset.enabled = String(enabled);
    button.querySelector('[data-switch-glyph]').textContent = enabled ? '[━━━●]' : '[●━━━]';
    button.querySelector('[data-switch-state]').textContent = enabled ? 'ON' : 'OFF';
    const key = button.dataset.ledgerSwitch;
    exampleLedger.querySelector(`[data-switch-detail="${key}"]`).textContent = key === 'smart'
      ? enabled ? 'Before first main-model send · sent history stays stable' : 'Tool results pass through unchanged'
      : enabled ? 'May delegate to other agents' : 'All work stays in this thread';
  }));
  exampleLedger.querySelectorAll('[data-ledger-source]').forEach(button => button.addEventListener('click', () => {
    const source = sources.find(item => item.name === button.dataset.ledgerSource);
    source.admitted = !source.admitted;
    button.setAttribute('aria-pressed', String(source.admitted));
    button.querySelector('[data-source-mark]').textContent = source.admitted ? '[x]' : '[ ]';
    button.querySelector('.native-source-state').textContent = source.admitted ? 'INCLUDED' : 'EXCLUDED';
    exampleLedger.querySelector(`[data-source-total="${source.group}"]`).textContent = `≈${compactTokens(sourceProjection(sources.filter(item => item.group === source.group)))} tokens admitted`;
    const pending = sources.some((item,i) => item.admitted !== CONTEXT_EXAMPLE.sources[i].admitted);
    exampleLedger.querySelector('[data-native-total]').textContent = `≈${compactTokens(CONTEXT_EXAMPLE.total)} tokens ${pending ? 'now · changes pending' : 'in context'}`;
    showExplanation(button, `${source.help || 'Project context available for explicit admission.'} ${pending ? `Selection applies to a future request. This example snapshot stays at ${compactTokens(CONTEXT_EXAMPLE.total)}.` : 'The original selection is restored.'}`, true);
  }));
  exampleLedger.addEventListener('keydown', event => {
    const controls = [...exampleLedger.querySelectorAll('[data-ledger-switch], [data-ledger-source]')];
    const selected = controls.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      controls[(selected + (event.key === 'ArrowDown' ? 1 : controls.length - 1)) % controls.length].focus();
    } else if (event.key === 'p' || event.key === 's') {
      event.preventDefault();
      exampleLedger.querySelector(`[data-ledger-switch="${event.key === 'p' ? 'smart' : 'subagents'}"]`).click();
    } else if (event.key === 'i') {
      event.preventDefault();
      const rows = controls.filter(button => button.hasAttribute('data-ledger-source'));
      const include = rows.some(button => button.getAttribute('aria-pressed') !== 'true');
      rows.filter(button => (button.getAttribute('aria-pressed') === 'true') !== include).forEach(button => button.click());
    } else if (event.key === 'w' && selected >= 0) {
      const source = sources.find(item => item.name === controls[selected].dataset.ledgerSource);
      if (source) {
        showExplanation(controls[selected], source.help || 'Explicitly admitted project context.', true);
      }
    }
  });
}

const header = document.querySelector("header.navbar");

const copyButton = document.querySelector("[data-copy-button]");
const command = document.querySelector("[data-command]");
const copyStatus = document.querySelector("[data-copy-status]");

copyButton?.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(command.textContent.trim());
    copyStatus.textContent = "Command copied to clipboard.";
    window.setTimeout(() => (copyStatus.textContent = ""), 1600);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(command);
    selection.removeAllRanges();
    selection.addRange(range);
    copyStatus.textContent = "Copy failed. The command has been selected.";
  }
});

const aceDemo = document.querySelector("[data-ace-demo]");
const aceTerminal = document.querySelector("[data-ace-terminal]");

if (aceDemo && aceTerminal) {
  const shellCommand = aceDemo.querySelector("[data-shell-command]");
  const shellEnter = aceDemo.querySelector("[data-shell-enter]");
  const logo = aceDemo.querySelector("[data-ace-logo]");
  const bootLog = aceDemo.querySelector("[data-boot-log]");
  const composerText = aceDemo.querySelector("[data-composer-text]");
  const composerCursor = aceDemo.querySelector("[data-composer-cursor]");
  const sentPrompt = aceDemo.querySelector("[data-sent-prompt]");
  const toolOutput = aceDemo.querySelector("[data-tool-output]");
  const footerContext = aceDemo.querySelector("[data-footer-context]");
  const pruneFlash = aceDemo.querySelector("[data-prune-flash]");
  const toolStatus = aceDemo.querySelector("[data-tool-status]");
  const chat = aceDemo.querySelector(".ace-chat");
  const admittedResult = aceDemo.querySelector(".ace-compact-result");
  let previousPhase;
  let previousLedgerTotal;
  const logoText = logo.textContent;
  const prompt = "Familiarize yourself with the project in this order: find the intent; verify docs against code; read the updated docs; map the code structure.";
  const clamp = (number, minimum = 0, maximum = 1) => Math.min(maximum, Math.max(minimum, number));
  const mix = (from, to, progress) => Math.round(from + (to - from) * progress);

  function paintAceLogo(sweep) {
    let column = 0;
    logo.innerHTML = [...logoText].map((character) => {
      if (character === "\n") {
        column = 0;
        return "\n";
      }
      const distance = Math.abs(column++ - sweep);
      if (character === " ") return " ";
      if (distance < 4) return `<span class="hot">${character}</span>`;
      if (distance < 11) return `<span class="warm">${character}</span>`;
      return character;
    }).join("");
  }

  function renderAceDemo(progress) {
    const position = clamp(progress);
    const state = admissionStateAt(position);
    const phase = state.phase;
    aceTerminal.className = `ace-terminal phase-${phase}`;

    shellCommand.textContent = "elpis".slice(0, Math.floor(clamp(position / 0.095) * 5));
    shellEnter.textContent = position >= 0.10 && position < 0.12 ? " ↵" : "";

    const bootProgress = clamp((position - 0.12) / 0.15);
    paintAceLogo(mix(-8, 48, bootProgress));
    const loaded = Math.floor(bootProgress * 12);
    const logs = [
      '<span class="ok">✓</span> workspace found',
      '<span class="ok">✓</span> continuity sources indexed',
      '<span class="ok">✓</span> Context Ledger opened for this walkthrough',
    ];
    bootLog.innerHTML = `${logs.slice(0, Math.ceil(bootProgress * 3)).map((line) => `<div>${line}</div>`).join("")}<div>[${"█".repeat(loaded)}${"░".repeat(12 - loaded)}]</div>`;

    const typed = clamp((position - 0.27) / 0.14);
    composerText.textContent = phase === "ready"
      ? prompt.slice(0, Math.floor(prompt.length * typed))
      : "";
    composerCursor.style.display = phase === "ready" ? "inline" : "none";
    sentPrompt.textContent = ["working", "tools", "ace", "done"].includes(phase) ? prompt : "";

    toolOutput.className = "ace-tool-output";
    if (phase === "tools") toolOutput.classList.add("open");
    if (phase === "ace") toolOutput.classList.add("open", "scanning");
    if (phase === "done") toolOutput.classList.add("compacted");
    toolOutput.style.setProperty("--scan", clamp((position - 0.70) / 0.19).toFixed(3));

    const format = value => value.toLocaleString("en-US");
    if (state.total !== previousLedgerTotal) {
      updateLedger(demoLedger, demoSnapshot(state));
      previousLedgerTotal = state.total;
    }
    footerContext.textContent = `${format(state.total)} context tokens · ${(100 - state.usedPercent).toFixed(1)}% left`;
    toolStatus.textContent = phase === "done" ? `${format(DEMO_TOKENS.optimized)} admitted tokens` : `${format(DEMO_TOKENS.raw)} raw tokens`;
    pruneFlash.textContent = state.saved ? `✂ Smart Prune saved ~${(state.saved / 1000).toFixed(1)}k tokens · snip!` : "";
    if (phase === "done" && previousPhase !== "done") {
      chat.scrollTop += admittedResult.getBoundingClientRect().top - chat.getBoundingClientRect().top - 16;
    }
    else if (phase !== "done" && previousPhase === "done") chat.scrollTop = 0;
    previousPhase = phase;
  }

  let scrollFrame;
  function renderAceDemoFromScroll() {
    scrollFrame = undefined;
    const topOffset = header?.offsetHeight || 0;
    const rectangle = aceDemo.getBoundingClientRect();
    const travel = aceDemo.offsetHeight - aceDemo.querySelector(".ace-demo-stage").offsetHeight;
    renderAceDemo(clamp((topOffset - rectangle.top) / Math.max(1, travel)));
  }

  function requestAceDemoFrame() {
    if (scrollFrame === undefined) scrollFrame = requestAnimationFrame(renderAceDemoFromScroll);
  }

  // Scroll position owns every step, including when desktop motion is disabled.
  addEventListener("scroll", requestAceDemoFrame, { passive: true });
  addEventListener("resize", requestAceDemoFrame);
  renderAceDemoFromScroll();
}

// Delegate so the demo's replaced category bar keeps its hover/focus/tap labels.
for (const name of ['mouseover', 'focusin']) document.addEventListener(name, event => {
  const button = event.target.closest('[data-ledger-help]');
  if (button && !button.contains(event.relatedTarget)) showExplanation(button, button.dataset.help);
});
for (const name of ['mouseout', 'focusout']) document.addEventListener(name, event => {
  const button = event.target.closest('[data-ledger-help]');
  if (button === helpTrigger && !button?.contains(event.relatedTarget) && !helpPinned) closeExplanations();
});
document.addEventListener('click', event => {
  const button = event.target.closest('[data-ledger-help]');
  if (!button) return;
  if (helpTrigger === button && helpPinned) closeExplanations();
  else {
    showExplanation(button, button.dataset.help, true);
    button.setAttribute('aria-expanded', 'true');
  }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeExplanations(); });
document.addEventListener('click', event => {
  if (!event.target.closest('[data-ledger-help], [data-ledger-source]')) closeExplanations();
});
addEventListener('scroll', closeExplanations, { capture: true, passive: true });
addEventListener('resize', closeExplanations);

// The desktop app's themes, driven by scroll (index.html #desktop-app). Each step holds one theme,
// then the next wipes in from the left; the section takes the theme's background, ink and accent.
const themeTour = document.querySelector("[data-theme-tour]");
if (themeTour) {
  const TOUR = [
    { bg: "#0a0b0d", ink: "#e6e0d3", muted: "#9c9587", accent: "#f2a93b" },
    { bg: "#fbfbfa", ink: "#252524", muted: "#636361", accent: "#c27a12" },
    { bg: "#101521", ink: "#e4e9f5", muted: "#93a0ba", accent: "#9cb9f5" },
    { bg: "#faf7f0", ink: "#2b2620", muted: "#6c6358", accent: "#8c542c" },
    { bg: "#161018", ink: "#efe3f0", muted: "#a693a8", accent: "#d9a2e0" },
    { bg: "#f6f8fc", ink: "#1f2533", muted: "#5d6678", accent: "#3158a6" },
  ];
  const shots = [...themeTour.querySelectorAll("[data-theme-shot]")];
  const steps = [...themeTour.querySelectorAll("[data-theme-step]")];
  const edge = themeTour.querySelector(".theme-tour-edge");
  const stage = themeTour.querySelector(".theme-tour-stage");
  const header = document.querySelector("header");
  const clamp = (n) => Math.min(1, Math.max(0, n));
  const ease = (t) => t * t * (3 - 2 * t);
  let frame;
  function renderTour() {
    frame = undefined;
    const travel = themeTour.offsetHeight - stage.offsetHeight;
    const progress = clamp(((header?.offsetHeight || 0) - themeTour.getBoundingClientRect().top) / Math.max(1, travel));
    const position = progress * (TOUR.length - 1);
    const from = Math.min(TOUR.length - 2, Math.floor(position));
    const wipe = ease(clamp((position - from - 0.3) / 0.55));
    shots.forEach((shot, index) => shot.style.setProperty("--reveal", index <= from ? 1 : index === from + 1 ? wipe : 0));
    const active = wipe < 0.5 ? from : from + 1;
    // The section switches at the wipe's midpoint and fades (CSS transition), never through a muddy mix.
    for (const key of ["bg", "ink", "muted", "accent"]) themeTour.style.setProperty(`--tour-${key}`, TOUR[active][key]);
    edge.style.setProperty("--edge", wipe);
    edge.style.setProperty("--edge-on", wipe > 0 && wipe < 1 ? 1 : 0);
    edge.style.setProperty("--edge-colour", TOUR[from + 1].accent);
    steps.forEach((step, index) => step.toggleAttribute("data-active", index === active));
  }
  const requestTour = () => { if (frame === undefined) frame = requestAnimationFrame(renderTour); };
  addEventListener("scroll", requestTour, { passive: true });
  addEventListener("resize", requestTour);
  renderTour();
}

// Films in the player frame: they play muted while on screen and pause when scrolled away;
// Play/Pause, Replay, seek and Sound are their own controls.
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
document.querySelectorAll("[data-film]").forEach((film) => {
  const video = film.querySelector("video");
  const play = film.querySelector("[data-film-play]");
  const replay = film.querySelector("[data-film-replay]");
  const seek = film.querySelector("[data-film-seek]");
  const time = film.querySelector("[data-film-time]");
  const sound = film.querySelector("[data-film-sound]");
  let userPaused = false;
  const paint = () => {
    play.textContent = video.paused ? "Play" : "Pause";
    play.setAttribute("aria-label", `${video.paused ? "Play" : "Pause"} the film`);
    sound.textContent = video.muted ? "Sound on" : "Sound off";
    sound.setAttribute("aria-pressed", String(!video.muted));
    if (video.duration) {
      seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
      time.textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
    }
  };
  const start = () => video.play().catch(() => undefined);
  play.addEventListener("click", () => { userPaused = !video.paused; if (video.paused) start(); else video.pause(); });
  video.addEventListener("click", () => play.click());
  replay.addEventListener("click", () => { video.currentTime = 0; userPaused = false; start(); });
  seek.addEventListener("input", () => { if (video.duration) video.currentTime = (Number(seek.value) / 1000) * video.duration; });
  sound.addEventListener("click", () => { video.muted = !video.muted; if (!video.muted && video.paused) { userPaused = false; start(); } paint(); });
  video.addEventListener("ended", () => { video.currentTime = 0; start(); });
  for (const event of ["play", "pause", "timeupdate", "loadedmetadata", "volumechange"]) video.addEventListener(event, paint);
  new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting && !userPaused) start();
    else if (!entry.isIntersecting) video.pause();
  }, { threshold: 0.45 }).observe(video);
  paint();
});
