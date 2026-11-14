// Answer-cache server for krillion-helper (storage only by design).
// The extension keeps calling Anthropic on a cache miss and POSTs
// the result here; the server never sees an API key. Run with:
//   node --experimental-sqlite server.js
// Env: PORT (default 8787), DATA_DIR (default ./data),
// KCH_TOKEN (when set, required as X-KCH-Token on /api/*).
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

let DatabaseSync;
try {
  DatabaseSync = require("node:sqlite").DatabaseSync;
} catch (e) {
  console.error("node:sqlite needs Node 22.5+ run with --experimental-sqlite:", e.message);
  process.exit(1);
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEXT_LEN = 256;
// The event log keeps the newest events and prunes the rest, so
// collecting a lot of logs cannot grow the database without bound.
const MAX_EVENTS = 100000;
// A question counts as encountered again only when no lookup for it
// arrived in this window: a refetch inside the same round (the list
// ran dry, or the exclude list grew) must not count twice.
const ENCOUNTER_GAP_MS = 90 * 1000;
// Game-event kinds the extension may relay with POST /api/events.
// Keep in sync with LOG_EVENT_KINDS in background.js.
const GAME_EVENT_KINDS = new Set([
  "fetch_result", "fetch_error",
  "typing_start", "typing_done", "typing_aborted",
  "submit_attempt", "submit_blocked", "solo_submit",
  "bubble_seen", "outcome_reported", "promote_sent",
  "leftover_cleared",
]);

// Cache key for a prompt: case, spacing, and trailing punctuation
// must not create a second copy of the same question.
function promptKey(prompt) {
  return String(prompt || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[?.!]+$/, "");
}

// Key for one answer: lowercase, fold accents, drop spaces and
// punctuation. Deliberately simpler than the extension's norm()
// (no grey/colour spelling rules): variant spellings are separate
// entries here, and the extension dedups variants on receipt.
function textKey(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[æÆ]/g, "ae")
    .replace(/[œŒ]/g, "oe")
    .replace(/ß|ẞ/g, "ss")
    .replace(/[øØ]/g, "o")
    .replace(/[łŁ]/g, "l")
    .replace(/[đĐ]/g, "d")
    .replace(/[þÞ]/g, "th")
    .replace(/[ðÐ]/g, "d")
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "");
}

function nowIso() {
  return new Date().toISOString();
}

function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY,
      prompt_key TEXT NOT NULL,
      word_style TEXT NOT NULL DEFAULT 'rare',
      party INTEGER NOT NULL DEFAULT 1,
      prompt_text TEXT NOT NULL,
      model TEXT,
      raw_text TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(prompt_key, word_style, party)
    );
    CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY,
      prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      list_kind TEXT NOT NULL,
      position INTEGER NOT NULL,
      text TEXT NOT NULL,
      text_key TEXT NOT NULL,
      removed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(prompt_id, list_kind, text_key)
    );
    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY,
      prompt_id INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      text_key TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'duplicate', 'rejected')),
      source TEXT NOT NULL DEFAULT 'banner',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_feedback_prompt_key ON feedback(prompt_id, text_key);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      created_at TEXT NOT NULL,
      kind TEXT NOT NULL,
      prompt_text TEXT,
      text TEXT,
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_kind_id ON events(kind, id);
  `);
  const hadEncounters = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'encounters'",
  ).get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS encounters (
      prompt_key TEXT PRIMARY KEY,
      prompt_text TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL
    );
  `);
  if (!hadEncounters) backfillEncounters(db);
  return db;
}

