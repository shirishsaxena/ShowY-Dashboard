# Dashboard styles

Stylesheets are loaded with explicit links in `../index.html`, in cascade order:

1. `../app.css` — themes, resets, global utilities, boot screen, background.
2. `shell.css` — top bar, brand, search, header actions.
3. `controls.css` — buttons, focus styles, server switcher controls.
4. `services.css` — favourites, server header, chips, groups, cards, icons, status.
5. `loading.css` — loading indicators and stale-data presentation.
6. `layouts.css` — compact/list variants and unlisted containers.
7. `dialogs.css` — shared dialog structure, forms, icon picker, colour controls.
8. `settings.css` — settings-specific styles and responsive adjustments.
9. `popovers.css` — QR/confirmation dialogs, segmented controls, menus, clipboard, notes.
10. `links.css` — standalone dashboard links.
11. `monitoring.css` — host metrics, availability, server info, gauges, container usage.
12. `states.css` — drag-and-drop, edit toolbar, hidden cards, lock screen, toasts.
13. `responsive.css` — final mobile, touch-target, and reduced-motion overrides.

This initial split preserves the original rule order exactly. Some shared controls
remain next to their original feature to avoid changing cascade precedence.
Keep global responsive overrides last; check precedence before moving rules
between files. Do not introduce CSS imports: explicit links allow parallel loading.

When adding a stylesheet, add its link to `../index.html` and its URL to the shell
asset list in `../sw.js`. Bump the service-worker cache version when changing the
offline shell. CSS tests read all linked stylesheets in page order; the worker
tests also verify that every linked stylesheet is precached.
