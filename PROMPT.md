# Prompt: "4X PROTI" match-3 game

Build a polished, mobile-first match-3 game in the style of Bejeweled for a campaign microsite. The theme comes from the "4X PROTI" logo (11. oktobra). The UI language is **Slovenian**.

## Assets (already in `/public`, all 1000×1000 PNG)

| File | Role |
|---|---|
| `4xproti.png` | Logo (orange `#FF7F00` on black, heavy condensed type). Use it as the title-screen hero and as the **special power tile** (see below). |
| `janez.png` | Tile type 1 (portrait) |
| `logar.png` | Tile type 2 (portrait) |
| `stevo.png` | Tile type 3 (portrait) |
| `vrtovec.png` | Tile type 4 (portrait) |

The four portraits are close-up face photos. Show each one as a circular or rounded-square crop with a thick colored ring so the tile types are easy to tell apart at a glance, even at small sizes. Give each face its own ring color (for example orange, white, cyan and magenta, all on black). Don't modify the source files; do the crop and ring in CSS or on the canvas. Preload all images before the game starts.

## Tech

- Vite + vanilla TypeScript, with no UI framework. Files in `public/` are served from the root (`/janez.png`).
- Render the board in the DOM, with absolutely positioned tiles moved by CSS `transform`, or on a `<canvas>`. Pick whichever gives smoother 60fps animation on a mid-range phone.
- Input: tap a tile and then tap a neighbor, or **swipe/drag** a tile toward a neighbor. Use Pointer Events so mouse and touch share one code path.
- No backend. Store the high score in `localStorage`, wrapped in try/catch.
- Keep the game logic (board model, match detection, gravity, refill) in a pure module, separate from rendering, and add a few unit tests for it with Vitest.

## Core rules

- The board is **7×7**. With only 4 tile types an 8×8 board cascades too much, so 7×7 keeps it readable.
- Swapping two adjacent tiles is only valid if it creates a line of 3 or more. An invalid swap animates over and then snaps back with a small shake.
- Matched tiles clear, the tiles above fall with gravity (ease-out plus a slight bounce), and new tiles drop in from the top. Cascades resolve automatically, and each cascade step raises the combo multiplier.
- When the board is first generated, it must contain no existing matches and at least one valid move.
- If no valid moves remain, show "Ni več potez!" and reshuffle the board with an animation.
- **Hint:** after 5 seconds of inactivity, gently pulse one valid move.

## Special tiles (the "4X" mechanic)

- **Match 4 in a line** → creates a **4X PROTI tile** (the logo) at the swap position. When it is matched or swapped, it clears its whole row **and** column in a cross-shaped blast, with an orange shockwave and screen shake.
- **Match 5, or an L/T shape** → creates a **flaming tile** of the same face, with an orange glow and flickering particles. When cleared, it explodes in a 3×3 area.
- **Swapping two specials together** → combine their effects. For example, two 4X tiles clear 4 full lines: two rows and two columns.

## Modes

1. **Odštevanje (Timed):** 90 seconds. Every 4X PROTI tile you trigger adds +4 s.
2. **Zen:** no timer and no game over, for relaxed play.

## Scoring and feedback

- Base score is 10 points per tile, multiplied by the cascade combo (×1, ×2, ×3 …). Specials score bonus points.
- Show floating score popups at the match location in a bold condensed font.
- Show combo callouts at ×3 and above, scaling from "PROTI!" through "2X PROTI!" and "3X PROTI!" up to **"4X PROTI!!!"**, which triggers full-screen flashes on big chains.
- Show a progress bar or level meter. Each level slightly speeds up animations and adds a background intensity effect.
- Add particle bursts when tiles clear, tinted to each tile's ring color.
- Add sound with the Web Audio API, generated in code with no audio files: a soft swap click, a match "pop" whose pitch rises with each combo step, a deep boom for the 4X blast, and a mute toggle. Audio must start only after the first user interaction.
- Respect `prefers-reduced-motion` by turning off screen shake and flashes and using shorter tweens.

## Visual design

- The look is bold and poster-like, matching the logo. Use a **black background, orange `#FF7F00` accents**, and white text. Use a heavy condensed display font (Anton or Bebas Neue from Google Fonts) for all UI text.
- Put a subtle animated diagonal-stripe or halftone pattern in the background, echoing the slanted strokes in the logo.
- The board sits in a black frame with an orange border. Highlight the selected tile with an orange glow and a slight scale-up.
- **Title screen:** the large `4xproti.png` logo with a slight idle bob. Below it are buttons for "IGRAJ" (timed), "ZEN" and the mute toggle, then the best score.
- **Game-over screen:** final score, best score and a "NOV REKORD!" badge if beaten. Add buttons for "ŠE ENKRAT" and "DELI" (share), which uses the Web Share API and falls back to copying the URL. Show a strip with the logo and the line "11. oktobra — 4X PROTI".
- It must be fully responsive: the board fills the width on phones with a 16px side gutter and no page scrolling. It is centered on desktop with a max width of about 560px. Disable pull-to-refresh and overscroll during play.

## Deliverables

- `index.html`, `src/` (game logic, renderer, input, audio, UI screens), `package.json` with `dev`/`build`/`test` scripts, and a short `README.md`.
- `npm run dev` works immediately, and `npm run build` produces a static `dist/` that can be deployed anywhere.
- No console errors. Play a full timed round yourself to confirm that cascades, specials, the reshuffle and game over all work.