// How often each question has come up, kept outside the pruned
// event log so it never shrinks. Every cache lookup (hit or miss)
// is a sighting; sightings closer than ENCOUNTER_GAP_MS merge.
function noteEncounter(db, prompt, atIso) {
  const key = promptKey(prompt);
  if (!key) return;
  const at = atIso || nowIso();
  try {
    const row = db.prepare("SELECT last_seen FROM encounters WHERE prompt_key = ?").get(key);
    if (!row) {
      db.prepare(
        "INSERT INTO encounters (prompt_key, prompt_text, count, first_seen, last_seen) VALUES (?, ?, 1, ?, ?)",
      ).run(key, String(prompt).trim(), at, at);
      return;
    }
    const fresh = Date.parse(at) - Date.parse(row.last_seen) >= ENCOUNTER_GAP_MS;
    db.prepare(
      "UPDATE encounters SET count = count + ?, prompt_text = ?, last_seen = ? WHERE prompt_key = ?",
    ).run(fresh ? 1 : 0, String(prompt).trim(), at, key);
  } catch (_) {}
}

// One-time fill for databases that predate the encounters table:
// replay every cache lookup still in the event log, oldest first.
function backfillEncounters(db) {
  const rows = db.prepare(
    "SELECT created_at, prompt_text FROM events WHERE kind IN ('cache_hit', 'cache_miss') AND prompt_text IS NOT NULL ORDER BY id ASC",
  ).all();
  db.exec("BEGIN");
  try {
    for (const r of rows) noteEncounter(db, r.prompt_text, r.created_at);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
  }
}

// Auto-hide rule: one uncontested rejection is enough — the
// game's verdict is deterministic, and the banner is local to
// the submitting player, so the report is already attributed.
// A duplicate or an acceptance confirms the answer is in the
// game's set, so either one vetoes auto-hiding outright; a lone
// rejection only hides an answer with no evidence for it at all.
function isAutoHidden(agg) {
  if (!agg) return false;
  return agg.rejected >= 1 && agg.accepted === 0 && agg.duplicate === 0;
}

function feedbackAggregates(db, promptId) {
  const rows = db.prepare(
    "SELECT text_key, outcome, COUNT(*) AS n FROM feedback WHERE prompt_id = ? GROUP BY text_key, outcome",
  ).all(promptId);
  const map = new Map();
  for (const row of rows) {
    const agg = map.get(row.text_key) || { accepted: 0, duplicate: 0, rejected: 0 };
    agg[row.outcome] = row.n;
    map.set(row.text_key, agg);
  }
  return map;
}

function visibleLists(db, promptId) {
  const aggs = feedbackAggregates(db, promptId);
  const rows = db.prepare(
    "SELECT list_kind, text FROM entries WHERE prompt_id = ? AND removed = 0 ORDER BY list_kind, position",
  ).all(promptId);
  const lists = { rare: [], common: [], solo: [] };
  for (const row of rows) {
    if (isAutoHidden(aggs.get(textKey(row.text)))) continue;
    if (lists[row.list_kind]) lists[row.list_kind].push(row.text);
  }
  // A promoted krillion answer can sit in both lists: serve it once.
  const rareKeys = new Set(lists.rare.map(textKey));
  lists.common = lists.common.filter((t) => !rareKeys.has(textKey(t)));
  return lists;
}

// One event log for the whole system: every record is persisted
// in SQLite and echoed as one JSON line on stdout, so the same
// history is tail-able in `docker logs` and queryable later via
// GET /api/events. Logging never breaks a request: any failure
// here is swallowed, and the caller still gets its answer.
function recordEvent(db, kind, fields) {
  const createdAt = nowIso();
  const detail = fields && fields.detail !== undefined ? fields.detail : null;
  try {
    db.prepare(
      "INSERT INTO events (created_at, kind, prompt_text, text, detail) VALUES (?, ?, ?, ?, ?)",
    ).run(createdAt, kind, (fields && fields.prompt_text) || null, (fields && fields.text) || null,
      detail == null ? null : JSON.stringify(detail));
    const count = db.prepare("SELECT COUNT(*) AS n FROM events").get().n;
    if (count > MAX_EVENTS) {
      db.prepare("DELETE FROM events WHERE id IN (SELECT id FROM events ORDER BY id ASC LIMIT ?)")
        .run(count - MAX_EVENTS);
    }
  } catch (_) {}
  try {
    console.log(JSON.stringify({
      ts: createdAt,
      kind,
      prompt: (fields && fields.prompt_text) || undefined,
      text: (fields && fields.text) || undefined,
      ...(detail && typeof detail === "object" && !Array.isArray(detail) ? detail : {}),
    }));
  } catch (_) {}
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (_) {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function checkAuth(req, token) {
  if (!token) return true;
  return req.headers["x-kch-token"] === token;
}

function cleanStringList(value, maxItems) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.length > maxItems) return null;
  const out = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    const text = item.trim();
    if (!text || text.length > MAX_TEXT_LEN) return null;
    out.push(text);
  }
  return out;
}

