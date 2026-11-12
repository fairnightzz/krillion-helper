"use strict";
// Server tests. Run with: npm --prefix server test
// (needs --experimental-sqlite on Node 22).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createServer, promptKey, textKey, isAutoHidden } = require("./server.js");

const TOKEN = "test-token";

async function start(t) {
  const server = createServer({ dbPath: ":memory:", token: TOKEN });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return base;
}

async function req(base, path, opts = {}) {
  const res = await fetch(base + path, {
    ...opts,
    headers: { "content-type": "application/json", "x-kch-token": TOKEN, ...(opts.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

test("health answers without a token; api routes require one", async (t) => {
  const base = await start(t);
  const health = await fetch(base + "/health");
  assert.equal(health.status, 200);
  const noToken = await fetch(base + "/api/prompts");
  assert.equal(noToken.status, 401);
  const wrong = await fetch(base + "/api/prompts", { headers: { "x-kch-token": "nope" } });
  assert.equal(wrong.status, 401);
});

test("cache miss, store, and normalized-prompt hit", async (t) => {
  const base = await start(t);
  const miss = await req(base, "/api/answers?prompt=" + encodeURIComponent("Name a noodle dish") + "&wordStyle=rare&party=true");
  assert.equal(miss.status, 404);
  assert.equal(miss.body.cached, false);
  const stored = await req(base, "/api/answers", {
    method: "POST",
    body: JSON.stringify({
      prompt: "Name a noodle dish", wordStyle: "rare", party: true,
      rare: ["Udon", "Ramen"], common: ["Pho", "Pad thai"], model: "claude-opus-5-5", rawText: "Udon\nRamen\n",
    }),
  });
  assert.equal(stored.status, 200);
  assert.equal(stored.body.stored, 4);
  // Different casing and trailing punctuation hit the same entry.
  const hit = await req(base, "/api/answers?prompt=" + encodeURIComponent("  NAME A Noodle Dish. ") + "&wordStyle=rare&party=true");
  assert.equal(hit.status, 200);
  assert.equal(hit.body.cached, true);
  assert.deepEqual(hit.body.rare, ["Udon", "Ramen"]);
  assert.deepEqual(hit.body.common, ["Pho", "Pad thai"]);
  assert.deepEqual(hit.body.candidates, ["Udon", "Ramen", "Pho", "Pad thai"]);
});

test("storing the same answers twice does not duplicate them", async (t) => {
  const base = await start(t);
  const body = { prompt: "Name a noodle dish", wordStyle: "rare", party: true, rare: ["Udon"], common: ["Pho"] };
  assert.equal((await req(base, "/api/answers", { method: "POST", body: JSON.stringify(body) })).body.stored, 2);
  const again = await req(base, "/api/answers", { method: "POST", body: JSON.stringify(body) });
  assert.equal(again.body.stored, 0);
  const hit = await req(base, "/api/answers?prompt=" + encodeURIComponent("Name a noodle dish") + "&wordStyle=rare&party=true");
  assert.deepEqual(hit.body.rare, ["Udon"]);
  assert.deepEqual(hit.body.common, ["Pho"]);
});

test("feedback auto-hides after one uncontested rejection; acceptances and duplicates veto it", async (t) => {
  const base = await start(t);
  const prompt = "Name a noodle dish";
  const q = encodeURIComponent(prompt);
  await req(base, "/api/answers", {
    method: "POST",
    body: JSON.stringify({ prompt, wordStyle: "rare", party: true, rare: ["Udon", "Ramen"], common: ["Pho"] }),
  });
  const feedback = (text, outcome) => req(base, "/api/feedback", {
    method: "POST",
    body: JSON.stringify({ prompt, wordStyle: "rare", party: true, text, outcome, source: "own" }),
  });
  await feedback("Udon", "rejected");
  let hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.deepEqual(hit.body.rare, ["Ramen"]);
  await feedback("Udon", "duplicate");
  hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.deepEqual(hit.body.rare, ["Udon", "Ramen"]);
  await feedback("Ramen", "accepted");
  await feedback("Ramen", "rejected");
  hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.deepEqual(hit.body.rare, ["Udon", "Ramen"]);
  const stats = await req(base, `/api/stats?prompt=${q}&wordStyle=rare&party=true`);
  const udon = stats.body.answers.find((a) => a.text === "Udon");
  assert.equal(udon.rejected, 1);
  assert.equal(udon.duplicate, 1);
  assert.equal(udon.autoHidden, false);
  const ramen = stats.body.answers.find((a) => a.text === "Ramen");
  assert.equal(ramen.accepted, 1);
  assert.equal(ramen.rejected, 1);
  assert.equal(ramen.autoHidden, false);
});

test("manual delete hides one answer; deleting a prompt removes it", async (t) => {
  const base = await start(t);
  const prompt = "Name a noodle dish";
  const q = encodeURIComponent(prompt);
  await req(base, "/api/answers", {
    method: "POST",
    body: JSON.stringify({ prompt, wordStyle: "rare", party: true, rare: ["Udon", "Ramen"], common: ["Pho"] }),
  });
  const del = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true&text=${encodeURIComponent("Pho")}`, { method: "DELETE" });
  assert.equal(del.body.removed, 1);
  const hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.deepEqual(hit.body.common, []);
  assert.deepEqual(hit.body.candidates, ["Udon", "Ramen"]);
  const delPrompt = await req(base, `/api/prompts?prompt=${q}&wordStyle=rare&party=true`, { method: "DELETE" });
  assert.equal(delPrompt.body.deleted, true);
  const miss = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.equal(miss.status, 404);
});

test("validation rejects bad wordStyle, outcomes, and missing prompts", async (t) => {
  const base = await start(t);
  const badStyle = await req(base, "/api/answers", {
    method: "POST",
    body: JSON.stringify({ prompt: "x", wordStyle: "bogus", party: true, rare: ["Udon"] }),
  });
  assert.equal(badStyle.status, 400);
  const badOutcome = await req(base, "/api/feedback", {
    method: "POST",
    body: JSON.stringify({ prompt: "x", wordStyle: "rare", party: true, text: "Udon", outcome: "meh" }),
  });
  assert.equal(badOutcome.status, 400);
  const noPrompt = await req(base, "/api/answers?wordStyle=rare&party=true");
  assert.equal(noPrompt.status, 400);
});

test("keys normalize prompts and fold answer text", () => {
  assert.equal(promptKey("  Name A Noodle Dish? "), "name a noodle dish");
  assert.equal(promptKey("Name a noodle dish"), promptKey("NAME A  NOODLE DISH."));
  assert.equal(textKey("Crème Brûlée"), "cremebrulee");
  assert.equal(textKey("Battleship Gray"), textKey("battleship gray"));
  assert.notEqual(textKey("Battleship Gray"), textKey("Battleship Grey"));
  assert.equal(isAutoHidden({ accepted: 0, duplicate: 0, rejected: 1 }), true);
  assert.equal(isAutoHidden({ accepted: 0, duplicate: 0, rejected: 3 }), true);
  assert.equal(isAutoHidden({ accepted: 0, duplicate: 1, rejected: 3 }), false);
  assert.equal(isAutoHidden({ accepted: 1, duplicate: 0, rejected: 3 }), false);
  assert.equal(isAutoHidden({ accepted: 0, duplicate: 0, rejected: 0 }), false);
});
