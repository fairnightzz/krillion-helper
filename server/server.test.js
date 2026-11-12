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

test("promote inserts only a krillion answer at rare index 4, dedups, and never resurrects removed ones", async (t) => {
  const base = await start(t);
  const prompt = "Name a noodle dish";
  const q = encodeURIComponent(prompt);
  const rare12 = Array.from({ length: 12 }, (_, i) => `Rare${i + 1}`);
  await req(base, "/api/answers", {
    method: "POST",
    body: JSON.stringify({ prompt, wordStyle: "rare", party: true, rare: rare12, common: ["Pho", "Pad thai"] }),
  });
  const promote = (text, tier) => req(base, "/api/promote", {
    method: "POST",
    body: JSON.stringify({ prompt, text, tier }),
  });
  // Only the krillion tier is learnable; other tiers are rejected.
  assert.equal((await promote("PlanktonWord", "plankton")).status, 400);
  assert.equal((await promote("SchoolerWord", "schooler")).status, 400);
  const first = await promote("KrillionWord", "krillion");
  assert.equal(first.status, 200);
  assert.equal(first.body.stored, true);
  assert.equal(first.body.position, 4);
  let hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.equal(hit.body.rare.length, 13);
  assert.equal(hit.body.rare[4], "KrillionWord");
  assert.deepEqual(hit.body.rare.slice(0, 4), rare12.slice(0, 4));
  assert.deepEqual(hit.body.rare.slice(5), rare12.slice(4));
  assert.deepEqual(hit.body.common, ["Pho", "Pad thai"]);
  // A second promotion of the same word is a no-op, not a duplicate.
  const again = await promote("KRILLIONWORD", "krillion");
  assert.equal(again.body.stored, false);
  assert.equal(again.body.already, true);
  hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.equal(hit.body.rare.filter((w) => w === "KrillionWord").length, 1);
  // A short rare list appends at the end: still within the top 5.
  const shortPrompt = "Name a short dish";
  const sq = encodeURIComponent(shortPrompt);
  await req(base, "/api/answers", {
    method: "POST",
    body: JSON.stringify({ prompt: shortPrompt, wordStyle: "rare", party: true, rare: ["One", "Two"], common: [] }),
  });
  const short = await req(base, "/api/promote", {
    method: "POST",
    body: JSON.stringify({ prompt: shortPrompt, text: "ShortKrillion", tier: "krillion" }),
  });
  assert.equal(short.body.position, 2);
  const shortHit = await req(base, `/api/answers?prompt=${sq}&wordStyle=rare&party=true`);
  assert.deepEqual(shortHit.body.rare, ["One", "Two", "ShortKrillion"]);
  // A word already in the common bench moves to rare index 4.
  const moved = await promote("Pho", "krillion");
  assert.equal(moved.body.stored, true);
  assert.equal(moved.body.position, 4);
  hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.equal(hit.body.rare[4], "Pho");
  assert.deepEqual(hit.body.common, ["Pad thai"]);
  // A manually removed word is never resurrected by promotion.
  await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true&text=${encodeURIComponent("Pad thai")}`, { method: "DELETE" });
  const removed = await promote("Pad thai", "krillion");
  assert.equal(removed.body.stored, false);
  assert.equal(removed.body.removed, true);
  hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.ok(!hit.body.common.includes("Pad thai"));
  assert.ok(!hit.body.rare.includes("Pad thai"));
  // Promotion creates a prompt row when there is none yet.
  const fresh = await req(base, "/api/promote", {
    method: "POST",
    body: JSON.stringify({ prompt: "Name a fresh dish", text: "FirstKrillion", tier: "krillion" }),
  });
  assert.equal(fresh.body.stored, true);
  assert.equal(fresh.body.position, 0);
  const freshHit = await req(base, "/api/answers?prompt=" + encodeURIComponent("Name a fresh dish") + "&wordStyle=rare&party=true");
  assert.deepEqual(freshHit.body.rare, ["FirstKrillion"]);
});
