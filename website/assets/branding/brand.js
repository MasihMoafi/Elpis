(() => {
  const root = document.documentElement;
  let light = false;
  // Each page starts at the site's night default. The switch applies to this
  // visit, so an old saved light choice cannot override the requested default.
  function apply() {
    root.dataset.theme = light ? "elpis-light" : "elpis";
    const icon = document.querySelector('link[rel~="icon"]');
    if (icon) icon.href = `./assets/branding/favicon-amber${light ? "-light" : ""}.svg?v=amber-20261020`;
    document.querySelectorAll("[data-theme-src-light]").forEach(image => {
      image.src = light ? image.dataset.themeSrcLight : image.dataset.themeSrcDark;
    });
    document.querySelectorAll("[data-brand-theme]").forEach(button => {
      button.innerHTML = light ? `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/></svg>` : `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg>`;
      button.setAttribute("aria-label", light ? "Use night theme" : "Use day theme");
      button.setAttribute("aria-pressed", String(light));
    });
  }
  apply();
  function wire() {
    apply();
    document.querySelectorAll("[data-brand-theme]").forEach(button => button.addEventListener("click", () => {
      light = !light;
      apply();
    }));
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire, { once: true });
  else wire();
})();
