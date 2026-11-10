import { useEffect, type RefObject } from "react";

/** Settings search narrows the open page too, as the ChatGPT app's does (specs/settings.md S8): rows whose title and
 * description miss a search word hide, unless none would remain (then the page matched by its own words, and all stay).
 * Save rows (.settings-actions) always stay. The rows are found in the page, so every page's rows are covered. */
export function useSettingsRowFilter(page: RefObject<HTMLElement | null>, terms: string[]) {
  const key = terms.join(" ");
  useEffect(() => {
    const root = page.current;
    if (!root) return;
    const words = key ? key.split(" ") : [];
    const apply = () => {
      for (const row of root.querySelectorAll<HTMLElement>("[data-search-miss]")) delete row.dataset.searchMiss;
      const panel = root.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])');
      if (!panel || !words.length) return;
      const rows = [...panel.querySelectorAll<HTMLElement>(".settings-row:not(.settings-actions)")];
      const text = (row: HTMLElement) =>
        (row.querySelector(".settings-row-text")?.textContent ?? row.textContent ?? "").toLowerCase();
      const misses = rows.filter(row => !words.every(term => text(row).includes(term)));
      if (misses.length === rows.length) return;
      for (const row of misses) row.dataset.searchMiss = "";
    };
    apply();
    // Pages load their rows after they open; only added or changed content re-applies (not our own attribute writes).
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributeFilter: ["hidden"] });
    return () => {
      observer.disconnect();
      for (const row of root.querySelectorAll<HTMLElement>("[data-search-miss]")) delete row.dataset.searchMiss;
    };
  }, [page, key]);
}
