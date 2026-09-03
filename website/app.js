const runtimeButtons = [...document.querySelectorAll("[data-runtime]")];
const runtimeLabel = document.querySelector("[data-runtime-label]");
const runtimeDetail = document.querySelector("[data-runtime-detail-output]");
const handoffState = document.querySelector("[data-handoff-state]");
const ledgerRows = [...document.querySelectorAll("[data-ledger-row]")];

runtimeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.classList.contains("is-active")) return;

    runtimeButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    handoffState.textContent = "handoff…";
    handoffState.classList.add("is-switching");
    ledgerRows.forEach((row, index) => {
      row.style.setProperty("--delay", `${index * 55}ms`);
      row.classList.remove("is-retained");
    });

    window.setTimeout(() => {
      runtimeLabel.textContent = button.dataset.runtime;
      runtimeDetail.textContent = button.dataset.runtimeDescription;
      handoffState.textContent = "connected";
      handoffState.classList.remove("is-switching");
      ledgerRows.forEach((row) => row.classList.add("is-retained"));
    }, 420);
  });
});

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

const menuButton = document.querySelector("[data-menu-button]");
const header = document.querySelector("[data-header]");

menuButton?.addEventListener("click", () => {
  const open = header.classList.toggle("menu-open");
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
});

header?.querySelectorAll("nav a").forEach((link) => {
  link.addEventListener("click", () => {
    header.classList.remove("menu-open");
    menuButton?.setAttribute("aria-expanded", "false");
  });
});

/* -------------------------------------------------------------
 * Hero Brand Visual Engine (Smooth TrueColor Solar Flare Wave)
 * ----------------------------------------------------------- */
const SOLAR_PALETTE = {
  top: [255, 235, 50],   // Canary Sun Yellow
  mid: [255, 145, 0],    // Warm Golden Amber
  bot: [230, 45, 0],     // Deep Tangerine
  flare: [255, 245, 100],
};

const LOGO_LINES = [
  "████████████   ██            ███████████     ████    ████████████ ",
  "████████████   ██            ████████████    ████    ████████████ ",
  "██             ██            ██        ███   ████    ██           ",
  "██             ██            ██        ███   ████    ██           ",
  "██████████     ██            ████████████    ████    ████████████ ",
  "██             ██            ███████████     ████              ██ ",
  "██             ██            ██              ████              ██ ",
  "████████████   ███████████   ██              ████    ████████████ ",
  "████████████   ███████████   ██              ████    ████████████ ",
];

const bannerEl = document.querySelector("[data-theme-banner]");

if (bannerEl) {
  const animStartTime = performance.now();
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const spanGrid = [];
  bannerEl.textContent = "";

  LOGO_LINES.forEach((line) => {
    const rowSpans = [];
    const lineEl = document.createElement("div");
    lineEl.className = "hero-banner-line";

    for (let x = 0; x < line.length; x++) {
      const char = line[x];
      const span = document.createElement("span");
      span.textContent = char;
      if (char !== " ") {
        span.className = "theme-char";
        span.style.color = "rgb(255, 145, 0)";
      }
      lineEl.appendChild(span);
      rowSpans.push(span);
    }
    bannerEl.appendChild(lineEl);
    spanGrid.push(rowSpans);
  });

  function interpolateColor(yNorm, heatOffset = 0) {
    const t = Math.max(0, Math.min(1, 1 - yNorm + heatOffset));
    let c1, c2, subT;
    if (t > 0.5) {
      subT = (t - 0.5) * 2;
      c1 = SOLAR_PALETTE.mid;
      c2 = SOLAR_PALETTE.top;
    } else {
      subT = t * 2;
      c1 = SOLAR_PALETTE.bot;
      c2 = SOLAR_PALETTE.mid;
    }
    const r = Math.round(c1[0] + (c2[0] - c1[0]) * subT);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * subT);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * subT);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function renderFrame(now) {
    if (!bannerEl) return;
    try {
      const currentTime = typeof now === "number" ? now : performance.now();
      const elapsed = Math.max(0, (currentTime - animStartTime) / 1000);
      const height = LOGO_LINES.length;
      const width = LOGO_LINES[0].length;

      // Repeating radiant sweep cycle (sweeps across for 1.2s every 4.0s)
      const CYCLE_DURATION = 4.0;
      const cycleTime = elapsed % CYCLE_DURATION;
      const isSweeping = cycleTime < 1.2;
      const sweepX = isSweeping ? (cycleTime / 1.2) * (width + 10) - 4 : -999;
      // Calm, comfortable breathing wave speed
      const phase = elapsed * 2.0;

      for (let y = 0; y < height; y++) {
        const yNorm = y / (height - 1);
        const row = spanGrid[y];

        for (let x = 0; x < width; x++) {
          if (LOGO_LINES[y][x] === " ") continue;
          const span = row[x];

          if (isSweeping) {
            const dist = Math.abs(x - sweepX);
            if (dist < 3.5) {
              const fl = SOLAR_PALETTE.flare;
              span.style.color = `rgb(${fl[0]}, ${fl[1]}, ${fl[2]})`;
              span.style.textShadow = `0 0 12px rgba(${fl[0]}, ${fl[1]}, ${fl[2]}, 0.8)`;
              continue;
            }
          }

          const ripple = prefersReducedMotion ? 0 : 0.22 * Math.sin(x * 0.22 - phase + y * 0.32);
          span.style.color = interpolateColor(yNorm, ripple);
          span.style.textShadow = "none";
        }
      }
    } catch (err) {
      console.error("Frame render error:", err);
    }

    if (!prefersReducedMotion) {
      requestAnimationFrame(renderFrame);
    }
  }

  renderFrame(performance.now());
  if (!prefersReducedMotion) {
    requestAnimationFrame(renderFrame);
  }
}

