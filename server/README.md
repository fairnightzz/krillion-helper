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

## Dashboard

Open `/dashboard` on the server (for example
`https://krillion.zhehaizhang.com/dashboard`; `/` redirects there)
and enter the `KCH_TOKEN`. The browser remembers the token until
you click Sign out. The page shows:

- Totals: how many questions you have run into (and how many
  came up more than once), stored answers (rare / common / solo),
  cache hit rate, outcomes from play, krillion finds, and how
  many answers are hidden.
- Cache lookups per day (hits vs misses; every lookup counts,
  including the extra ones when a list runs out mid-round, so cache
  hits can exceed Seen) and the latest
  krillion-tier sightings, yours tagged "you". A word seen again
  after it was already in the rare list is tagged "repeat"; the
  Krillion finds tile counts distinct answers.
- Every question, searchable, filterable, and sortable, with a
  **Seen** count: how many times that question has come up. Every
  cache lookup is a sighting, but lookups for the same question
  within 90 seconds count once, so a refetch in the same round does
  not inflate it. Seen counts live in their own `encounters` table
  and are never pruned; a database from before this table was added
  fills it once from the event log on startup. Click a
  question to see its answers with their accepted / duplicate /
  rejected counts; hidden answers are struck through and krillion
  finds are marked ✦.

The page holds no data itself: it reads everything through
`GET /api/overview` and `GET /api/stats`, which need the token.
Hit, miss, krillion, and daily numbers (not Seen) come from the event log, so
they cover its newest 100,000 events.

## Extension settings

- **Cache server URL**: `https://krillion.zhehaizhang.com` by default (`http://localhost:8787`
  for a server on your own machine); blank
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

Opponent answers are otherwise never learned — except one narrow
case. An accepted answer whose own speech bubble carries
`--cc: var(--tier-krillion, …)` was a one-in-a-krillion answer, so
the extension promotes it into the rare list, nestled at index 4
(5th place; shorter lists append at the end, still in the top 5).
This covers opponents' answers and your own (your own bubble is
recognised from what you submitted that round, whether the
extension typed it or you did). The game sometimes shows a
different form of your answer ("donut" as "doughnut", "zorilla" as
"striped polecat"). Party play is turn-based, so between your
submission and the turn passing nobody else can answer: the first
new accepted bubble in that window is yours, whatever it says. A
rejection ends that window. Your own `bubble_seen` events carry
`sent` (what you typed, when it differs) and `sameSeat` (whether
the bubble is the element that showed your live draft), a
diagnostic for identifying your seat directly.

When an answer ends a category, the next question appears at once
while that answer's bubble is still on screen or about to show.
Bubbles already on screen at the change, any bubble arriving
within 1 second of it (nobody answers a new question that fast),
and your own answer's bubble arriving within 2.5 seconds of it are
credited to the question that just ended, never to the new one. The promotion records who played
it (`source`: `own` or `other`), and the dashboard tags your finds.
Promotion copies rather than moves: a word already on that
prompt's common bench keeps its common entry, but is served only
once, from the rare list. Promotions always land in the "Rare
first" (`wordStyle=rare`) party lists, so "Common only" play never
sees them.
No other tier is promoted, and seat yellowness never counts: it is
the spare-life flash, not a tier signal.

## Event log

Every cache request and every game event is logged twice: once as a
row in the `events` table (SQLite, newest 100,000 kept) and once as
a single JSON line on stdout, so the same history is queryable later
and tail-able live with `docker logs -f krillion-helper-cache`. The
extension also prints each game event to the page and worker
consoles prefixed `[kch-log]`. Logging never blocks a request or a
turn. Individual keystrokes are never logged, only typing
start/done per candidate.

Server-side kinds: `cache_hit`, `cache_miss` (detail `reason`:
`no_entry` or `exhausted`), `cache_store`, `feedback`, `promote`,
`delete_answer`, `delete_prompt`, `unauthorized`, `error`.
Game-event kinds relayed by the extension: `fetch_result`
(detail `cached`, counts, and `model`), `fetch_error`,
`typing_start`, `typing_done`, `typing_aborted`,
`submit_attempt`, `submit_blocked`, `solo_submit`, `bubble_seen`
(detail `tier` and `outcome`, plus `own: true` for your own answers), `outcome_reported`, `promote_sent`,
`leftover_cleared`.

```sh
# Newest 100 events, or filtered by kind, prompt substring, or text
curl "localhost:8787/api/events?limit=100" -H "X-KCH-Token: $KCH_TOKEN"
curl "localhost:8787/api/events?kind=cache_hit&limit=50" -H "X-KCH-Token: $KCH_TOKEN"
curl "localhost:8787/api/events?prompt=Name%20a%20type%20of%20salt" -H "X-KCH-Token: $KCH_TOKEN"
curl "localhost:8787/api/events?kind=bubble_seen&text=Zork" -H "X-KCH-Token: $KCH_TOKEN"
```

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

# Promote a krillion-tier answer into the rare list at index 4 (other tiers: 400); source is own|other
curl -X POST localhost:8787/api/promote -H "X-KCH-Token: $KCH_TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"Name a noodle dish","text":"Udon","tier":"krillion","source":"other"}'

# Whole-cache summary (what the dashboard reads)
curl "localhost:8787/api/overview" -H "X-KCH-Token: $KCH_TOKEN"

# Read the event log (newest first; see "Event log" above)
curl "localhost:8787/api/events?limit=100" -H "X-KCH-Token: $KCH_TOKEN"

# Inspect prompts, per-answer stats, and curate by hand
curl "localhost:8787/api/prompts" -H "X-KCH-Token: $KCH_TOKEN"
curl "localhost:8787/api/stats?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true" -H "X-KCH-Token: $KCH_TOKEN"
curl -X DELETE "localhost:8787/api/answers?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true&text=Udon" -H "X-KCH-Token: $KCH_TOKEN"
curl -X DELETE "localhost:8787/api/prompts?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true" -H "X-KCH-Token: $KCH_TOKEN"
```
