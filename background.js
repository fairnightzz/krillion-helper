// Service worker: calls the answer API with the user's key.
// Content scripts never see the key; they just ask for answers.

const API_URL = "https://api.anthropic.com/v1/messages";
const MODELS_URL = "https://api.anthropic.com/v1/models";

// A hung request must not strand the game in "thinking…" for the
// whole answer window: the platform gives fetch no default timeout.
const API_TIMEOUT_MS = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchWithTimeout(url, options, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("API request timed out");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "low",
  mode: "auto",        // auto | fill | suggest
  enabled: true,         // master switch; false disables the whole extension
  autoPlayAgain: false,  // rated party: click Play again / Rematch after a game ends
  wordStyle: "rare",     // rare | common: rare-first with a common bench, or common only
  autoAdvance: false,
  showOverlay: true,
  candidateCount: 8,
  serverUrl: "https://krillion.zhehaizhang.com", // answer-cache server; blank disables it
  serverToken: "", // sent as X-KCH-Token when the server requires one
};

const SYSTEM_PROMPT = `You are helping a player of Krillion (krillion.io), a daily word game.
Each round shows a category prompt such as "Name a noodle dish" or "Name a capital city".
The player types ONE answer. The answer is checked against a curated answer set built from
dictionaries, Wikipedia lists and encyclopedias. The score depends ONLY on how rare the accepted
answer is: the rarer (less commonly guessed) the answer, the deeper the player sinks and the more
points they get. A perfect round is the rarest answer in the set. An answer that is NOT in the
curated set is rejected and wastes time.

Your job: return the RAREST legitimate answers for the prompt, ranked rarest first.

Rules for every candidate:
- It must be a real, verifiable, well-documented member of the category: something that appears
  on a standard reference list for that category (a Wikipedia "list of ..." page, a dictionary,
  an encyclopedia). Reference-list membership matters more than fame.
- Use the most canonical, commonly written name. No parentheses, no explanations, no qualifiers.
- Prefer the short form people actually type: when an item is overwhelmingly known by an acronym or initialism, that short form IS the canonical name — give PUBG, not PlayerUnknown's Battlegrounds; give NASA, not National Aeronautics and Space Administration. Never invent an abbreviation, and never shorten a name that has no established short form.
- Keep it short: ideally 1-3 words. Never more than 6 words.
- Do not invent items. Do not use near-misses, slang spellings, or hyper-local obscurities that
  would not appear on reference lists.

Ranking:
- Put the most obscure answers you are still confident are documented members FIRST. Think of
  what almost no casual player would type: historical, regional, technical, archaic, or
  little-known-but-catalogued items.
- Avoid the "too clever" trap: the go-to obscure pick that every trivia fan reaches for is not
  actually rare. Go one level deeper than that.
- For party games with RARE and COMMON sections, the COMMON section is
  the safe bench: moderately uncommon answers certain to be accepted,
  in the order the user message asks for. For a single list, make the last few
  candidates likewise safe fallbacks; the user message says how many.

Output format: one candidate per line, nothing else. No numbering, no bullets,
no commentary, no headings, no markdown, and no preamble of any kind: never
write "Here are...", "Sure...", or anything before the first candidate, and
never add explanations in parentheses or after dashes or colons. If you
write anything other than candidate names, the answer is unusable. When the
user message asks for RARE and COMMON sections, output exactly those two
sections in that order, each heading on its own line (RARE: then COMMON:),
one candidate per line in each, and nothing else. Never write anything
before the first heading.`;

function supportsEffort(model) {
  return !/haiku/.test(model);
}

function supportsDefaultFallbacks(model) {
  return /^claude-(opus-5-5|sonnet-5-5|fable-5-1|opus-5)$/.test(model);
}

async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  return { ...DEFAULTS, ...stored };
}

