# Candybar / Track Lab — Design System

A design system for **Candybar Track Manager** (in-app brand: **Track Lab**) — an Electron-based DJ health and diagnostics toolkit. It's a local desktop app that sits next to Rekordbox, Beatport, and Qobuz and helps DJs keep their library clean, complete, and USB-ready.

## What the product does

- **Library** — Browse + health dashboard. Shows track counts, issue chips (missing tags, wrong format, missing art), a split-column browser (by artist/album/genre), connected device detection, and an inspector panel.
- **Organize by Artist** — Reads audio metadata from a source bin and moves files into artist folders.
- **Check (Missing Track Check)** — Three-lane wizard: pick a source (CSV or Spotify playlist) → scan library → review Missing / Found / Uncertain matches. Exports M3U8 / Rekordbox XML.
- **Sources** — Given a track list, searches Qobuz + Beatport for lossless purchase sources. Result triaging (All / Qobuz / Beatport / Not Found), add to cart, open embedded store panel.
- **USB** — Pre-gig compatibility scan for Pioneer XDJ-RX3: volume filesystem check, KPI grid (healthy / warnings / errors), format breakdown, compatibility matrix.
- **Restore** — Multi-stage wizard that rebuilds a lost Rekordbox library from exported XML, pulling sources from Qobuz purchase history, Beatport, and SoundCloud.

Embedded store windows (for carts and OAuth logins against Beatport/Qobuz) are a first-class pattern — the app slides in a Chromium `WebContentsView` panel and frames it with native chrome.

## Sources

- **Codebase** (read-only, mounted): `candybar-manager/`
  - Electron + TypeScript + Vite. Renderer is split across `src/renderer/*.ts`.
  - Single-file `index.html` holds the whole app shell (all pages, modals, drawers).
  - Global styles: `styles.css` (8.4k lines — the source of truth for the visual system).

No Figma link, no slide deck, no marketing site provided. This system is extracted purely from the shipping Electron app.

## Index

```
README.md                   this file
colors_and_type.css         CSS custom properties — colors, type, spacing, motion
SKILL.md                    Agent-skill manifest (cross-compatible with Claude Code)
assets/                     Logos, brand marks, service glyphs, hero gradient
preview/                    Registered design-system cards (colors, type, components, brand)
ui_kits/
  track-lab/                The desktop app — index.html + JSX recreations of key screens
```

## Content Fundamentals

**Voice.** Candybar talks to DJs the way a senior tech would talk to another senior tech at the back of the club: low-key, precise, no cheerleading. You're assumed competent. Copy is short, declarative, and action-oriented.

- **Person.** Mostly second-person where action is needed ("Choose a library root"), impersonal where it's a report ("0 warnings · 3 errors"). Never "we" or "us" — the app is a tool, not a person.
- **Casing.** Sentence case everywhere — headers, buttons, labels. Only product nouns ("Rekordbox", "Beatport", "Qobuz", "Track Lab") and format acronyms ("AIFF", "CSV", "M3U8", "XDJ-RX3") are capitalized.
- **Verbs on buttons.** Short imperatives: `Scan`, `Organize`, `Fix`, `Convert to AIFF`, `Add to Carts`, `Retry failed`, `Open stage folder`, `New restore`. Rarely more than three words.
- **Tooltips carry the detail.** Button labels stay tight; `data-tooltip` holds the sentence ("Move all scanned tracks into your library", "Mark all tracks missing artist tags as ignored"). Tooltips are full sentences, no period.
- **Numbers are data.** "0 tracks · 0 healthy · 3 warnings · 0 errors". Status strings read like a log line, not marketing copy.
- **Empty states are factual.** "All tracks are accounted for." / "No matched tracks yet." / "No volumes detected. Click Refresh to scan for connected drives." No apology, no exclamation.
- **Errors name the problem.** "Some tracks are missing artist tags. Edit them or ignore to proceed." — state the issue, then the two resolutions.
- **No emoji** in copy. The one exception is a single `✓` on a Connected badge and the complete-icon `✓` in the album-art fix flow; those read as glyphs, not emoji.
- **Tone examples (verbatim from the app):**
  - "Moves tracks from a source bin into artist folders based on metadata."
  - "Check a USB drive for Pioneer XDJ-RX3 compatibility before a gig."
  - "DJ-focused electronic music store. Sign in to search, cart, and redownload your Beatport purchases — add multiple accounts if you have separate buyer profiles."
  - "Hi-res studio-quality downloads. Sign in to one or more Qobuz accounts to search, cart, and restore from your purchase history."

