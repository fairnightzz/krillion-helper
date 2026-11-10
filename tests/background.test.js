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

const SETTINGS = { apiKey: "sk-ant-test", model: "claude-opus-5-5", effort: "low", mode: "auto", candidateCount: 8 };
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
