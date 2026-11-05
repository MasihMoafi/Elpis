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

// The Workflows board's isometric view: a cube per agent card at the card's centre, with an upright numbered label,
// and the flat wires redrawn between cube centres on the ground. Returns a function that re-trims the wires on resize.
function buildIsometric(board) {
  const COLORS = ["#6fbf73", "#6c8fd8", "#d9905b", "#9c7bd8", "#d66d9e", "#5fb4b4", "#c9b458", "#7aa5c9"];
  const cards = [...board.querySelectorAll(".wf-node")].map((card) => ({
    card, x: parseFloat(card.style.getPropertyValue("--x")), y: parseFloat(card.style.getPropertyValue("--y")),
    check: card.classList.contains("wf-check"), mother: card.classList.contains("wf-mother"),
  }));
  const columns = [...new Set(cards.map(({ x }) => x))].sort((a, b) => a - b);
  cards.forEach((node, index) => {
    node.cx = node.x + 8.5;
    node.wave = columns.indexOf(node.x) + (node.check && cards.some((other) => other.x === node.x && !other.check) ? 1 : 0);
    const cube = document.createElement("div");
    cube.className = "wf-cube";
    cube.setAttribute("aria-hidden", "true");
    cube.style.cssText = `--cx:${node.cx};--cy:${node.y};--c:${node.mother ? "#1b1b1b" : COLORS[(index - 1) % COLORS.length]}`;
    const label = document.createElement("b");
    if (!node.mother) label.append(Object.assign(document.createElement("span"), { textContent: node.wave }));
    label.append(node.card.querySelector("strong")?.textContent || "");
    cube.append(...["glow", "ring", "top", "south", "east"].map((face) => Object.assign(document.createElement("i"), { className: face })), label);
    node.cube = cube;
    board.append(cube);
  });
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "wf-iso-edges");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  board.prepend(svg);
  // Each flat wire runs from a card's right edge (or, for a wire straight down, its centre) to the next card's left edge.
  const nearest = (px, py, edge) => cards.reduce((best, node) => {
    const d = Math.abs(node.x + edge - px) + Math.abs(node.y - py) * 0.3;
    return d < best.d ? { node, d } : best;
  }, { d: Infinity }).node;
  const links = [...board.querySelectorAll(".wf-edges > path[data-draw]")].map((path) => {
    const n = path.getAttribute("d").match(/-?[\d.]+/g).map(Number);
    const [sx, sy, ex, ey] = [n[0], n[1], n[n.length - 2], n[n.length - 1]];
    const down = Math.abs(sx - ex) < 1;
    return { flat: path, from: nearest(sx, sy, down ? 8.5 : 17), to: nearest(ex, ey, down ? 8.5 : 0) };
  });
  const draw = () => {
    const across = (26 / Math.max(1, board.offsetWidth)) * 100, down = (26 / Math.max(1, board.offsetHeight)) * 100;
    svg.replaceChildren(...links.map((link) => {
      const { from, to } = link;
      const path = link.path = document.createElementNS("http://www.w3.org/2000/svg", "g");
      const wire = document.createElementNS("http://www.w3.org/2000/svg", "path"), stream = document.createElementNS("http://www.w3.org/2000/svg", "path");
      wire.setAttribute("class", "wire");
      stream.setAttribute("class", "stream");
      path.append(wire, stream);
      const vertical = Math.abs(from.cx - to.cx) < 1, mid = (from.cx + to.cx) / 2;
      const d = (vertical
        ? `M${from.cx} ${from.y} V${to.y - Math.sign(to.y - from.y) * down}`
        : `M${from.cx} ${from.y} H${mid} V${to.y} H${to.cx - across}`);
      wire.setAttribute("d", d);
      stream.setAttribute("d", d);
      // The routes are straight runs, so their on-screen length (before the tilt) is simple to add up.
      const w = board.offsetWidth / 100, h = board.offsetHeight / 100;
      const length = vertical ? Math.abs(to.y - from.y) * h : (Math.abs(mid - from.cx) + Math.abs(to.cx - across - mid)) * w + Math.abs(to.y - from.y) * h;
      stream.style.setProperty("--len", Math.round(length));
      return path;
    }));
  };
  // A wire carries work while its agent runs: lit from the flat wire's data-lit, until the agent it feeds is done.
  const sync = () => {
    for (const { card, cube } of cards) cube.dataset.state = card.hasAttribute("data-shown") ? card.dataset.state || "waiting" : "hidden";
    for (const { flat, path, from, to } of links) {
      path?.toggleAttribute("data-hidden", !from.card.hasAttribute("data-shown") || !to.card.hasAttribute("data-shown"));
      const finished = /done|passed/.test(to.card.dataset.state || "");
      path?.toggleAttribute("data-active", flat.hasAttribute("data-active") && !finished);
      path?.toggleAttribute("data-done", flat.hasAttribute("data-active") && finished);
    }
  };
  draw();
  return { draw, sync };
}