## Visual Foundations

**Overall vibe.** A diagnostic tool that looks like a well-lit studio at 3am — deep near-black background, a single aquamarine accent, and a lot of clean typography. Zero decoration. Information density is high but calm.

### Color

- **Palette is monochrome + one accent.** Four surfaces from `#05090c` → `#141d24`, three text greys, and `#7fffd4` aquamarine as the only brand color. The only *other* colors that appear on screen are the four service brands (Spotify green, SoundCloud orange, Qobuz blue, Beatport lime) and the three semantic statuses (green / amber / red), used sparingly and only to convey state.
- **Ambient glow.** The main content area gets two very low-opacity radial gradients (aquamarine at 6% and 3% alpha) — a background wash that never competes with content.
- **No gradient buttons.** Flat fills only. The only gradients that appear in UI are subtle `radial-gradient(... transparent)` washes behind service pills when connected.

### Type

- **Inter** at 400/500/600/700. JetBrains Mono (or SF Mono fallback) for the console, file paths, format acronyms, and anywhere a number-heavy log is rendered. Root font-size is **14px**; compact by design.
- Negative letter-spacing (`-0.02em`) on headers. Headers are small — `1.35rem` for page H2, `1rem` for card H3. The app does not shout.
- Uppercase is reserved for tiny eyebrows and status labels (`text-transform: uppercase` + `letter-spacing: 0.08em`).

### Spacing + layout

- **4px grid.** `--space-xs`…`--space-4xl` (4 / 8 / 12 / 16 / 20 / 24 / 32 / 48). Components use semantic tokens (`--pad-card-x`, `--gap-stack`).
- **Content column.** Most pages center at `max-width: 820px`. The Library page goes full-bleed with its own internal layout (split panel + list + inspector).
- **Sticky topbar, 40px tall.** App is drag-region except for inputs (`-webkit-app-region: drag`). One brand mark, a horizontal nav, a centered mini-player, a cluster of service status pills, and settings on the right.

### Surfaces, borders, cards

- **Cards** are `--bg-surface` (`#0f161c`) with a 1px `rgba(255,255,255,.06)` border and `--radius-lg` (16px). Hover raises the border to `rgba(255,255,255,.10)`. No shadow on idle cards.
- **Inputs / elevated rows** use `--bg-elevated` (`#0a1014`) with the subtle border.
- **Shadows** exist but are reserved: toasts, modals, the sidebar player art, and the drawer. The primary CTA gets a `0 0 20px rgba(127,255,212,0.2)` glow that is explicitly branded — that's the only place a glow is ever used on a button.
- **Radii.** 8 / 12 / 16 / 20 — `sm` for chips/badges, `md` for inputs/buttons, `lg` for cards, `xl` for modals.

### Iconography

- **Inline 24×24 SVG with `stroke="currentColor"`, `stroke-width="2"`, `stroke-linecap="round"`, `stroke-linejoin="round"`.** This is the only icon system. Stroked, 2px, rounded joins. The shapes are a close match for Feather / Lucide (see ICONOGRAPHY).
- Service brand glyphs (Spotify, SoundCloud, Qobuz, Beatport) are *filled* not stroked, using `fill="currentColor"` and each brand's color.
- **No emoji, no icon font, no png icons**. The single exception is a `✓` character on the "Connected" badge.

### Motion

