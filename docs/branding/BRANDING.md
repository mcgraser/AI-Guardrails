# Bahmüller corporate branding

This build of Privacy Guardrail is styled after the BAHMÜLLER corporate identity
(CI Manual, Version 1, 2018-08-15). Only the visual layer changes. Detection
logic, legal texts, the DFKI attribution and the `NOTICE` and license files are
unchanged. The Bahmüller styling does not imply that DFKI endorses this build.

## Colours (CI 8.2 "Web-Farben")

| Token              | Value     | CI role                                      |
| ------------------ | --------- | -------------------------------------------- |
| `--bm-blue`        | `#007cb0` | Hauptfarbe BLAU: buttons, links, focus, active states |
| `--bm-blue-bright` | `#1999ff` | Blau RGB 25/153/255 (Pantone 285): decorative accents only, such as the tab indicator |
| `--bm-black`       | `#0e0e10` | Headlines SCHWARZ (ink)                      |
| `--bm-grey`        | `#575d5e` | Copy-Text GRAU (muted text)                  |
| `--bm-white`       | `#ffffff` | Basis / Negativ WEISS (cards, logo bar)      |
| `--bm-light-grey`  | `#e1e1e1` | Hintergrund HELLGRAU                         |
| `--bm-dark-grey`   | `#4b4b4b` | Hintergrund GRAU (header strips, dark surfaces) |
| `--bm-logo-grey`   | `#949497` | FLOW/SPAN grey of the vector logo            |

The following values are derived. They are not in the manual and exist only to
meet WCAG AA contrast:

- `#00628c` (`--color-accent-strong`): hover colour, and blue text on the blue tint
- `#e5f2f7` (`--color-accent-soft`): 10 % blue tint
- `#6b7173` (`--color-subtle`): secondary text, at least 4.5:1 on `#f5f5f5`
- `#f5f5f5` (`--color-surface`): page background between white and HELLGRAU

`#1999ff` reaches only about 3:1 against white, so it never carries text. The
status colours (green, amber, red) and the per-entity highlight palette are
functional and are not part of the CI.

All tokens live in `src/shared/styles/tokens.css`. The Shadow DOM copy in
`src/ui/shared/shadow-design-system.ts` mirrors them, and a drift test
(`tests/ui/shadow-design-system.test.ts`) keeps the two in sync.

## Typography (CI 7.1)

- **Roboto** is the CI web font. It is bundled under `src/assets/fonts/roboto-*.woff2`
  (latin subset, weights 300/400/500/700, Apache-2.0).
- **Arial** is the CI office font and serves as the fallback. On third-party chat
  pages the bundled font is not reachable from the injected Shadow DOM, so dialogs
  and toasts there render in Roboto if it is installed and in Arial otherwise.
- JetBrains Mono is still used for code and numeric values, which the CI does not cover.

## Logo (CI 6.1)

`src/assets/brand/` contains the following vector files:

- `bahmueller-logo.svg`: positive version (black wordmark, grey FLOW and SPAN)
- `bahmueller-logo-negative.svg`: negative version for dark grey backgrounds
- `bahmueller-logo-claim.svg`: logo with the claim "Invest in Success"
- `bahmueller-flow.svg`: the FLOW mark on its own

The paths were extracted 1:1 from the vector artwork on page 10 of the CI manual.
`src/shared/brand/bahmueller-logo-paths.ts` holds the same path data. The
`src/shared/brand/BahmuellerLogo.svelte` component renders it inline, so the
logo also works inside closed Shadow Roots.

The UI follows these rules:

- **Position.** The logo sits top right on a white bar in the popup and the
  options page. The review overlay shows the negative version on the dark grey
  header.
- **Protection zone.** The protection zone A is the cap height of the wordmark,
  about 0.66 × the logo height. The surrounding padding keeps it clear.
- **Claim.** The claim is left out at UI sizes. The CI allows this when the size
  does not permit it.
- **Colours.** The logo is never recoloured apart from the CI positive and
  negative treatments.

## Extension icons

The Privacy Guardrail shield icons in `src/assets/icons/` are recoloured from
purple to the CI blue range (`#1999ff` to `#007cb0`). Their shape and states
(active, inactive, dark) are unchanged.
