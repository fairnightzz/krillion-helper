const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadWorker({ settings, responses, fastTimers }) {
  const calls = [];
  let queue = [...responses];
  const fetchStub = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, headers: { ...(opts ? opts.headers : {}) }, body, signal: opts ? opts.signal : undefined });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: { get: (k) => ((next.headers || {})[k.toLowerCase()] ?? null) },
      json: async () => next.json,
    };
  };
  const realSetTimeout = setTimeout;
  const ctx = vm.createContext({
    console,
    AbortController,
    fetch: fetchStub,
    setTimeout: fastTimers
      ? (fn, ms, ...args) => realSetTimeout(fn, ms > 1000 ? 0 : ms, ...args)
      : realSetTimeout,
    clearTimeout,
    chrome: {
      storage: { local: { get: async () => ({ ...settings }) } },
      runtime: { onMessage: { addListener(fn) { ctx.__listener = fn; } } },
    },
  });
  const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInContext(code, ctx);
  vm.runInContext("globalThis.__getAnswers = getAnswers;", ctx);
  vm.runInContext("globalThis.__testKey = testKey;", ctx);
  const ask = async (req) => {
    const out = await vm.runInContext(`__getAnswers(${JSON.stringify(req)})`, ctx);
    return JSON.parse(JSON.stringify(out));
  };
  return { calls, ctx, ask };
}

function textReply(text, extra) {
  return {
    status: 200,
    json: { model: "claude-opus-5-5", stop_reason: "end_turn", usage: {}, content: [{ type: "text", text }], ...(extra || {}) },
  };
}
function errorReply(status, message, headers) {
  return { status, headers: headers || {}, json: { error: { message } } };
}

const SETTINGS = { apiKey: "sk-ant-test", model: "claude-opus-5-5", effort: "low", mode: "auto", candidateCount: 8, serverUrl: "", serverToken: "" };
const FLAT_22 = Array.from({ length: 22 }, (_, i) => `Word${i + 1}`).join("\n");

test("a 429 with Retry-After is retried and then succeeds", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [errorReply(429, "rate limited", { "retry-after": "0" }), textReply("Udon\nRamen\n")] });
  const out = await w.ask({ prompt: "Name a noodle dish", exclude: [], party: false });
  assert.equal(w.calls.length, 2);
  assert.deepEqual(out.candidates, ["Udon", "Ramen"]);
});

test("a 429 that persists fails after three attempts", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [errorReply(429, "rate limited"), errorReply(429, "rate limited"), errorReply(429, "rate limited")] });
  await assert.rejects(() => w.ask({ prompt: "Name a noodle dish", exclude: [], party: false }), /rate limited/);
  assert.equal(w.calls.length, 3);
});

test("a 400 from the fallback beta is retried without the beta or fallbacks", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [errorReply(400, "beta rejected"), textReply("Udon\n")] });
  const out = await w.ask({ prompt: "Name a noodle dish", exclude: [], party: false });
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[0].headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(w.calls[0].body.fallbacks, "default");
  assert.equal(w.calls[1].headers["anthropic-beta"], undefined);
  assert.equal(w.calls[1].body.fallbacks, undefined);
  assert.deepEqual(out.candidates, ["Udon"]);
});

test("a truncated reply is an error, not a partial list", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [textReply("Udon\nRam", { stop_reason: "max_tokens" })] });
  await assert.rejects(() => w.ask({ prompt: "Name a noodle dish", exclude: [], party: false }), /truncated/);
  assert.equal(w.calls.length, 1);
});

test("a heading-less party reply splits 12 rare and 10 common", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [textReply(FLAT_22)] });
  const out = await w.ask({ prompt: "Name a word", exclude: [], party: true, kind: "both" });
  assert.equal(out.rare.length, 12);
  assert.equal(out.common.length, 10);
  assert.equal(out.common[0], "Word13");
});

test("section headings with counts and numbering are headings, not candidates", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [textReply("RARE (12):\nUdon\n1. COMMON:\nPho\nPad thai\n")] });
  const out = await w.ask({ prompt: "Name a noodle dish", exclude: [], party: true, kind: "both" });
  assert.deepEqual(out.rare, ["Udon"]);
  assert.deepEqual(out.common, ["Pho", "Pad thai"]);
});

