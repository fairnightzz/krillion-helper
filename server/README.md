# Answer-cache server

Storage-only answer cache for krillion-helper. The extension keeps
calling Anthropic on a cache miss and stores the result here; the
server never sees an API key.

## Run

```sh
# Docker (recommended: deployable anywhere, data survives restarts)
KCH_TOKEN=choose-a-secret docker compose up --build -d

# Or directly with Node 22.5+ (needs the flag until Node 24):
KCH_TOKEN=choose-a-secret PORT=8787 DATA_DIR=./data \
  node --experimental-sqlite server.js
```

Data lives in SQLite at `$DATA_DIR/kch.sqlite` (a Docker volume at
`./data` with compose). `npm --prefix . test` runs the server tests
with the same flag.

## Extension settings

- **Cache server URL**: `http://localhost:8787` by default; blank
  disables the cache (every request goes to Claude directly).
- **Cache server token**: sent as `X-KCH-Token`. Leave the server
  `KCH_TOKEN` unset only on a trusted local network: with it set,
  all `/api/*` routes require it. The token is stored only in
  `chrome.storage.local`, never in the popup's localStorage mirror.

## How caching works

- Cache key: normalized prompt + word style + game (party/solo).
  Prompt normalization lowercases, collapses whitespace, and strips
  trailing punctuation, so the same question asked two ways hits
  one entry.
- A lookup returns stored lists only if the requested section still
  has an answer the caller has not already used; an exhausted
  section counts as a miss, so regeneration cannot spin on dead
  lists. Any cache error is a miss: the extension falls back to
  Anthropic directly.
- Stores merge by answer key and never delete: re-storing the same
  answers is a no-op, and manually removed answers stay removed
  across regenerations.

## Curation from play

Outcomes arrive as the extension plays. Only game outcomes are
reported, never keystrokes. For other players, only what every
client can see is used: a shown answer counts as accepted, and a
rejected bubble counts as a duplicate only when that word was
already played this round — the game shows no reason for other
players' rejections (the "already said" / "no echo" reason arrives
only for your own answer), so a rejected bubble for an unseen word
is never reported as wrong:

- `accepted` — the attempt passed the turn (party) or reached the
  feedback phase (solo) without a rejection.
- `duplicate` — the banner said "already said": the answer IS in the
  game's set and was only repeated. Duplicates confirm an answer.
- `rejected` — the banner said "no echo" (or gave no usable reason):
  the answer is not in the game's set.

An answer auto-hides from served lists after a **single**
rejection with zero acceptances and zero duplicates: the game's
verdict is deterministic, and the banner is local to the
submitting player, so one report is already attributed. One
duplicate or one acceptance vetoes auto-hiding outright, so
conflicting evidence never removes an answer on its own. Manual
deletion always wins and survives regeneration.

## API

All `/api/*` routes require `X-KCH-Token` when `KCH_TOKEN` is set
(`GET /health` is exempt).

```sh
# Health
curl localhost:8787/health

# Cached answers (404 when nothing usable is stored)
curl "localhost:8787/api/answers?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true" -H "X-KCH-Token: $KCH_TOKEN"

# Store a generated result (what the extension does on a miss)
curl -X POST localhost:8787/api/answers -H "X-KCH-Token: $KCH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"Name a noodle dish","wordStyle":"rare","party":true,"rare":["Udon"],"common":["Pho"],"model":"claude-opus-5-5"}'

# Report an outcome
curl -X POST localhost:8787/api/feedback -H "X-KCH-Token: $KCH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"Name a noodle dish","wordStyle":"rare","party":true,"text":"Udon","outcome":"rejected","source":"banner"}'

# Inspect prompts, per-answer stats, and curate by hand
curl "localhost:8787/api/prompts" -H "X-KCH-Token: $KCH_TOKEN"
curl "localhost:8787/api/stats?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true" -H "X-KCH-Token: $KCH_TOKEN"
curl -X DELETE "localhost:8787/api/answers?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true&text=Udon" -H "X-KCH-Token: $KCH_TOKEN"
curl -X DELETE "localhost:8787/api/prompts?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true" -H "X-KCH-Token: $KCH_TOKEN"
```
