# 4X PROTI — match-3 game

A static browser game with no build step and no dependencies.

## Run

Open `index.html` directly in a browser, or serve the folder:

```bash
python3 -m http.server 5173
```

Then go to http://localhost:5173.

## Deploy

Upload the whole folder (`index.html`, `style.css`, `js/`, `public/`) to any static host (Netlify, Vercel, GitHub Pages, or plain FTP).

## Files

- `js/logic.js`: board model (matches, specials, gravity, shuffle). Pure logic with no DOM.
- `js/audio.js`: synthesized sound effects (Web Audio).
- `js/main.js`: rendering, input, game flow and screens.
- `js/filter.js`: nickname/message validation and profanity filter.
- `js/leaderboard.js`: leaderboard data layer. Set `API_URL` to connect a backend (see `LEADERBOARD-API.md`); empty means local test mode.
- `public/`: tile images and logo.

## Rules

- Match 3 or more of the same face.
- **4 in a row** creates the **4X PROTI** tile. Swap it with any neighbor to clear its whole row and column. In timed mode it also adds +4 s.
- **5 in a row or an L/T shape** creates a flame tile, which explodes in a 3×3 area.
- Swapping two specials together combines their effects.

Add `#debug` to the URL to expose `window.__game` for testing.