function buildUserMessage(prompt, exclude, party, kind, count, wordStyle) {
  const commonOnly = wordStyle === "common";
  if (!party) {
    const soloCount = count == null ? DEFAULTS.candidateCount : count;
    let text = commonOnly
      ? `Game prompt: "${prompt}"\n\nGive ${soloCount} COMMON candidate answers — answers certain to be accepted, most common first. Do not include rare or obscure answers.`
      : `Game prompt: "${prompt}"\n\nGive ${soloCount} candidate answers, rarest first (last 2 are safe fallbacks).`;
    if (exclude && exclude.length) {
      text += `\n\nThese were already REJECTED by the game as not in the answer set, do not repeat them and avoid anything similarly obscure:\n`;
      text += exclude.map((e) => `- ${e}`).join("\n");
    }
    return text;
  }
  // Party games get two lists: rare answers to chase depth, and a
  // separate common bench (a duel most of all runs many turns per
  // category, so one or two safe answers are not enough). Each list
  // regenerates on its own when it runs out. Common-only play asks
  // for the bench alone, whatever list was requested.
  let text;
  if (commonOnly) {
    // 22, not 10: a duel burns through the bench, so the common
    // pool fills the whole slot count the two lists would have
    // held (12 rare + 10 common) instead of leaving the rare
    // portion empty.
    text = `Game prompt: "${prompt}"\n\nGive 22 COMMON candidate answers, most common first — answers certain to be accepted, from the most widely known down. Output them under a "COMMON:" heading, one per line, and nothing else in that section.`;
  } else if (kind === "rare") {
    text = `Game prompt: "${prompt}"\n\nGive 12 RARE candidate answers, rarest first. Output them under a "RARE:" heading, one per line, and nothing else in that section.`;
  } else if (kind === "common") {
    text = `Game prompt: "${prompt}"\n\nGive 10 COMMON candidate answers — moderately uncommon answers certain to be accepted, rarest first among them. Output them under a "COMMON:" heading, one per line, and nothing else in that section.`;
  } else {
    text = `Game prompt: "${prompt}"\n\nGive candidate answers in two sections. First, 12 RARE answers, rarest first, under a "RARE:" heading. Then, 10 COMMON answers — moderately uncommon answers certain to be accepted, rarest first among them — under a "COMMON:" heading. One answer per line, and nothing else.`;
  }
  if (exclude && exclude.length) {
    text += `\n\nThese answers are already used up in this round (played by someone, or rejected). Do not repeat them or close variants of them; give NEW ones:\n`;
    text += exclude.map((e) => `- ${e}`).join("\n");
  }
  return text;
}

// Parse the model's reply into candidate names only. The model is told
// to output one name per line and nothing else, but it sometimes adds a
// preamble ("Here are the top 10 words:"), numbering, markdown, or an
// explanation after a dash, colon, or parenthesis. All of that is
// stripped or dropped here, and lines that still look like commentary
// are dropped rather than typed: typing commentary wastes the round,
// while typing nothing shows an error instead.
const PREAMBLE_PREFIX = /^(here|sure|of course|certainly|absolutely|these|below|the|top|answers?|candidates?|list)\b/i;
const PREAMBLE_START = /^(here|sure|of course|certainly|absolutely|these|below|note|the rarest|rarest|top\s+\d+|answers?|candidates?|list)\b/i;

// A preamble that lists candidates on the same line ("Here are the
// answers: Udon, Ramen") yields those candidates; a preamble with
// nothing after its colon yields none. Returns null when the line is
// not a preamble, so ordinary lines keep the colon-truncation path.
function preambleFragments(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) return null;
  const prefix = line.slice(0, colonIdx).trim();
  if (!PREAMBLE_PREFIX.test(prefix) && !/\bhere (are|is)\b/i.test(prefix)) return null;
  const suffix = line.slice(colonIdx + 1).trim();
  if (!suffix) return [];
  return suffix
    .split(/[,;•]/)
    .flatMap((frag) => frag.split(/\s+(?=\d{1,2}[.)]\s)/))
    .map((frag) => frag.trim())
    .filter(Boolean);
}