function findPrompt(db, prompt, wordStyle, party) {
  const key = promptKey(prompt);
  if (!key) return null;
  return db.prepare(
    "SELECT * FROM prompts WHERE prompt_key = ? AND word_style = ? AND party = ?",
  ).get(key, wordStyle, party ? 1 : 0) || null;
}

function upsertPrompt(db, prompt, wordStyle, party, model, rawText) {
  const key = promptKey(prompt);
  const now = nowIso();
  return db.prepare(
    `INSERT INTO prompts (prompt_key, word_style, party, prompt_text, model, raw_text, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(prompt_key, word_style, party) DO UPDATE SET
       prompt_text = excluded.prompt_text,
       model = COALESCE(excluded.model, prompts.model),
       raw_text = COALESCE(excluded.raw_text, prompts.raw_text),
       updated_at = excluded.updated_at
     RETURNING *`,
  ).get(key, wordStyle, party ? 1 : 0, String(prompt).trim(), model || null, rawText || null, now, now);
}

function storeLists(db, promptRow, lists) {
  const now = nowIso();
  let stored = 0;
  for (const [kind, items] of Object.entries(lists)) {
    if (!items.length) continue;
    const row = db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM entries WHERE prompt_id = ? AND list_kind = ?").get(promptRow.id, kind);
    let pos = row.m + 1;
    const insert = db.prepare(
      "INSERT OR IGNORE INTO entries (prompt_id, list_kind, position, text, text_key, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const text of items) {
      const info = insert.run(promptRow.id, kind, pos, text, textKey(text), now);
      if (info.changes > 0) stored += 1;
      pos += 1;
    }
  }
  db.prepare("UPDATE prompts SET updated_at = ? WHERE id = ?").run(now, promptRow.id);
  return stored;
}

// Learn one opponent answer: a krillion-tier acceptance only.
// The answer joins the rare list nestled at index 4 (5th place),
// pushing the rest of the rare list down one. Shorter lists append
// at the end, still inside the top 5. Dedup is by text key; an
// answer already in the common bench moves to rare; a manually
// removed answer is never resurrected. The prompt row is always
// the rare party row: krillion answers are rare-list knowledge,
// whatever word style the player currently uses.
// Copy, never move: a word already on the common bench keeps its
// common entry (visibleLists serves it once, from rare), so deleting
// the rare copy later still leaves the common answer in place.
function promoteKrillion(db, promptRow, text) {
  const key = textKey(text);
  const now = nowIso();
  const existing = db.prepare(
    "SELECT * FROM entries WHERE prompt_id = ? AND text_key = ?",
  ).all(promptRow.id, key);
  if (existing.some((e) => e.removed === 1)) return { stored: false, removed: true };
  const listed = existing.find((e) => e.list_kind !== "common");
  if (listed) return { stored: false, already: true, position: listed.position };
  const countRow = db.prepare(
    "SELECT COUNT(*) AS n FROM entries WHERE prompt_id = ? AND list_kind = 'rare' AND removed = 0",
  ).get(promptRow.id);
  const position = Math.min(4, countRow.n);
  db.prepare(
    "UPDATE entries SET position = position + 1 WHERE prompt_id = ? AND list_kind = 'rare' AND removed = 0 AND position >= ?",
  ).run(promptRow.id, position);
  db.prepare(
    "INSERT INTO entries (prompt_id, list_kind, position, text, text_key, created_at) VALUES (?, 'rare', ?, ?, ?, ?)",
  ).run(promptRow.id, position, text.trim(), key, now);
  db.prepare("UPDATE prompts SET updated_at = ? WHERE id = ?").run(now, promptRow.id);
  return { stored: true, position };
}

