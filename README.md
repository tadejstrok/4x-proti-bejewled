# 4X PROTI — match-3 game

A browser game with no build step and no dependencies. A small Node server (`server/server.js`) serves the game and the global leaderboard, stored in SQLite.

## Run

Needs Node 22.13+ (for the built-in `node:sqlite`).

```bash
node server/server.js        # http://localhost:8080, scores in ./scores.db
node --test server/server.test.js
```

Opening `index.html` straight from disk also works; the leaderboard then falls back to local test mode (this browser only).

## Deploy

`build-and-push.sh` builds `rg.fr-par.scw.cloud/djnd/igraj-4xproti`, tagged with the current commit, pushes it and sets that tag in `kustomize/kustomization.yaml`. Commit first, then:

```bash
SCW_SECRET_TOKEN=... ./build-and-push.sh
kubectl create namespace proti-4x   # first time only
cp kustomize/secrets.example.yaml secrets.yaml   # first time only: set ADMIN_TOKEN, then
kubectl -n proti-4x apply -f secrets.yaml && rm secrets.yaml
kubectl apply -k kustomize/
```

It runs as one pod (`Recreate` strategy) with the database on a 1Gi PersistentVolume at `/data/scores.db`, served at https://4x.lb2.djnd.si.

## Moderation and backups

Open https://4x.lb2.djnd.si/admin#ADMIN_TOKEN to search entries, edit nicknames and messages, or hide entries (unchecking brings them back). Edits go through the same filter as player input and are logged to the pod's stdout. Locally: `ADMIN_TOKEN=some-local-token-123 node server/server.js`, then http://localhost:8080/admin#some-local-token-123.

For anything else, use SQL directly:

```bash
kubectl -n proti-4x exec -it deploy/igraj-4xproti -- sqlite3 /data/scores.db
```

```sql
SELECT id, nickname, message, score, created_at FROM scores ORDER BY created_at DESC LIMIT 20;
UPDATE scores SET hidden = 1 WHERE id = '...';   -- hide (0 to restore)
DELETE FROM scores WHERE id = '...';             -- delete for good
```

Backup: `kubectl -n proti-4x exec deploy/igraj-4xproti -- sqlite3 /data/scores.db ".backup /data/backup.db"`, then `kubectl cp proti-4x/<pod>:/data/backup.db ./backup.db`.

## Files

- `js/logic.js`: board model (matches, specials, gravity, shuffle). Pure logic with no DOM.
- `js/audio.js`: synthesized sound effects (Web Audio).
- `js/main.js`: rendering, input, game flow and screens.
- `js/filter.js`: nickname/message validation and profanity filter.
- `js/leaderboard.js`: leaderboard data layer. Talks to `api/` on the same host (see `LEADERBOARD-API.md`); local test mode when opened from disk.
- `server/server.js`: static files + leaderboard API + SQLite. `server/admin.html` is the moderation page. `server/server.test.js` tests both.
- `kustomize/`, `Dockerfile`, `build-and-push.sh`: deployment.
- `public/`: tile images and logo.

## Rules

- Match 3 or more of the same face.
- **4 in a row** creates the **4X PROTI** tile. Swap it with any neighbor to clear its whole row and column. In timed mode it also adds +4 s.
- **5 in a row or an L/T shape** creates a flame tile, which explodes in a 3×3 area.
- Swapping two specials together combines their effects.

Add `#debug` to the URL to expose `window.__game` for testing.
