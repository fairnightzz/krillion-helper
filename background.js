// Service worker: calls the answer API with the user's key.
// Content scripts never see the key; they just ask for answers.

const API_URL = "https://api.anthropic.com/v1/messages";
const MODELS_URL = "https://api.anthropic.com/v1/models";

const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "low",
  mode: "auto",        // auto | fill | suggest
  autoAdvance: false,
  showOverlay: true,
  autoEnter: false,
  candidateCount: 8,
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
  rarest first among them. For a single list, make the last few
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

function buildUserMessage(prompt, exclude, party, kind, count) {
  if (!party) {
    const soloCount = count == null ? DEFAULTS.candidateCount : count;
    let text = `Game prompt: "${prompt}"\n\nGive ${soloCount} candidate answers, rarest first (last 2 are safe fallbacks).`;
    if (exclude && exclude.length) {
      text += `\n\nThese were already REJECTED by the game as not in the answer set, do not repeat them and avoid anything similarly obscure:\n`;
      text += exclude.map((e) => `- ${e}`).join("\n");
    }
    return text;
  }
  // Party games get two lists: rare answers to chase depth, and a
  // separate common bench (a duel most of all runs many turns per
  // category, so one or two safe answers are not enough). Each list
  // regenerates on its own when it runs out.
  let text;
  if (kind === "rare") {
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
  if (w === "grey") return "gray";
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
    .replace(/[“”"]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((token) => token.split("-").map((part) => canonicalWord(part.replace(/[.,;:!?]+$/, ""))).join("-"))
    .join(" ");
}

// A whole-line section heading: "RARE:", "## Common", "**COMMON:**",
// "Safe answers", and so on. Anything else is a candidate line.
function sectionHeaderKind(line) {
  const h = line
    .trim()
    .replace(/^[#>*\-•\s\*\_]+/, "")
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

async function callApi({ prompt, exclude, party, kind }, settings, useFallbacks) {
  const headers = {
    "content-type": "application/json",
    "x-api-key": settings.apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  };
  const count = party ? (kind === "rare" ? 12 : kind === "common" ? 10 : 22) : settings.candidateCount;
  const body = {
    model: settings.model,
    max_tokens: 4000,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(prompt, exclude, party, kind, count) }],
  };
  if (supportsEffort(settings.model)) {
    body.output_config = { effort: settings.effort || "low" };
  }
  if (useFallbacks && supportsDefaultFallbacks(settings.model)) {
    headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    body.fallbacks = "default";
  }
  const res = await fetch(API_URL, { method: "POST", headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return json;
}

async function getAnswers(req) {
  const settings = await getSettings();
  if (!settings.apiKey) throw new Error("No API key set. Click the extension icon to add one.");

  let json;
  try {
    json = await callApi(req, settings, true);
  } catch (e) {
    // If the fallback beta isn't accepted for some reason, retry plainly.
    if (e.status === 400 && supportsDefaultFallbacks(settings.model)) {
      json = await callApi(req, settings, false);
    } else {
      throw e;
    }
  }

  if (json.stop_reason === "refusal") {
    throw new Error("the model declined this prompt (" + (json.stop_details?.category || "refusal") + ").");
  }
  const text = (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  if (req.party) {
    const kind = req.kind === "rare" || req.kind === "common" ? req.kind : "both";
    const sections = parseSections(text, req.exclude, {
      tailSize: kind === "both" ? 6 : 0,
      defaultSection: kind === "rare" ? "rare" : kind === "common" ? "common" : null,
    });
    const candidates = [...sections.rare, ...sections.common];
    if (!candidates.length) throw new Error("no usable candidates returned.");
    return { candidates, rare: sections.rare, common: sections.common, model: json.model, usage: json.usage };
  }
  const candidates = parseCandidates(text, req.exclude);
  if (!candidates.length) throw new Error("no usable candidates returned.");
  return { candidates, model: json.model, usage: json.usage };
}

async function testKey(apiKey) {
  const res = await fetch(MODELS_URL + "?limit=1", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
  });
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
  if (msg?.type === "getSettings") {
    getSettings().then(sendResponse);
    return true;
  }
  return false;
});