test("a request that never answers times out instead of hanging", async () => {
  const calls = [];
  const ctx = vm.createContext({
    console,
    AbortController,
    fetch: async (_url, opts) => {
      calls.push(opts.signal);
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    },
    setTimeout: (fn, ms, ...args) => setTimeout(fn, ms > 1000 ? 0 : ms, ...args),
    clearTimeout,
    chrome: {
      storage: { local: { get: async () => ({ ...SETTINGS }) } },
      runtime: { onMessage: { addListener() {} } },
    },
  });
  const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  vm.runInContext(code, ctx);
  vm.runInContext("globalThis.__getAnswers = getAnswers;", ctx);
  await assert.rejects(() => vm.runInContext("__getAnswers({prompt: 'x', exclude: [], party: false})", ctx), /timed out/);
  assert.equal(calls.length, 1);
});

test("there is no getSettings message handler", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [textReply("Udon\n")] });
  const listener = w.ctx.__listener;
  assert.ok(listener, "onMessage listener must be registered");
  let responded = false;
  const ret = listener({ type: "getSettings" }, {}, () => { responded = true; });
  assert.equal(ret, false);
  assert.equal(responded, false);
});

test("common-only solo asks for common answers, not rarest-first", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [textReply("Pho\nPad thai\n")] });
  const out = await w.ask({ prompt: "Name a noodle dish", exclude: [], party: false, wordStyle: "common" });
  const message = w.calls[0].body.messages[0].content;
  assert.match(message, /COMMON candidate answers/);
  assert.match(message, /certain to be accepted/);
  assert.doesNotMatch(message, /safe fallbacks/);
  assert.deepEqual(out.candidates, ["Pho", "Pad thai"]);
});

test("common-only party merges sectioned replies into the common list", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [textReply("RARE:\nUdon\nCOMMON:\nPho\nPad thai\n")] });
  const out = await w.ask({ prompt: "Name a noodle dish", exclude: [], party: true, kind: "both", wordStyle: "common" });
  const message = w.calls[0].body.messages[0].content;
  assert.match(message, /Give 22 COMMON/);
  assert.doesNotMatch(message, /12 RARE/);
  assert.deepEqual(out.rare, []);
  assert.deepEqual(out.common, ["Udon", "Pho", "Pad thai"]);
});

test("common-only party puts a flat reply entirely in the common list", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [textReply(FLAT_22)] });
  const out = await w.ask({ prompt: "Name a word", exclude: [], party: true, kind: "both", wordStyle: "common" });
  assert.deepEqual(out.rare, []);
  assert.equal(out.common.length, 22);
});

test("a disabled helper refuses answer requests without calling the API", async () => {
  const w = loadWorker({ settings: { ...SETTINGS, enabled: false }, responses: [textReply("Udon\n")] });
  await assert.rejects(() => w.ask({ prompt: "Name a noodle dish", exclude: [], party: false }), /disabled/);
  assert.equal(w.calls.length, 0);
});

test("common-only requests ask most-common-first, in party and solo", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [textReply("Pho\nPad thai\n"), textReply("Pho\nPad thai\n")] });
  await w.ask({ prompt: "Name a noodle dish", exclude: [], party: true, kind: "both", wordStyle: "common" });
  assert.match(w.calls[0].body.messages[0].content, /most common first/);
  await w.ask({ prompt: "Name a noodle dish", exclude: [], party: false, wordStyle: "common" });
  assert.match(w.calls[1].body.messages[0].content, /most common first/);
});

function cacheHit(rare, common) {
  return {
    status: 200,
    json: { cached: true, rare, common, candidates: [...rare, ...common], model: "claude-opus-5-5", usage: {} },
  };
}

test("a cache hit returns stored lists without calling Anthropic", async () => {
  const w = loadWorker({
    settings: { ...SETTINGS, serverUrl: "http://localhost:8787", serverToken: "tok" },
    responses: [cacheHit(["Udon"], ["Pho"])],
  });
  const out = await w.ask({ prompt: "Name a noodle dish", exclude: [], party: true, kind: "both", wordStyle: "rare" });
  assert.deepEqual(out.rare, ["Udon"]);
  assert.deepEqual(out.common, ["Pho"]);
  assert.equal(out.cached, true);
  assert.equal(w.calls.length, 1);
  assert.ok(w.calls[0].url.includes("localhost:8787/api/answers"));
  assert.equal(w.calls[0].headers["x-kch-token"], "tok");
});

