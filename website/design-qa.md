# Elpis QA — 16 October 2026
Published: eb5179fd1 at https://elpis.masihmoafi.com/, original website project, deployment website-m83681x34 explicitly assigned to the domain.
Repair: authored logo sweeps, rail circle and terminal effects now run under both motion preferences. Scroll phases advance and reverse; new loads start dark. Logo images/home links reject native dragging. Install keeps the footer fill with a clearer border in both themes.
Verified: build/35tests;8 live Chrome motion cases plus8 scroll cases at390/1280px, both themes/preferences. Two natural logo cycles, rail, cursor/highlight/scan, wheel/emulated touch, rewind, Install reachability and dark reloads pass.8 deployment and8 public hashes match the78-file payload. Built-in browser live homepage inspected.
Cause and future verification requirements: [motion incident contract](../docs/specs/website-motion-and-drag.md).

Evidence: /home/masih/Desktop/p/Elpis/prototypes/brand-20261014/review/deployment-receipt.json and motion-complete-20261015/live-eb5179fd1.json; scroll cases are in scroll-recurrence-20261015/live-eb5179fd1.json. Rollback: website-6ufrf26uy.
Earlier audit, not rerun: Lighthouse mobile98/96/100/100; desktop100/96/100/100. Prior SEO/contrast/keyboard evidence remains in review/audit-repairs-20261015/. Narrow proportional-chart targets retain larger equivalent rows.
Limits: isolated Google Chrome and emulated mobile; personal Chromium debugging timed out. No physical device, Safari/Firefox or screen-reader check. No full WCAG claim. Separate unused-project deletion remains unapproved.
