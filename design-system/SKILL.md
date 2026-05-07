---
name: candybar-design
description: Use this skill to generate well-branded interfaces and assets for Candybar / Track Lab — a DJ health and diagnostics desktop toolkit. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping. Dark-mode, aquamarine accent, stroke-only iconography, compact Inter typography.
user-invocable: true
---

Read the `README.md` file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Quick map

- `colors_and_type.css` — all design tokens as CSS vars. Always import this first.
- `README.md` — voice, casing, visual foundations, iconography rules. Read before writing copy.
- `assets/` — logo, wordmark, service brand glyphs (Spotify / SoundCloud / Qobuz / Beatport).
- `preview/*.html` — registered design-system cards; read these for concrete component markup you can paste.
- `ui_kits/track-lab/` — clickable prototype + reusable JSX components (Icon, Chrome, Primitives, Pages).

## Non-negotiables

- Dark surfaces only. Aquamarine `#7fffd4` is the only brand color; everything else is near-black, grey, or a service/status color used sparingly.
- Inter 400/500/600/700 + JetBrains Mono. 14px root. Tight tracking on headers.
- Inline SVG icons, 24×24, stroke 2, rounded caps/joins. No emoji, no icon fonts.
- No gradient buttons. Flat fills. The one sanctioned "glow" is on the primary CTA.
- Sentence case. Short declarative copy. Tooltips carry the detail.
