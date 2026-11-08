export async function openAuthPage(url: string) {
  if (typeof window === "undefined" || !url) return;
  if (window.elpisDesktop?.browser) {
    try {
      await window.elpisDesktop.browser.command("external-url", { url });
      return;
    } catch {
      // Fallback to window.open when the URL is handled by the window opener or test harness.
    }
  }
  window.open(url, "_blank", "noopener");
}