test("a cache miss calls Anthropic and stores the result on the server", async () => {
  const w = loadWorker({
    settings: { ...SETTINGS, serverUrl: "http://localhost:8787" },
    responses: [
      { status: 404, json: { cached: false } },
      textReply("Udon\nRamen\n"),
      { status: 200, json: { ok: true, stored: 2 } },
    ],
  });
  const out = await w.ask({ prompt: "Name a noodle dish", exclude: [], party: false });
  assert.deepEqual(out.candidates, ["Udon", "Ramen"]);
  assert.equal(w.calls.length, 3);
  assert.ok(w.calls[0].url.includes("localhost:8787/api/answers"));
  assert.ok(w.calls[1].url.includes("api.anthropic.com"));
  assert.equal(w.calls[2].body.candidates.length, 2);
  assert.equal(w.calls[2].body.model, "claude-opus-5-5");
});

test("a cache section exhausted by excludes counts as a miss", async () => {
  const w = loadWorker({
    settings: { ...SETTINGS, serverUrl: "http://localhost:8787" },
    responses: [
      cacheHit(["Udon"], []),
      textReply("Ramen\n"),
      { status: 200, json: { ok: true, stored: 1 } },
    ],
  });
  const out = await w.ask({ prompt: "Name a noodle dish", exclude: ["Udon"], party: true, kind: "rare" });
  assert.deepEqual(out.rare, ["Ramen"]);
  assert.ok(w.calls.some((c) => c.url.includes("api.anthropic.com")));
});

test("a cache server failure falls back to Anthropic", async () => {
  const w = loadWorker({
    settings: { ...SETTINGS, serverUrl: "http://localhost:8787" },
    responses: [
      new Error("connection refused"),
      textReply("Udon\n"),
      { status: 200, json: { ok: true, stored: 1 } },
    ],
  });
  const out = await w.ask({ prompt: "Name a noodle dish", exclude: [], party: false });
  assert.deepEqual(out.candidates, ["Udon"]);
});

test("reportOutcome posts the outcome to the cache server", async () => {
  const w = loadWorker({
    settings: { ...SETTINGS, serverUrl: "http://localhost:8787", serverToken: "tok" },
    responses: [{ status: 200, json: { ok: true } }],
  });
  const answer = await new Promise((resolve) => {
    w.ctx.__listener(
      { type: "reportOutcome", prompt: "Name a noodle dish", wordStyle: "rare", party: true, text: "Udon", outcome: "duplicate", source: "banner" },
      {},
      resolve,
    );
  });
  assert.equal(answer.ok, true);
  assert.equal(w.calls.length, 1);
  assert.ok(w.calls[0].url.includes("localhost:8787/api/feedback"));
  assert.equal(w.calls[0].body.outcome, "duplicate");
  assert.equal(w.calls[0].body.text, "Udon");
  assert.equal(w.calls[0].headers["x-kch-token"], "tok");
});

test("getCacheStats returns the server prompt list", async () => {
  const w = loadWorker({
    settings: { ...SETTINGS, serverUrl: "http://localhost:8787" },
    responses: [{ status: 200, json: { prompts: [{ prompt: "Name a noodle dish", rare: 2, common: 1, solo: 0 }] } }],
  });
  const answer = await new Promise((resolve) => {
    w.ctx.__listener({ type: "getCacheStats" }, {}, resolve);
  });
  assert.equal(answer.ok, true);
  assert.equal(answer.prompts.length, 1);
  assert.equal(answer.prompts[0].prompt, "Name a noodle dish");
  assert.equal(w.calls.length, 1);
  assert.ok(w.calls[0].url.includes("/api/prompts"));
});

test("getCacheStats without a server URL explains itself without fetching", async () => {
  const w = loadWorker({
    settings: SETTINGS,
    responses: [{ status: 200, json: { prompts: [] } }],
  });
  const answer = await new Promise((resolve) => {
    w.ctx.__listener({ type: "getCacheStats" }, {}, resolve);
  });
  assert.equal(answer.ok, false);
  assert.equal(w.calls.length, 0);
});

test("the sent system prompt prefers established acronyms and forbids inventing them", async () => {
  const w = loadWorker({ settings: SETTINGS, responses: [textReply("PUBG\n")] });
  await w.ask({ prompt: "Name a video game", exclude: [], party: false });
  const system = w.calls[0].body.system;
  assert.match(system, /acronym/);
  assert.match(system, /PUBG/);
  assert.match(system, /Never invent an abbreviation/);
});
