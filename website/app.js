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
