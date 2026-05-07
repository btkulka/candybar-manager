# Track Lab — UI Kit

Clickable recreation of the Candybar Track Manager desktop app. Uses the global `colors_and_type.css` + a local `kit.css` for structural layout, built with Babel-transpiled JSX in the browser (no build step).

## Screens

- **Library** — KPI grid + warning banner + recent tracks list.
- **Organize** — source/library inputs, start button, live progress with stat dots + current path.
- **Check** — two-source picker (Spotify playlist, CSV) → filterable match table with M3U8 / Rekordbox XML export.
- **Sources** — match list with per-service chips; toggles an embedded "Beatport cart" store panel (demonstrates the `WebContentsView` pattern).
- **USB** — drive info card + KPI grid + format / compatibility breakdowns + issues list.
- **Restore** — wizard with phase list, KPIs (recovered / missing / rate / ETA), live log.

## Files

- `index.html` — loads React + Babel, mounts `<App/>`.
- `kit.css` — layout + component styles (buttons, cards, topbar, track rows, KPI, progress, toasts, embedded panel).
- `Icon.jsx` — inline-SVG icon set (Feather/Lucide lineage) + Logo + service brand glyphs.
- `Chrome.jsx` — Topbar + nav + ServicePill.
- `Primitives.jsx` — `Card`, `Btn`, `Kpi`, `Banner`, `TrackRow`, `ProgressBar`.
- `Pages.jsx` — Library, Organize, Check.
- `Pages2.jsx` — Sources, USB, Restore.
- `App.jsx` — router, toasts.

## Not included

- Real metadata editing drawer (`drawer-overlay`) — only referenced.
- Settings modal, floating console — deferred.
- Full Album Art Fix carousel — deferred.

These exist in the source app (`candybar-manager/index.html` + `src/renderer/*`) and should be ported if a production surface is needed.