- **Ease out** for most transitions: `cubic-bezier(0.16, 1, 0.3, 1)`. Typical durations 120–200ms.
- **Spring** (`cubic-bezier(0.34, 1.56, 0.64, 1)`) is used selectively: modal entry, logo hover, drop-zone bounce, service pill pop-in. 250–300ms.
- **Service pills pulse** when connected (2.4s heartbeat) and blink when disconnected (2.8s fade). Checking state spins the icon and pulses the dot.
- **Primary CTA** lifts 1px on hover and brightens its glow. Active state snaps back.
- **No page transitions.** Route change is a subtle 200ms `fadeIn` with 8px translateY. No sliding, no crossfades.

### Hover / press states

- **Ghost button:** transparent → `bg-elevated`, text muted → primary. No scale.
- **Secondary button:** `bg-elevated` → `bg-surface-hover`, border subtle → accent.
- **Primary button:** brightens to `--accent-dim`, raises glow opacity, `translateY(-1px)`. Active: `translateY(0)`.
- **Cards and track rows:** border subtle → default. Optional background shift.
- **Service pills:** `translateY(-1px)` on hover, border brightens. Full opacity on hover (they idle at 0.6).
- **Icon buttons:** text muted → primary, background transparent → `bg-elevated`.

### Transparency, blur, embedded panels

- **`backdrop-filter: blur(8px)`** on service pills and modal overlays. The app uses blur specifically where it sits over a semi-transparent surface.
- **Embedded store panel** (for Beatport/Qobuz carts + OAuth) uses a draggable vertical resize handle and a native-looking toolbar (`Back`, `Forward`, label, `×`). The store web content fills the rest of the viewport. This is the pattern for any third-party OAuth or cart integration.
- **Drawer** slides in from the right, 480px wide, `-8px 0 40px rgba(0,0,0,0.5)` shadow on its left edge. Used for the ID3 tag editor.

### Imagery

No photography, no illustration. The only raster content in the app is user-supplied: album art (square, rounded 8px, object-fit cover, zoomable), and screenshots from embedded store webviews. Treat any stock imagery as a placeholder to be replaced.

## Iconography

- **Source:** inline SVG, hand-drawn in the HTML, 24×24 viewBox.
- **Stroke-based** (`stroke="currentColor"` + `stroke-width="2"` + rounded caps/joins). Closely matches [Feather](https://feathericons.com/) and [Lucide](https://lucide.dev/). We ship a Lucide-compatible subset in `assets/icons.svg` for quick reuse, plus the four service-brand glyphs as standalone SVGs.
- **Fill-based brand glyphs** for Spotify, SoundCloud, Qobuz, Beatport (tinted with each brand's color).
- **Emoji:** none in copy; never.
- **Unicode** chars used as icons: `✓` (connected badge, album-art fix complete), `⋮` (more-options), `‹` / `›` (carousel nav). All other navigation / state uses SVG.
- **Substitution:** if you need an icon Candybar doesn't ship, use Lucide at the same stroke weight. Document any substitutions in PRs.

See `preview/08-icons.html` and `preview/09-service-glyphs.html` for visual reference.

## Caveats & not-yet-modeled

This system is faithful to what ships in `candybar-manager/`, but a few surfaces were deliberately deferred because they're deeper flows or edge UI:

- **Metadata editing drawer** — the right-side `.drawer-overlay` that opens when a track is inspected/edited. Tokens exist; no `preview/` card yet.
- **Album Art Fix carousel** — the multi-candidate picker with per-candidate score chips. Referenced in code; not in the UI kit.
- **Settings modal** — credentials for Beatport / Qobuz / Spotify, device options. Out of scope for V1.
- **Floating console / log viewer** — debug surface. Styles exist in `styles.css`; not extracted.
- **Printable reports** — `@media print` rules exist but aren't covered by the preview cards.

If you need any of these, the shipping source is the truth: `candybar-manager/index.html` + `candybar-manager/src/renderer/*`. Port the markup, then tokenize against `colors_and_type.css` — don't re-invent values.

## Versioning

This is v1 of the system. Any change to a color token, font, spacing unit, or icon rule should bump the file's `subtitle` in the asset manifest and be noted here. Changes to `colors_and_type.css` are breaking for downstream artifacts.