function parseWordStyle(value) {
  if (value === undefined) return "rare";
  if (value === "rare" || value === "common") return value;
  return null;
}

function parseParty(value) {
  if (value === undefined) return true;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

// Whole-cache summary for the dashboard: totals plus one row per
// stored prompt variant (prompt + word style + game). Event-derived
// numbers (cache hits/misses, krillion finds, daily activity) cover
// only what the event log still holds (newest MAX_EVENTS).
function buildOverview(db) {
  const prompts = db.prepare("SELECT * FROM prompts ORDER BY updated_at DESC").all();
  const entryRows = db.prepare("SELECT prompt_id, list_kind, text, removed FROM entries").all();
  const fbRows = db.prepare(
    "SELECT prompt_id, text_key, outcome, COUNT(*) AS n FROM feedback GROUP BY prompt_id, text_key, outcome",
  ).all();

  const aggsByPrompt = new Map();
  for (const r of fbRows) {
    let m = aggsByPrompt.get(r.prompt_id);
    if (!m) aggsByPrompt.set(r.prompt_id, (m = new Map()));
    const agg = m.get(r.text_key) || { accepted: 0, duplicate: 0, rejected: 0 };
    agg[r.outcome] = r.n;
    m.set(r.text_key, agg);
  }

  const rows = new Map();
  for (const p of prompts) {
    const fb = { accepted: 0, duplicate: 0, rejected: 0 };
    for (const agg of (aggsByPrompt.get(p.id) || new Map()).values()) {
      fb.accepted += agg.accepted; fb.duplicate += agg.duplicate; fb.rejected += agg.rejected;
    }
    rows.set(p.id, {
      key: p.prompt_key, prompt: p.prompt_text, wordStyle: p.word_style, party: p.party === 1,
      model: p.model, createdAt: p.created_at, updatedAt: p.updated_at,
      rare: 0, common: 0, solo: 0, removed: 0, hidden: 0,
      ...fb, hits: 0, misses: 0, krillion: [],
    });
  }
  for (const e of entryRows) {
    const row = rows.get(e.prompt_id);
    if (!row) continue;
    if (e.removed === 1) { row.removed++; continue; }
    const aggs = aggsByPrompt.get(e.prompt_id);
    if (aggs && isAutoHidden(aggs.get(textKey(e.text)))) { row.hidden++; continue; }
    if (row[e.list_kind] !== undefined) row[e.list_kind]++;
  }

  // Event-derived stats. Promotions always land in the rare/party
  // variant; cache events carry their variant in detail.
  const byVariant = new Map();
  for (const row of rows.values()) byVariant.set(`${row.key}|${row.wordStyle}|${row.party ? 1 : 0}`, row);
  const cache = { hit: 0, miss: 0, store: 0 };
  const krillionFinds = [];
  const evRows = db.prepare(
    "SELECT created_at, kind, prompt_text, text, detail FROM events WHERE kind IN ('cache_hit','cache_miss','cache_store','promote') ORDER BY id DESC",
  ).all();
  for (const ev of evRows) {
    let detail = null;
    try { detail = ev.detail ? JSON.parse(ev.detail) : null; } catch (_) {}
    const key = promptKey(ev.prompt_text);
    if (ev.kind === "promote") {
      // Every krillion-tier sighting counts, including repeats of a
      // word already in the rare list (stored: false, already: true);
      // only a promotion refused by a manual delete is left out.
      if (!detail || detail.removed) continue;
      krillionFinds.push({
        prompt: ev.prompt_text, text: ev.text, at: ev.created_at,
        source: detail.source === "own" ? "own" : "other", repeat: !detail.stored,
      });
      const row = byVariant.get(`${key}|rare|1`);
      if (row && !row.krillion.includes(ev.text)) row.krillion.push(ev.text);
      continue;
    }
    const k = ev.kind.slice("cache_".length);
    cache[k]++;
    if (k === "store" || !detail) continue;
    const row = byVariant.get(`${key}|${detail.wordStyle}|${detail.party ? 1 : 0}`);
    if (row) row[k === "hit" ? "hits" : "misses"]++;
  }

  const daily = db.prepare(
    `SELECT substr(created_at, 1, 10) AS day,
       SUM(kind = 'cache_hit') AS hits, SUM(kind = 'cache_miss') AS misses,
       SUM(kind = 'feedback') AS outcomes, SUM(kind = 'submit_attempt') AS submits
     FROM events GROUP BY day ORDER BY day DESC LIMIT 14`,
  ).all().reverse();
  const eventsInfo = db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS since FROM events").get();
  const encounters = {};
  for (const r of db.prepare("SELECT prompt_key, count, first_seen, last_seen FROM encounters").all()) {
    encounters[r.prompt_key] = { count: r.count, firstSeen: r.first_seen, lastSeen: r.last_seen };
  }
  const encounterTotals = db.prepare(
    "SELECT COALESCE(SUM(count), 0) AS total, COALESCE(SUM(count > 1), 0) AS repeated FROM encounters",
  ).get();

  const list = [...rows.values()];
  const sum = (f) => list.reduce((a, r) => a + r[f], 0);
  const models = {};
  for (const r of list) if (r.model) models[r.model] = (models[r.model] || 0) + 1;
  return {
    generatedAt: nowIso(),
    totals: {
      questions: new Set(list.map((r) => r.key)).size,
      variants: list.length,
      answers: { rare: sum("rare"), common: sum("common"), solo: sum("solo") },
      removed: sum("removed"),
      hidden: sum("hidden"),
      feedback: { accepted: sum("accepted"), duplicate: sum("duplicate"), rejected: sum("rejected") },
      cache,
      // Distinct answers (question + word), not sightings.
      krillion: new Set(krillionFinds.map((f) => promptKey(f.prompt) + "|" + textKey(f.text))).size,
      krillionOwn: new Set(krillionFinds.filter((f) => f.source === "own")
        .map((f) => promptKey(f.prompt) + "|" + textKey(f.text))).size,
      krillionSightings: krillionFinds.length,
      encounters: encounterTotals.total,
      repeatedQuestions: encounterTotals.repeated,
      events: eventsInfo.n,
      eventsSince: eventsInfo.since,
      models,
    },
    prompts: list,
    encounters,
    krillionFinds: krillionFinds.slice(0, 100),
    daily,
  };
}

const DASHBOARD_PATH = path.join(__dirname, "dashboard.html");

async function handleRequest(db, token, req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true });
  }
  // The dashboard page is a static shell with no data in it; it asks
  // for the token and reads everything through the authed /api/*.
  if ((url.pathname === "/" || url.pathname === "/dashboard") && req.method === "GET") {
    if (url.pathname === "/") {
      res.writeHead(302, { location: "/dashboard" });
      return res.end();
    }
    try {
      const html = fs.readFileSync(DASHBOARD_PATH);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-frame-options": "DENY",
        "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'",
      });
      return res.end(html);
    } catch (_) {
      return sendJson(res, 404, { error: "dashboard not installed" });
    }
  }
  if (!url.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "not found" });
  }
  if (!checkAuth(req, token)) {
    recordEvent(db, "unauthorized", { detail: { path: url.pathname, method: req.method } });
    return sendJson(res, 401, { error: "unauthorized" });
  }
  try {
    if (url.pathname === "/api/answers" && req.method === "GET") {
      const prompt = url.searchParams.get("prompt") || "";
      const wordStyle = parseWordStyle(url.searchParams.get("wordStyle") || undefined);
      const party = parseParty(url.searchParams.get("party") ?? undefined);
      if (!promptKey(prompt) || wordStyle === null || party === null) {
        return sendJson(res, 400, { error: "prompt, wordStyle, and party are required" });
      }
      noteEncounter(db, prompt);
      const row = findPrompt(db, prompt, wordStyle, party);
      if (!row) {
        recordEvent(db, "cache_miss", { prompt_text: String(prompt).trim(), detail: { wordStyle, party, reason: "no_entry" } });
        return sendJson(res, 404, { cached: false, error: "no cached answers" });
      }
      const lists = visibleLists(db, row.id);
      const candidates = party ? [...lists.rare, ...lists.common] : lists.solo;
      if (!candidates.length) {
        recordEvent(db, "cache_miss", { prompt_text: row.prompt_text, detail: { wordStyle, party, reason: "exhausted" } });
        return sendJson(res, 404, { cached: false, error: "no cached answers" });
      }
      recordEvent(db, "cache_hit", {
        prompt_text: row.prompt_text,
        detail: { wordStyle, party, rare: lists.rare.length, common: lists.common.length, candidates: candidates.length },
      });
      return sendJson(res, 200, {
        cached: true, prompt: row.prompt_text, wordStyle, party,
        rare: lists.rare, common: lists.common, candidates,
        model: row.model, updatedAt: row.updated_at,
      });
    }

    if (url.pathname === "/api/answers" && req.method === "POST") {
      const body = await readJson(req);
      const wordStyle = parseWordStyle(body.wordStyle);
      const party = parseParty(body.party);
      const rare = cleanStringList(body.rare, 40);
      const common = cleanStringList(body.common, 60);
      const candidates = cleanStringList(body.candidates, 40);
      if (!body.prompt || typeof body.prompt !== "string" || !promptKey(body.prompt) ||
          wordStyle === null || party === null || rare === null || common === null || candidates === null) {
        return sendJson(res, 400, { error: "prompt, wordStyle, party, and string lists are required" });
      }
      if (typeof body.model !== "undefined" && typeof body.model !== "string") {
        return sendJson(res, 400, { error: "model must be a string" });
      }
      if (typeof body.rawText !== "undefined" && typeof body.rawText !== "string") {
        return sendJson(res, 400, { error: "rawText must be a string" });
      }
      const row = upsertPrompt(db, body.prompt, wordStyle, party, body.model, body.rawText);
      const lists = party ? { rare, common } : { solo: candidates };
      const stored = storeLists(db, row, lists);
      recordEvent(db, "cache_store", {
        prompt_text: row.prompt_text,
        detail: { wordStyle, party, stored, model: body.model || null },
      });
      return sendJson(res, 200, { ok: true, stored, promptId: row.id });
    }

    if (url.pathname === "/api/feedback" && req.method === "POST") {
      const body = await readJson(req);
      const wordStyle = parseWordStyle(body.wordStyle);
      const party = parseParty(body.party);
      const source = body.source === undefined ? "banner" : body.source;
      if (!body.prompt || typeof body.prompt !== "string" || !promptKey(body.prompt) ||
          !body.text || typeof body.text !== "string" || body.text.trim().length > MAX_TEXT_LEN ||
          !["accepted", "duplicate", "rejected"].includes(body.outcome) ||
          wordStyle === null || party === null || typeof source !== "string" || source.length > 32) {
        return sendJson(res, 400, { error: "prompt, text, outcome, wordStyle, and party are required" });
      }
      const row = upsertPrompt(db, body.prompt, wordStyle, party, undefined, undefined);
      db.prepare(
        "INSERT INTO feedback (prompt_id, text, text_key, outcome, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(row.id, body.text.trim(), textKey(body.text), body.outcome, source, nowIso());
      recordEvent(db, "feedback", {
        prompt_text: row.prompt_text,
        text: body.text.trim(),
        detail: { wordStyle, party, outcome: body.outcome, source },
      });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/promote" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.prompt || typeof body.prompt !== "string" || !promptKey(body.prompt) ||
          !body.text || typeof body.text !== "string" || !body.text.trim() || body.text.trim().length > MAX_TEXT_LEN ||
          body.tier !== "krillion") {
        return sendJson(res, 400, { error: "prompt, text, and tier 'krillion' are required" });
      }
      const row = upsertPrompt(db, body.prompt, "rare", true, undefined, undefined);
      const result = promoteKrillion(db, row, body.text.trim());
      // Who played it: "own" (this player) or "other" (an opponent).
      const source = body.source === "own" ? "own" : "other";
      recordEvent(db, "promote", {
        prompt_text: row.prompt_text,
        text: body.text.trim(),
        detail: { ...result, source },
      });
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (url.pathname === "/api/events" && req.method === "POST") {
      const body = await readJson(req);
      if (!body.kind || typeof body.kind !== "string" || !GAME_EVENT_KINDS.has(body.kind) ||
          (body.prompt !== undefined && body.prompt !== null && typeof body.prompt !== "string") ||
          (body.text !== undefined && body.text !== null && typeof body.text !== "string") ||
          (typeof body.prompt === "string" && body.prompt.length > MAX_TEXT_LEN) ||
          (typeof body.text === "string" && body.text.length > MAX_TEXT_LEN) ||
          (body.detail !== undefined && body.detail !== null && (typeof body.detail !== "object" || Array.isArray(body.detail)))) {
        return sendJson(res, 400, { error: "kind, prompt, text, and detail are required" });
      }
      // The event itself is the record: one row and one stdout line.
      recordEvent(db, body.kind, {
        prompt_text: body.prompt || null,
        text: body.text || null,
        detail: body.detail || null,
      });
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/events" && req.method === "GET") {
      let limit = parseInt(url.searchParams.get("limit") || "100", 10);
      if (!Number.isFinite(limit)) limit = 100;
      limit = Math.min(1000, Math.max(1, limit));
      const where = [];
      const params = [];
      const kind = url.searchParams.get("kind");
      const promptFilter = url.searchParams.get("prompt");
      const textFilter = url.searchParams.get("text");
      if (kind) {
        where.push("kind = ?");
        params.push(kind);
      }
      if (promptFilter) {
        where.push("prompt_text LIKE ?");
        params.push("%" + promptFilter + "%");
      }
      if (textFilter) {
        where.push("text LIKE ?");
        params.push("%" + textFilter + "%");
      }
      const rows = db.prepare(
        "SELECT id, created_at, kind, prompt_text, text, detail FROM events" +
        (where.length ? " WHERE " + where.join(" AND ") : "") +
        " ORDER BY id DESC LIMIT ?",
      ).all(...params, limit);
      return sendJson(res, 200, {
        events: rows.map((r) => ({
          id: r.id, createdAt: r.created_at, kind: r.kind,
          prompt: r.prompt_text, text: r.text,
          detail: r.detail ? JSON.parse(r.detail) : null,
        })),
      });
    }

    if (url.pathname === "/api/prompts" && req.method === "GET") {
      const rows = db.prepare("SELECT * FROM prompts ORDER BY updated_at DESC LIMIT 100").all();
      const out = rows.map((row) => {
        const counts = db.prepare(
          "SELECT list_kind, COUNT(*) AS n FROM entries WHERE prompt_id = ? AND removed = 0 GROUP BY list_kind",
        ).all(row.id);
        const byKind = { rare: 0, common: 0, solo: 0 };
        for (const c of counts) if (byKind[c.list_kind] !== undefined) byKind[c.list_kind] = c.n;
        return {
          prompt: row.prompt_text, wordStyle: row.word_style, party: row.party === 1,
          model: row.model, updatedAt: row.updated_at,
          rare: byKind.rare, common: byKind.common, solo: byKind.solo,
        };
      });
      return sendJson(res, 200, { prompts: out });
    }

    if (url.pathname === "/api/overview" && req.method === "GET") {
      return sendJson(res, 200, buildOverview(db));
    }

    if (url.pathname === "/api/stats" && req.method === "GET") {
      const prompt = url.searchParams.get("prompt") || "";
      const wordStyle = parseWordStyle(url.searchParams.get("wordStyle") || undefined);
      const party = parseParty(url.searchParams.get("party") ?? undefined);
      if (!promptKey(prompt) || wordStyle === null || party === null) {
        return sendJson(res, 400, { error: "prompt, wordStyle, and party are required" });
      }
      const row = findPrompt(db, prompt, wordStyle, party);
      if (!row) return sendJson(res, 404, { error: "no such prompt" });
      const aggs = feedbackAggregates(db, row.id);
      const entries = db.prepare(
        "SELECT list_kind, text, removed FROM entries WHERE prompt_id = ? ORDER BY list_kind, position",
      ).all(row.id);
      return sendJson(res, 200, {
        prompt: row.prompt_text, wordStyle, party,
        answers: entries.map((e) => {
          const agg = aggs.get(textKey(e.text)) || { accepted: 0, duplicate: 0, rejected: 0 };
          return {
            text: e.text, listKind: e.list_kind, removed: e.removed === 1,
            accepted: agg.accepted, duplicate: agg.duplicate, rejected: agg.rejected,
            autoHidden: isAutoHidden(agg),
          };
        }),
      });
    }

    if (url.pathname === "/api/answers" && req.method === "DELETE") {
      const prompt = url.searchParams.get("prompt") || "";
      const wordStyle = parseWordStyle(url.searchParams.get("wordStyle") || undefined);
      const party = parseParty(url.searchParams.get("party") ?? undefined);
      const text = url.searchParams.get("text") || "";
      if (!promptKey(prompt) || wordStyle === null || party === null || !text.trim()) {
        return sendJson(res, 400, { error: "prompt, wordStyle, party, and text are required" });
      }
      const row = findPrompt(db, prompt, wordStyle, party);
      if (!row) return sendJson(res, 404, { error: "no such prompt" });
      const info = db.prepare(
        "UPDATE entries SET removed = 1 WHERE prompt_id = ? AND text_key = ?",
      ).run(row.id, textKey(text));
      recordEvent(db, "delete_answer", {
        prompt_text: row.prompt_text,
        text: text.trim(),
        detail: { wordStyle, party, removed: info.changes },
      });
      return sendJson(res, 200, { ok: true, removed: info.changes });
    }

    if (url.pathname === "/api/prompts" && req.method === "DELETE") {
      const prompt = url.searchParams.get("prompt") || "";
      const wordStyle = parseWordStyle(url.searchParams.get("wordStyle") || undefined);
      const party = parseParty(url.searchParams.get("party") ?? undefined);
      if (!promptKey(prompt) || wordStyle === null || party === null) {
        return sendJson(res, 400, { error: "prompt, wordStyle, and party are required" });
      }
      const info = db.prepare(
        "DELETE FROM prompts WHERE prompt_key = ? AND word_style = ? AND party = ?",
      ).run(promptKey(prompt), wordStyle, party ? 1 : 0);
      if (info.changes === 0) return sendJson(res, 404, { error: "no such prompt" });
      recordEvent(db, "delete_prompt", {
        prompt_text: String(prompt).trim(),
        detail: { wordStyle, party, deleted: true },
      });
      return sendJson(res, 200, { ok: true, deleted: true });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
    recordEvent(db, "error", { detail: { path: url.pathname, method: req.method, error: e.message || "internal error" } });
    return sendJson(res, e.status || 500, { error: e.message || "internal error" });
  }
}

function createServer(options) {
  const db = openDb(options.dbPath);
  const token = options.token || "";
  const server = http.createServer((req, res) => {
    handleRequest(db, token, req, res).catch((e) => {
      try { sendJson(res, 500, { error: e.message || "internal error" }); } catch (_) {}
    });
  });
  server.on("close", () => db.close());
  return server;
}

function startFromEnv() {
  const port = Number(process.env.PORT || 8787);
  const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
  const server = createServer({
    dbPath: path.join(dataDir, "kch.sqlite"),
    token: process.env.KCH_TOKEN || "",
  });
  server.listen(port, () => {
    console.log(`krillion-helper cache server listening on port ${port} (data: ${dataDir})`);
  });
}

if (require.main === module) startFromEnv();

module.exports = { createServer, openDb, promptKey, textKey, isAutoHidden, visibleLists, noteEncounter, ENCOUNTER_GAP_MS };
