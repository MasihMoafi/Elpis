const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
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
  const ledgerTotal = aceDemo.querySelector("[data-ledger-total]");
  const windowFigure = aceDemo.querySelector("[data-window-figure]");
  const contextMeter = aceDemo.querySelector("[data-context-meter]");
  const conversationCount = aceDemo.querySelector("[data-conversation-count]");
  const footerContext = aceDemo.querySelector("[data-footer-context]");
  const evidenceTotal = aceDemo.querySelector("[data-evidence-total]");
  const evidenceRow = aceDemo.querySelector("[data-evidence-row]");
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
    let phase = "shell";
    if (position >= 0.12) phase = "boot";
    if (position >= 0.27) phase = "ready";
    if (position >= 0.43) phase = "working";
    if (position >= 0.54) phase = "tools";
    if (position >= 0.70) phase = "ace";
    if (position >= 0.89) phase = "done";
    aceTerminal.className = `ace-terminal phase-${phase}`;

    shellCommand.textContent = "elpis".slice(0, Math.floor(clamp(position / 0.095) * 5));
    shellEnter.textContent = position >= 0.10 && position < 0.12 ? " ↵" : "";

    const bootProgress = clamp((position - 0.12) / 0.15);
    paintAceLogo(mix(-8, 48, bootProgress));
    const loaded = Math.floor(bootProgress * 12);
    const logs = [
      '<span class="ok">✓</span> workspace found',
      '<span class="ok">✓</span> continuity sources indexed',
      '<span class="ok">✓</span> Context Ledger open by default',
    ];
    bootLog.innerHTML = `${logs.slice(0, Math.ceil(bootProgress * 3)).map((line) => `<div>${line}</div>`).join("")}<div>[${"█".repeat(loaded)}${"░".repeat(12 - loaded)}]</div>`;

    const typed = clamp((position - 0.27) / 0.14);
    composerText.textContent = phase === "ready"
      ? prompt.slice(0, Math.floor(prompt.length * typed))
      : phase === "done" ? "Ask a follow-up" : "";
    composerCursor.style.display = phase === "ready" ? "inline" : "none";
    sentPrompt.textContent = ["working", "tools", "ace", "done"].includes(phase) ? prompt : "";

    toolOutput.className = "ace-tool-output";
    if (phase === "tools") toolOutput.classList.add("open");
    if (phase === "ace") toolOutput.classList.add("open", "scanning");
    if (phase === "done") toolOutput.classList.add("compacted");
    toolOutput.style.setProperty("--scan", clamp((position - 0.70) / 0.19).toFixed(3));

    const finished = phase === "done";
    ledgerTotal.textContent = finished ? "Total ≈6.0k tokens admitted" : "Total ≈5.6k tokens admitted";
    windowFigure.textContent = finished
      ? "≈33.8k of 258.4k used (13%)"
      : "≈33.3k of 258.4k used (13%)";
    conversationCount.textContent = "≈27.7k tokens";
    contextMeter.style.setProperty("--used", finished ? "13.08%" : "12.89%");
    footerContext.textContent = "87% context left";
    evidenceTotal.textContent = finished ? "≈642 tokens admitted" : "≈156 tokens admitted";
    evidenceRow.textContent = finished ? "≈642" : "≈156";
  }

  let scrollFrame;
  function renderAceDemoFromScroll() {
    scrollFrame = undefined;
    const topOffset = header?.offsetHeight || 0;
    const rectangle = aceDemo.getBoundingClientRect();
    const travel = aceDemo.offsetHeight - (window.innerHeight - topOffset);
    renderAceDemo(clamp((topOffset - rectangle.top) / Math.max(1, travel)));
  }

  function requestAceDemoFrame() {
    if (scrollFrame === undefined) scrollFrame = requestAnimationFrame(renderAceDemoFromScroll);
  }

  if (reducedMotion.matches) {
    renderAceDemo(1);
  } else {
    addEventListener("scroll", requestAceDemoFrame, { passive: true });
    addEventListener("resize", requestAceDemoFrame);
    renderAceDemoFromScroll();
  }
}

document.querySelectorAll("[data-dashboard-view]").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll("[data-dashboard-view]").forEach((item) => {
      item.setAttribute("aria-pressed", String(item === button));
    });
    document.querySelectorAll("[data-dashboard-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.dashboardPanel !== button.dataset.dashboardView;
    });
  });
});