function cleanCandidateName(line) {
  let name = line.trim();
  // Leading list markers only (a number with "." or ")", a bullet, a
  // quote/header marker). Bare leading digits are kept: "7-layer dip"
  // is a name, not a list marker.
  for (let i = 0; i < 5; i += 1) {
    const next = name.replace(/^\s*(?:\d{1,2}[.)]\s+|[-*•#>|]+\s*|:\s+)/, "");
    if (next === name) break;
    name = next;
  }
  // Explanations: everything from the first dash, pipe, parenthesis,
  // or colon on. Canonical names contain none of those (hyphenated
  // words join with a hyphen and no spaces, so " - " is safe).
  const cuts = [" — ", " – ", " - ", " |", " (", "(", "—", "–", ": "];
  let cutAt = -1;
  for (const marker of cuts) {
    const idx = name.indexOf(marker);
    if (idx > 0 && (cutAt < 0 || idx < cutAt)) cutAt = idx;
  }
  if (cutAt >= 0) name = name.slice(0, cutAt);
  // Surrounding markdown/quotes and trailing punctuation.
  name = name.replace(/^["'`\u201C\u201D\u2018\u2019\*_#\s]+/, "").replace(/["'`\u201C\u201D\u2018\u2019\*_#\s.,;:\-]+$/, "");
  return name.replace(/\s+/g, " ").trim();
}

// Canonical key for comparing/deduping answers: the same bounded
// spelling-variant rules as norm() in content.js (grey->gray, colour
// family, -ise/-yse/-ense endings, and so on). Displayed and typed
// text stays verbatim; only equality uses this form. Keep in sync
// with norm() in content.js.
const COLOUR_STEMS = [
  "colour", "favour", "honour", "behaviour", "flavour", "labour",
  "neighbour", "humour", "rumour", "vigour", "ardour", "odour", "savour", "glamour",
];
const COLOUR_SUFFIXES = ["e", "ed", "ing", "ite", "ites", "able", "ably", "al", "ally", "ous", "ously", "ful", "fully", "s"];
const ISE_EXCEPTIONS = new Set([
  "surprise", "promise", "exercise", "compromise", "franchise",
  "merchandise", "paradise", "otherwise", "likewise", "clockwise", "expertise",
]);
const DIALOGUE_WORDS = new Set([
  "catalogue", "dialogue", "analogue", "monologue", "epilogue", "prologue", "travelogue", "decalogue",
]);
const CENTRE_WORDS = new Set(["centre", "theatre", "fibre", "litre", "metre", "calibre", "sceptre"]);
const CLASSICAL_WORDS = {
  foetus: "fetus", oestrogen: "estrogen", oedema: "edema", oesophagus: "esophagus",
  anaemia: "anemia", anaesthetic: "anesthetic", encyclopaedia: "encyclopedia",
  paediatric: "pediatric", haemoglobin: "hemoglobin", leukaemia: "leukemia",
  diarrhoea: "diarrhea", manoeuvre: "maneuver",
};
function canonicalWord(w) {
  w = w.replace(/grey/g, "gray");
  if (Object.hasOwn(CLASSICAL_WORDS, w)) return CLASSICAL_WORDS[w];
  for (const stem of COLOUR_STEMS) {
    if (w === stem || (w.startsWith(stem) && COLOUR_SUFFIXES.includes(w.slice(stem.length)))) {
      return w.replace("our", "or");
    }
  }
  if (!ISE_EXCEPTIONS.has(w)) {
    if (/ised$/.test(w)) return w.slice(0, -4) + "ized";
    if (/ising$/.test(w)) return w.slice(0, -5) + "izing";
    if (/ise$/.test(w)) return w.slice(0, -3) + "ize";
  }
  if (/yse$/.test(w)) return w.slice(0, -3) + "yze";
  if (/ense$/.test(w)) return w.slice(0, -4) + "ence";
  if (DIALOGUE_WORDS.has(w)) return w.slice(0, -4) + "og";
  if (CENTRE_WORDS.has(w)) return w.slice(0, -2) + "er";
  if (/(lling|lled|ller)$/.test(w)) return w.replace(/ll(ing|ed|er)$/, "l$1");
  return w;
}
function canonicalKey(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/æ/g, "ae")
    .replace(/œ/g, "oe")
    .replace(/ß/g, "ss")
    .replace(/ø/g, "o")
    .replace(/ł/g, "l")
    .replace(/đ/g, "d")
    .replace(/þ/g, "th")
    .replace(/ð/g, "d")
    .replace(/ı/g, "i")
    .replace(/[“”"]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(canonicalWord)
    .join("");
}

// A whole-line section heading: "RARE:", "## Common", "**COMMON:**",
// "Safe answers", and so on. Anything else is a candidate line.
function sectionHeaderKind(line) {
  // Headings arrive with counts and numbering too: "RARE (12):",
  // "1. RARE:", "RARE: 12". Strip those decorations before the
  // exact match, or the heading line becomes a literal candidate.
  const h = line
    .trim()
    .replace(/^[#>*\-•\s\*\_]+/, "")
    .replace(/^\d{1,2}[.)]\s+/, "")
    .replace(/[*_#\s:]+$/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s+\d+\s*$/, "")
    .replace(/[*_#\s:]+$/, "")
    .trim()
    .toLowerCase();
  if (/^(rare|rarest|rare answers?|rare candidates?)$/.test(h)) return "rare";
  if (/^(common|common answers?|common candidates?|common fallbacks?|safe|safe answers?|safe candidates?|safe fallbacks?)$/.test(h)) return "common";
  return null;
}

// A header with candidates on the same line: "Common: Udon, Ramen".
function inlineHeader(line) {
  const m = line
    .trim()
    .replace(/^[#>*\-•\s\*\_]+/, "")
    .replace(/^\d{1,2}[.)]\s+/, "")
    .match(/^(rarest|rare|common|safe)(\s+(answers?|candidates?|fallbacks?))?\s*:\s*(.+)$/i);
  if (!m) return null;
  return { kind: m[1].toLowerCase() === "rare" || m[1].toLowerCase() === "rarest" ? "rare" : "common", suffix: m[4] };
}

// Split a reply into rare/common sections, applying the same cleaning
// and commentary filters as parseCandidates. options:
//   defaultSection: where lines go before any heading ('rare' default)
//   tailSize: without any heading, the last N lines are the common
//     section instead (the old single-list tail rule, kept as fallback
//     for party replies that ignore the section format).
function parseSections(text, exclude, options) {
  const opts = options || {};
  let current = opts.defaultSection === "common" ? "common" : "rare";
  const seen = new Set((exclude || []).map((e) => canonicalKey(e)));
  const buckets = { rare: [], common: [] };
  let hasSections = false;
  const tryAdd = (raw, section) => {
    const name = cleanCandidateName(raw);
    if (!name || name.length > 256) return;
    if (name.includes("?") || /:\/\/|^www\./i.test(name)) return;
    if (PREAMBLE_START.test(name)) return;
    if (name.split(/\s+/).length > 6) return;
    const key = canonicalKey(name);
    if (seen.has(key)) return;
    seen.add(key);
    buckets[section].push(name);
  };
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const header = sectionHeaderKind(line);
    if (header) {
      current = header;
      hasSections = true;
      continue;
    }
    const inline = inlineHeader(line);
    if (inline) {
      current = inline.kind;
      hasSections = true;
      for (const frag of inline.suffix.split(/[,;•]/)) {
        const trimmed = frag.trim();
        if (trimmed) tryAdd(trimmed, current);
      }
      continue;
    }
    if (/\bhere (are|is)\b/i.test(line) || PREAMBLE_START.test(line)) {
      const frags = preambleFragments(line);
      if (frags) {
        for (const frag of frags) tryAdd(frag, current);
        continue;
      }
      // Preamble-shaped with no colon to recover from: commentary.
      continue;
    }
    tryAdd(line, current);
  }
  let { rare, common } = buckets;
  if (!hasSections && opts.tailSize > 0) {
    const ordered = [...rare, ...common];
    if (ordered.length > opts.tailSize) {
      rare = ordered.slice(0, ordered.length - opts.tailSize);
      common = ordered.slice(ordered.length - opts.tailSize);
    }
  }
  return { rare, common, hasSections };
}

function parseCandidates(text, exclude) {
  const { rare, common } = parseSections(text, exclude, { defaultSection: "rare" });
  return [...rare, ...common];
}

async function callApi({ prompt, exclude, party, kind, wordStyle }, settings, useFallbacks) {
  const headers = {
    "content-type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const commonOnly = wordStyle === "common";
  const count = party ? (commonOnly ? 22 : kind === "rare" ? 12 : kind === "common" ? 10 : 22) : settings.candidateCount;
  const body = {
    model: settings.model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(prompt, exclude, party, kind, count, wordStyle) }],
  };
  if (supportsEffort(settings.model)) {
    body.output_config = { effort: settings.effort || "low" };
  }
  if (useFallbacks && supportsDefaultFallbacks(settings.model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  const res = await fetchWithTimeout(API_URL, { method: "POST", headers, body: JSON.stringify(body) }, API_TIMEOUT_MS);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    const ra = res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
    const secs = ra == null ? NaN : Number(ra);
    if (Number.isFinite(secs) && secs >= 0) err.retryAfterMs = Math.min(secs * 1000, 10000);
    throw err;
  }
  return json;
}

// One plain call, retrying only the 400 that the server-side
// fallback beta can cause. Transient statuses are retried by the
// caller, which owns the attempt budget.
async function callApiWithFallback(req, settings) {
  try {
    return await callApi(req, settings, true);
  } catch (e) {
    if (e.status === 400 && supportsDefaultFallbacks(settings.model)) {
      return callApi(req, settings, false);
    }
    throw e;
  }
}

// ---------- answer-cache server ----------
// Storage only: the extension keeps calling Anthropic on a miss
// and stores the result here, so the server never sees an API key.
// A blank server URL disables the cache entirely. Any cache error
// is a miss: the caller falls back to Anthropic directly.
function serverBase(settings) {
  const url = String(settings.serverUrl || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(url)) return "";
  return url;
}

function serverHeaders(settings) {
  const headers = { "content-type": "application/json" };
  if (settings.serverToken) headers["x-kch-token"] = settings.serverToken;
  return headers;
}

async function serverRequest(settings, path, opts) {
  const base = serverBase(settings);
  if (!base) throw new Error("no cache server configured");
  const res = await fetchWithTimeout(base + path, { ...opts, headers: serverHeaders(settings) }, 5000);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json?.error || `cache server HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Game-event kinds the content script may relay to the server
// log with POST /api/events. Keep in sync with GAME_EVENT_KINDS
// in server.js. The worker logs its own cache activity to the
// console only; the server records those same requests itself.
const LOG_EVENT_KINDS = new Set([
  "fetch_result", "fetch_error",
  "typing_start", "typing_done", "typing_aborted",
  "submit_attempt", "submit_blocked", "solo_submit",
  "bubble_seen", "outcome_reported", "promote_sent",
  "leftover_cleared",
]);

// Worker-side log line, for the service-worker console (tail it
// in chrome://extensions under Inspect views). One line per
// event, prefixed for filtering; never throws.
function elog(kind, fields) {
  try {
    console.log("[kch-log]", { ts: new Date().toISOString(), kind, ...(fields || {}) });
  } catch (_) {}
}

function cacheWordStyle(req, settings) {
  return req.wordStyle === "common" ? "common" : settings.wordStyle === "common" ? "common" : "rare";
}

// Returns a cached result, or null on any miss (no entry, empty
// entry, exhausted by the caller's excludes, or any server error).
// A cached section that the caller already used up counts as a
// miss, or regeneration would spin on dead lists forever.
async function fetchCache(settings, req) {
  const wordStyle = cacheWordStyle(req, settings);
  const party = !!req.party;
  // Query string by hand: URLSearchParams is not available in
  // every JS realm this code can run in (e.g. a test vm), and the
  // cache lookup must not depend on it.
  const query = `prompt=${encodeURIComponent(req.prompt)}&wordStyle=${wordStyle}&party=${party}`;
  let json;
  try {
    json = await serverRequest(settings, `/api/answers?${query}`, { method: "GET" });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
  if (!json || json.cached !== true) return null;
  const exclude = new Set((req.exclude || []).map((x) => canonicalKey(x)));
  const usable = (arr) => (Array.isArray(arr) ? arr.filter((x) => !exclude.has(canonicalKey(x))) : []);
  const kind = req.kind === "rare" || req.kind === "common" ? req.kind : "both";
  if (!party) {
    if (!usable(json.candidates).length) return null;
    return { candidates: json.candidates, model: json.model, usage: json.usage, cached: true };
  }
  if (kind === "rare" && !usable(json.rare).length) return null;
  if (kind === "common" && !usable(json.common).length) return null;
  if (kind === "both" && !usable([...(json.rare || []), ...(json.common || [])]).length) return null;
  return {
    candidates: [...(json.rare || []), ...(json.common || [])],
    rare: json.rare || [], common: json.common || [],
    model: json.model, usage: json.usage, cached: true,
  };
}

// Best-effort store: never fail an answer because the cache store
// failed. The server dedups by text key, so re-storing is safe.
async function storeCache(settings, req, result, rawText) {
  const wordStyle = cacheWordStyle(req, settings);
  const party = !!req.party;
  return serverRequest(settings, "/api/answers", {
    method: "POST",
    body: JSON.stringify({
      prompt: req.prompt, wordStyle, party,
      rare: party ? result.rare || [] : [],
      common: party ? result.common || [] : [],
      candidates: party ? [] : result.candidates || [],
      model: result.model, rawText: rawText || "",
    }),
  });
}

async function getCacheStats() {
  const settings = await getSettings();
  if (settings.enabled === false) return { ok: false, error: "Krillion Helper is disabled." };
  const base = serverBase(settings);
  if (!base) return { ok: false, error: "No cache server URL set." };
  const json = await serverRequest(settings, "/api/prompts", { method: "GET" });
  return { ok: true, prompts: json.prompts || [] };
}

async function reportFeedback(msg) {
  const settings = await getSettings();
  if (settings.enabled === false) return false;
  const base = serverBase(settings);
  if (!base) return false;
  if (typeof msg.prompt !== "string" || typeof msg.text !== "string") return false;
  const fields = {
    prompt: msg.prompt, text: msg.text,
    outcome: msg.outcome, source: msg.source || "banner",
  };
  try {
    await serverRequest(settings, "/api/feedback", {
      method: "POST",
      body: JSON.stringify({
        prompt: msg.prompt,
        wordStyle: msg.wordStyle === "common" ? "common" : "rare",
        party: typeof msg.party === "boolean" ? msg.party : true,
        text: msg.text,
        outcome: msg.outcome,
        source: msg.source || "banner",
      }),
    });
  } catch (e) {
    elog("feedback_error", { ...fields, error: e.message || String(e) });
    throw e;
  }
  elog("feedback_sent", fields);
  return true;
}

// Relay one content-script game event to the server log.
// Best-effort: the game never waits on it, and unknown kinds are
// dropped without a request.
async function logEvent(msg) {
  const settings = await getSettings();
  if (settings.enabled === false) return false;
  if (!serverBase(settings)) return false;
  if (!msg || typeof msg.kind !== "string" || !LOG_EVENT_KINDS.has(msg.kind)) return false;
  if (msg.prompt !== undefined && msg.prompt !== null && typeof msg.prompt !== "string") return false;
  if (msg.text !== undefined && msg.text !== null && typeof msg.text !== "string") return false;
  if (msg.detail !== undefined && msg.detail !== null && (typeof msg.detail !== "object" || Array.isArray(msg.detail))) return false;
  await serverRequest(settings, "/api/events", {
    method: "POST",
    body: JSON.stringify({
      kind: msg.kind, prompt: msg.prompt ?? null, text: msg.text ?? null, detail: msg.detail ?? null,
    }),
  });
  return true;
}

// Best-effort krillion promotion: learn an opponent's
// one-in-a-krillion answer into the cache's rare list. The server
// enforces the tier and the position; the worker only relays.
async function promoteKrillion(msg) {
  const settings = await getSettings();
  if (settings.enabled === false) return false;
  const base = serverBase(settings);
  if (!base) return false;
  if (typeof msg.prompt !== "string" || typeof msg.text !== "string") return false;
  try {
    await serverRequest(settings, "/api/promote", {
      method: "POST",
      body: JSON.stringify({ prompt: msg.prompt, text: msg.text, tier: "krillion" }),
    });
  } catch (e) {
    elog("promote_error", { prompt: msg.prompt, text: msg.text, error: e.message || String(e) });
    throw e;
  }
  elog("promote_sent", { prompt: msg.prompt, text: msg.text });
  return true;
}

async function getAnswers(req) {
  const settings = await getSettings();
  if (settings.enabled === false) throw new Error("Krillion Helper is disabled. Turn it on in the extension popup.");

  // Cache first: a warm cache needs no API key at all. Any cache
  // failure is a miss and falls through to Anthropic below.
  const wordStyle = cacheWordStyle(req, settings);
  const party = !!req.party;
  try {
    const cached = await fetchCache(settings, req);
    if (cached) {
      elog("cache_hit", {
        prompt: req.prompt, wordStyle, party, cached: true,
        rare: cached.rare ? cached.rare.length : null,
        common: cached.common ? cached.common.length : null,
        candidates: cached.candidates ? cached.candidates.length : null,
      });
      return cached;
    }
    elog("cache_miss", { prompt: req.prompt, wordStyle, party, cached: false });
  } catch (e) {
    elog("cache_error", { prompt: req.prompt, wordStyle, party, error: e.message || String(e) });
    // Fall through to Anthropic.
  }
  if (!settings.apiKey) throw new Error("No API key set. Click the extension icon to add one.");

  // Transient failures get up to three attempts with backoff
  // (the server's Retry-After, capped so a retry can still land
  // inside the answer window). Anything else fails at once.
  let json;
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      json = await callApiWithFallback(req, settings);
      break;
    } catch (e) {
      lastError = e;
      const retryable = e.status === 429 || e.status === 500 || e.status === 502 || e.status === 503 || e.status === 529;
      if (!retryable || attempt === 2) throw e;
      await sleep(Math.min(e.retryAfterMs != null ? e.retryAfterMs : 500 * (attempt + 1), 3000));
    }
  }
  if (!json) throw lastError || new Error("no response from the answer API.");

  if (json.stop_reason === "refusal") {
    throw new Error("the model declined this prompt (" + (json.stop_details?.category || "refusal") + ").");
  }
  if (json.stop_reason === "max_tokens") {
    throw new Error("the model reply was truncated (max_tokens); no complete candidate list was returned.");
  }
  if (json.stop_reason === "error") {
    throw new Error("the model returned an error and no candidates.");
  }
  const text = (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (req.party) {
    const commonOnly = req.wordStyle === "common";
    const kind = commonOnly ? "common" : req.kind === "rare" || req.kind === "common" ? req.kind : "both";
    const sections = parseSections(text, req.exclude, {
      // The fallback split must match the request: 12 rare + 10
      // common, so the last 10 of a flat list are the bench.
      tailSize: kind === "both" ? 10 : 0,
      defaultSection: kind === "rare" ? "rare" : kind === "common" ? "common" : null,
    });
    // Common-only play has no rare list even if the model ignored
    // the heading and sectioned its reply: every sectioned answer
    // is a bench answer, in reply order.
    const rare = commonOnly ? [] : sections.rare;
    const common = commonOnly ? [...sections.rare, ...sections.common] : sections.common;
    const candidates = [...rare, ...common];
    if (!candidates.length) throw new Error("no usable candidates returned.");
    const result = { candidates, rare, common, model: json.model, usage: json.usage };
    let stored = null;
    try {
      const storedRes = await storeCache(settings, req, result, text);
      stored = storedRes && storedRes.stored != null ? storedRes.stored : null;
    } catch (_) {}
    elog("api_answer", {
      prompt: req.prompt, wordStyle, party, cached: false,
      model: json.model, candidates: candidates.length, rare: rare.length, common: common.length, stored,
    });
    return result;
  }
  const candidates = parseCandidates(text, req.exclude);
  if (!candidates.length) throw new Error("no usable candidates returned.");
  const result = { candidates, model: json.model, usage: json.usage };
  let stored = null;
  try {
    const storedRes = await storeCache(settings, req, result, text);
    stored = storedRes && storedRes.stored != null ? storedRes.stored : null;
  } catch (_) {}
  elog("api_answer", {
    prompt: req.prompt, wordStyle, party, cached: false,
    model: json.model, candidates: candidates.length, stored,
  });
  return result;
}

async function testKey(apiKey) {
  const res = await fetchWithTimeout(MODELS_URL + "?limit=1", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  }, 15000);
  if (res.ok) return { ok: true };
  const json = await res.json().catch(() => ({}));
  return { ok: false, error: json?.error?.message || `HTTP ${res.status}` };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "getAnswers") {
    getAnswers(msg)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === "testKey") {
    testKey(msg.apiKey)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === "reportOutcome") {
    // Best-effort outcome reporting for server curation; the
    // game result never waits on it beyond this response.
    reportFeedback(msg)
      .then((ok) => sendResponse({ ok }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === "promoteKrillion") {
    // Best-effort learning; the game result never waits on it
    // beyond this response.
    promoteKrillion(msg)
      .then((ok) => sendResponse({ ok }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === "logEvent") {
    // Best-effort relay of one content-script game event to the
    // server log; the game never waits on it beyond this response.
    logEvent(msg)
      .then((ok) => sendResponse({ ok }))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg?.type === "getCacheStats") {
    getCacheStats()
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  // No getSettings handler: nothing in the extension asks the
  // worker for settings (popup and content script read storage
  // directly), and answering would hand the API key to any
  // same-extension sender that asks for it.
  return false;
});