// Scroll-driven scenes (Workflows, Love Spot): the section's scroll position is the timeline.
// data-on / data-off show an element from / until a point, data-type types its text over a range,
// data-draw draws an SVG path over a range, data-states sets data-state (and a label) at each point.
document.querySelectorAll("[data-scene]").forEach((scene) => {
  const stage = scene.querySelector(".scene-stage");
  const header = document.querySelector("header");
  const clamp = (n) => Math.min(1, Math.max(0, n));
  const range = (value) => value.split(",").map(Number);
  const typed = [...scene.querySelectorAll("[data-type]")].map((element) => ({ element, text: element.textContent, span: range(element.dataset.type) }));
  // The strokes do not scale with the stretched SVG, so dashes are measured on screen, not in SVG units.
  const screenLength = (path) => {
    const matrix = path.getScreenCTM(), total = path.getTotalLength();
    let length = 0, previous;
    for (let i = 0; i <= 48; i += 1) {
      const point = path.getPointAtLength((total * i) / 48).matrixTransform(matrix);
      if (previous) length += Math.hypot(point.x - previous.x, point.y - previous.y);
      previous = point;
    }
    return Math.ceil(length) + 2;
  };
  const drawn = [...scene.querySelectorAll("[data-draw]")].map((path) => ({ path, length: 0, span: range(path.dataset.draw) }));
  const measure = () => drawn.forEach((stroke) => { stroke.length = screenLength(stroke.path); stroke.path.style.strokeDasharray = `${stroke.length} ${stroke.length}`; });
  const stated = [...scene.querySelectorAll("[data-states]")].map((element) => ({ element, steps: element.dataset.states.split(",").map((step) => step.split(":")).map(([at, name]) => [Number(at), name]) }));
  const shown = [...scene.querySelectorAll("[data-on], [data-off]")];
  const board = scene.querySelector("[data-wf-board]");
  const viewButtons = [...scene.querySelectorAll("[data-wf-view]")];
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  // Workflows: the 2D run plays over the first part of the scroll, then the board tilts into the isometric
  // view as the visitor keeps scrolling, and stays there; scrolling back flattens it.
  // The flat board shows the team being designed (timeline 0 to RUN), then turns isometric, and the run itself plays
  // on the cubes over most of the scroll, as in the Workflows films.
  const RUN = 0.32, DESIGN_END = 0.26, TILT_FROM = 0.27, TILT_TO = 0.37, CUBE_FROM = 0.35, CUBE_TO = 0.42, RUN_FROM = 0.44, RUN_TO = 0.94;
  const timeline = (raw) => raw <= DESIGN_END ? (raw / DESIGN_END) * RUN : raw < RUN_FROM ? RUN : RUN + (1 - RUN) * clamp((raw - RUN_FROM) / (RUN_TO - RUN_FROM));
  const iso = board ? buildIsometric(board) : null;
  const progress = () => clamp(((header?.offsetHeight || 0) - scene.getBoundingClientRect().top) / Math.max(1, scene.offsetHeight - stage.offsetHeight));
  const scrollToProgress = (target) => {
    const travel = scene.offsetHeight - stage.offsetHeight;
    scrollTo({ top: scene.getBoundingClientRect().top + scrollY - (header?.offsetHeight || 0) + travel * target, behavior: reduced.matches ? "auto" : "smooth" });
  };
  viewButtons.forEach((button) => button.addEventListener("click", () => scrollToProgress(button.dataset.wfView === "isometric" ? 0.6 : DESIGN_END)));
  let frame;
  function render() {
    frame = undefined;
    const raw = progress(); // the visitor drives this by scrolling, so it plays with reduced motion too
    const p = board ? timeline(raw) : raw;
    if (board) {
      const ease = (from, to) => { const t = clamp((raw - from) / (to - from)); return t * t * (3 - 2 * t); };
      const tilt = ease(TILT_FROM, TILT_TO);
      board.style.setProperty("--tilt", tilt.toFixed(4));
      board.style.setProperty("--cube", ease(CUBE_FROM, CUBE_TO).toFixed(4));
      const view = tilt > 0.5 ? "isometric" : "flat";
      board.dataset.view = view;
      viewButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.wfView === view)));
    }
    for (const element of shown) element.toggleAttribute("data-shown", p >= Number(element.dataset.on || 0) && p < Number(element.dataset.off || 2));
    for (const { element, text, span: [from, to] } of typed) element.textContent = text.slice(0, Math.round(text.length * clamp((p - from) / (to - from))));
    for (const { path, length, span: [from, to] } of drawn) {
      const isometric = board?.dataset.view === "isometric" && p >= to;
      path.style.strokeDasharray = isometric ? "5 4" : `${length} ${length}`;
      path.style.strokeDashoffset = isometric ? "0" : `${length * (1 - clamp((p - from) / (to - from)))}`;
    }
    for (const { element, steps } of stated) {
      const state = steps.filter(([at]) => p >= at).pop()?.[1] ?? "hidden";
      element.dataset.state = state;
      const label = element.dataset[`label${state[0].toUpperCase()}${state.slice(1)}`];
      const target = element.querySelector(".wf-state") || (element.classList.contains("wf-run") ? element : null);
      if (target) target.textContent = target === element ? (label ?? "") : (target.dataset[`label${state[0].toUpperCase()}${state.slice(1)}`] ?? "");
    }
    for (const lit of scene.querySelectorAll("[data-lit]")) lit.toggleAttribute("data-active", p >= Number(lit.dataset.lit));
    iso?.sync();
  }
  const request = () => { if (frame === undefined) frame = requestAnimationFrame(render); };
  addEventListener("scroll", request, { passive: true });
  addEventListener("resize", () => { measure(); iso?.draw(); request(); });
  reduced.addEventListener("change", request);
  measure();
  render();
});
