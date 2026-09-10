const prototypeTabs = [...document.querySelectorAll("[data-view]")];
const prototypes = [...document.querySelectorAll("[data-prototype]")];
const announcement = document.querySelector("#prototype-announcement");
const prototypeNames = {
  cockpit: "Goal cockpit",
  continuity: "Continuity spine",
  workbench: "Ledger workbench",
};
const prototypeAxes = {
  cockpit: "Live turn · minimal structural change",
  continuity: "Session handoff · dedicated inspect mode",
  workbench: "Context control · full-screen /context",
};
const prototypeAxis = document.querySelector("[data-prototype-axis]");

function setActivePrototype(view) {
  if (!prototypeNames[view]) return;

  prototypeTabs.forEach((tab) => {
    const active = tab.dataset.view === view;
    tab.classList.toggle("tab-active", active);
    tab.setAttribute("aria-selected", String(active));
  });

  prototypes.forEach((prototype) => {
    prototype.hidden = prototype.dataset.prototype !== view;
  });

  prototypeAxis.textContent = prototypeAxes[view];
  announcement.textContent = `${prototypeNames[view]} prototype selected.`;
  document.title = `${prototypeNames[view]} · Elpis TUI code prototypes`;
}

function choosePrototype(view) {
  setActivePrototype(view);
  if (location.hash !== `#${view}`) history.replaceState(null, "", `#${view}`);
}

prototypeTabs.forEach((tab) => tab.addEventListener("click", () => choosePrototype(tab.dataset.view)));
window.addEventListener("hashchange", () => setActivePrototype(location.hash.slice(1)));

const initialView = location.hash.slice(1);
setActivePrototype(prototypeNames[initialView] ? initialView : "cockpit");

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
  const view = { "1": "cockpit", "2": "continuity", "3": "workbench" }[event.key];
  if (view) choosePrototype(view);
});

const admissionRows = [...document.querySelectorAll("[data-admission-toggle]")];
const contextTotal = document.querySelector("[data-context-total]");

function updateContextTotal() {
  const total = admissionRows.reduce((sum, row) => {
    return row.getAttribute("aria-pressed") === "true" ? sum + Number(row.dataset.tokens) : sum;
  }, 0);
  contextTotal.textContent = `Total ≈${total.toFixed(1)}k admitted`;
}

admissionRows.forEach((row) => {
  row.addEventListener("click", () => {
    const included = row.getAttribute("aria-pressed") !== "true";
    row.setAttribute("aria-pressed", String(included));
    row.querySelector(":scope > span").textContent = included ? "[x]" : "[ ]";
    row.querySelector(".admission-state").textContent = included ? "INCLUDED" : "EXCLUDED";
    updateContextTotal();
  });
});

const continuityEvents = [...document.querySelectorAll("[data-continuity-event]")];
const continuityTitle = document.querySelector("[data-continuity-title]");
const continuitySummary = document.querySelector("[data-continuity-summary]");
const continuitySource = document.querySelector("[data-continuity-source]");

function selectContinuityEvent(eventButton) {
  continuityEvents.forEach((button) => {
    const active = button === eventButton;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
  continuityTitle.textContent = eventButton.dataset.title.toUpperCase();
  continuitySummary.textContent = eventButton.dataset.summary;
  continuitySource.textContent = eventButton.dataset.source;
}

continuityEvents.forEach((button) => button.addEventListener("click", () => selectContinuityEvent(button)));

const workbenchModes = [...document.querySelectorAll("[data-workbench-mode]")];
const workbenchPanels = [...document.querySelectorAll("[data-workbench-panel]")];

function setWorkbenchMode(mode) {
  workbenchModes.forEach((button) => button.classList.toggle("menu-active", button.dataset.workbenchMode === mode));
  workbenchPanels.forEach((panel) => {
    panel.hidden = panel.dataset.workbenchPanel !== mode;
  });
}

workbenchModes.forEach((button) => button.addEventListener("click", () => setWorkbenchMode(button.dataset.workbenchMode)));

const sourceRows = [...document.querySelectorAll("[data-source-row]")];
const sourceFields = {
  name: document.querySelector("[data-source-name]"),
  kind: document.querySelector("[data-source-kind]"),
  state: document.querySelector("[data-source-state]"),
  tokens: document.querySelector("[data-source-tokens]"),
  provenance: document.querySelector("[data-source-provenance]"),
  why: document.querySelector("[data-source-why]"),
};
let selectedSource = sourceRows[0];

function selectSource(row) {
  selectedSource = row;
  sourceRows.forEach((item) => item.classList.toggle("source-selected", item === row));
  sourceFields.name.textContent = row.dataset.source;
  sourceFields.kind.textContent = row.dataset.kind;
  sourceFields.state.textContent = row.dataset.state;
  sourceFields.tokens.textContent = row.dataset.tokens;
  sourceFields.provenance.textContent = row.dataset.provenance;
  sourceFields.why.textContent = row.dataset.why;
}

sourceRows.forEach((row) => {
  row.addEventListener("click", () => selectSource(row));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectSource(row);
    }
  });
});

function setSourceAdmission(state) {
  if (!selectedSource) return;
  selectedSource.dataset.state = state;
  const stateCell = selectedSource.querySelector(".source-state");
  stateCell.textContent = state;
  stateCell.classList.toggle("included", state === "INCLUDED");
  stateCell.classList.toggle("excluded", state === "EXCLUDED");
  sourceFields.state.textContent = state;
  sourceFields.why.textContent = `${selectedSource.dataset.why} Staged state: ${state} for the next request.`;
}

document.querySelectorAll("[data-source-action]").forEach((button) => {
  button.addEventListener("click", () => setSourceAdmission(button.dataset.sourceAction === "include" ? "INCLUDED" : "EXCLUDED"));
});

document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
  const workbenchVisible = !document.querySelector('[data-prototype="workbench"]').hidden;
  const contextVisible = !document.querySelector('[data-workbench-panel="context"]').hidden;
  if (!workbenchVisible || !contextVisible) return;
  if (event.key === "+") setSourceAdmission("INCLUDED");
  if (event.key === "-") setSourceAdmission("EXCLUDED");
});
