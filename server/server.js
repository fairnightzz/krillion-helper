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
  `);
  return db;
}

// Auto-hide rule: hide an answer only on repeated, uncontested
// rejection. A duplicate or an acceptance confirms the answer is
// in the game's set, so either one vetoes auto-hiding outright.
function isAutoHidden(agg) {
  if (!agg) return false;
  return agg.rejected >= 3 && agg.accepted === 0 && agg.duplicate === 0;
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
  return lists;
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

async function handleRequest(db, token, req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true });
  }
  if (!url.pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "not found" });
  }
  if (!checkAuth(req, token)) {
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
      const row = findPrompt(db, prompt, wordStyle, party);
      if (!row) return sendJson(res, 404, { cached: false, error: "no cached answers" });
      const lists = visibleLists(db, row.id);
      const candidates = party ? [...lists.rare, ...lists.common] : lists.solo;
      if (!candidates.length) return sendJson(res, 404, { cached: false, error: "no cached answers" });
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
      return sendJson(res, 200, { ok: true });
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
      return sendJson(res, 200, { ok: true, deleted: true });
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (e) {
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

module.exports = { createServer, openDb, promptKey, textKey, isAutoHidden, visibleLists };
