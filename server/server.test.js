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
  // A word already on the common bench is copied to rare index 4:
  // served once (from rare), and its common entry is kept.
  const moved = await promote("Pho", "krillion");
  assert.equal(moved.body.stored, true);
  assert.equal(moved.body.position, 4);
  hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.equal(hit.body.rare[4], "Pho");
  assert.deepEqual(hit.body.common, ["Pad thai"]);
  assert.equal(hit.body.candidates.filter((w) => w === "Pho").length, 1);
  const stats = await req(base, `/api/stats?prompt=${q}&wordStyle=rare&party=true`);
  assert.deepEqual(stats.body.answers.filter((a) => a.text === "Pho").map((a) => a.listKind).sort(), ["common", "rare"]);
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

test("events record cache hits, misses, stores, feedback, and promotes, and are queryable", async (t) => {
  const base = await start(t);
  const prompt = "Log probe dish";
  const q = encodeURIComponent(prompt);
  const miss = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.equal(miss.status, 404);
  const stored = await req(base, "/api/answers", {
    method: "POST",
    body: JSON.stringify({ prompt, wordStyle: "rare", party: true, rare: ["Udon"], common: ["Pho"] }),
  });
  assert.equal(stored.body.stored, 2);
  const hit = await req(base, `/api/answers?prompt=${q}&wordStyle=rare&party=true`);
  assert.equal(hit.status, 200);
  await req(base, "/api/feedback", {
    method: "POST",
    body: JSON.stringify({ prompt, wordStyle: "rare", party: true, text: "Udon", outcome: "rejected", source: "own" }),
  });
  const promoted = await req(base, "/api/promote", {
    method: "POST",
    body: JSON.stringify({ prompt, text: "LogKrillion", tier: "krillion" }),
  });
  assert.equal(promoted.body.stored, true);
  // Game events from the extension are accepted only for known kinds.
  assert.equal((await req(base, "/api/events", {
    method: "POST",
    body: JSON.stringify({ kind: "bogus", prompt, text: "Zork" }),
  })).status, 400);
  assert.equal((await req(base, "/api/events", {
    method: "POST",
    body: JSON.stringify({ kind: "bubble_seen", prompt, text: "Zork", detail: { tier: "krillion" } }),
  })).status, 200);
  const all = await req(base, "/api/events?limit=100");
  assert.equal(all.status, 200);
  const kinds = all.body.events.map((e) => e.kind);
  for (const kind of ["cache_miss", "cache_store", "cache_hit", "feedback", "promote", "bubble_seen"]) {
    assert.ok(kinds.includes(kind), `missing ${kind}`);
  }
  // Newest first.
  assert.equal(all.body.events[0].kind, "bubble_seen");
  const hitEvent = all.body.events.find((e) => e.kind === "cache_hit");
  assert.equal(hitEvent.prompt, prompt);
  assert.equal(hitEvent.detail.rare, 1);
  assert.equal(hitEvent.detail.common, 1);
  assert.equal(hitEvent.detail.candidates, 2);
  const missEvent = all.body.events.find((e) => e.kind === "cache_miss");
  assert.equal(missEvent.detail.reason, "no_entry");
  const feedbackEvent = all.body.events.find((e) => e.kind === "feedback");
  assert.equal(feedbackEvent.text, "Udon");
  assert.equal(feedbackEvent.detail.outcome, "rejected");
  const promoteEvent = all.body.events.find((e) => e.kind === "promote");
  assert.equal(promoteEvent.detail.stored, true);
  assert.equal(promoteEvent.detail.position, 1);
  const bubbleEvent = all.body.events.find((e) => e.kind === "bubble_seen");
  assert.equal(bubbleEvent.text, "Zork");
  assert.equal(bubbleEvent.detail.tier, "krillion");
  // Filters: kind, prompt substring, and limit.
  const hitsOnly = await req(base, "/api/events?kind=cache_hit");
  assert.ok(hitsOnly.body.events.length >= 1);
  assert.ok(hitsOnly.body.events.every((e) => e.kind === "cache_hit"));
  const byPrompt = await req(base, "/api/events?prompt=" + encodeURIComponent("Log probe"));
  assert.ok(byPrompt.body.events.length >= 1);
  assert.ok(byPrompt.body.events.every((e) => e.prompt.includes("Log probe")));
  const limited = await req(base, "/api/events?limit=2");
  assert.equal(limited.body.events.length, 2);
  // The events endpoint needs the token like every other /api route.
  const noToken = await fetch(base + "/api/events");
  assert.equal(noToken.status, 401);
});

test("overview summarizes questions, outcomes, cache use, and krillion finds", async (t) => {
  const base = await start(t);
  const empty = await req(base, "/api/overview");
  assert.equal(empty.status, 200);
  assert.equal(empty.body.totals.questions, 0);
  assert.deepEqual(empty.body.prompts, []);

  await req(base, "/api/answers?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true");
  await req(base, "/api/answers", { method: "POST", body: JSON.stringify({
    prompt: "Name a noodle dish", wordStyle: "rare", party: true,
    rare: ["Udon", "Soba"], common: ["Pho", "Ramen"], model: "claude-haiku-4-5",
  }) });
  await req(base, "/api/answers?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true");
  await req(base, "/api/answers", { method: "POST", body: JSON.stringify({
    prompt: "Name a noodle dish", wordStyle: "common", party: true, common: ["Pho", "Lo mein"],
  }) });
  for (const [text, outcome] of [["Udon", "accepted"], ["Pho", "duplicate"], ["Soba", "rejected"]]) {
    await req(base, "/api/feedback", { method: "POST", body: JSON.stringify({
      prompt: "Name a noodle dish", wordStyle: "rare", party: true, text, outcome,
    }) });
  }
  await req(base, "/api/promote", { method: "POST", body: JSON.stringify({
    prompt: "Name a noodle dish", text: "Khao soi", tier: "krillion", source: "own",
  }) });

  const { status, body } = await req(base, "/api/overview");
  assert.equal(status, 200);
  const t2 = body.totals;
  assert.equal(t2.questions, 1);
  assert.equal(t2.variants, 2);
  // Soba is auto-hidden after its rejection; Khao soi was promoted.
  assert.deepEqual(t2.answers, { rare: 2, common: 4, solo: 0 });
  assert.equal(t2.hidden, 1);
  assert.deepEqual(t2.feedback, { accepted: 1, duplicate: 1, rejected: 1 });
  assert.deepEqual(t2.cache, { hit: 1, miss: 1, store: 2 });
  assert.equal(t2.krillion, 1);
  assert.deepEqual(t2.models, { "claude-haiku-4-5": 1 });

  const rare = body.prompts.find((p) => p.wordStyle === "rare");
  assert.equal(rare.hits, 1);
  assert.equal(rare.misses, 1);
  assert.deepEqual(rare.krillion, ["Khao soi"]);
  assert.equal(body.krillionFinds[0].text, "Khao soi");
  assert.equal(body.krillionFinds[0].source, "own");
  assert.equal(t2.krillionOwn, 1);
  // Seeing the same krillion answer again is listed as a repeat
  // sighting but is still one distinct find.
  await req(base, "/api/promote", { method: "POST", body: JSON.stringify({
    prompt: "Name a noodle dish", text: "khao soi", tier: "krillion", source: "other",
  }) });
  const again = (await req(base, "/api/overview")).body;
  assert.equal(again.totals.krillion, 1);
  assert.equal(again.totals.krillionSightings, 2);
  assert.equal(again.krillionFinds[0].repeat, true);
  assert.equal(again.krillionFinds[1].repeat, false);
  assert.equal(body.daily.length, 1);
  assert.equal(body.daily[0].hits, 1);

  const noToken = await fetch(base + "/api/overview");
  assert.equal(noToken.status, 401);
});

test("dashboard page is served without a token and holds no data", async (t) => {
  const base = await start(t);
  const root = await fetch(base + "/", { redirect: "manual" });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "/dashboard");
  const page = await fetch(base + "/dashboard");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.headers.get("content-security-policy"), /connect-src 'self'/);
  const html = await page.text();
  assert.match(html, /<title>Krillion Cache<\/title>/);
  assert.match(html, /\/api\/overview/);
});

test("encounters count each question once per round and survive event pruning", async (t) => {
  const { noteEncounter, ENCOUNTER_GAP_MS, openDb } = require("./server.js");
  const base = await start(t);
  // Two lookups in the same round (a refetch) are one encounter.
  await req(base, "/api/answers?prompt=Name%20a%20noodle%20dish&wordStyle=rare&party=true");
  await req(base, "/api/answers?prompt=name%20a%20NOODLE%20dish%3F&wordStyle=common&party=true");
  let o = (await req(base, "/api/overview")).body;
  assert.equal(o.encounters["name a noodle dish"].count, 1);
  assert.equal(o.totals.encounters, 1);
  assert.equal(o.totals.repeatedQuestions, 0);

  // Directly: a sighting after the gap is a new encounter.
  const db = openDb(":memory:");
  const t0 = Date.parse("2026-11-13T00:00:00Z");
  noteEncounter(db, "Name a fruit", new Date(t0).toISOString());
  noteEncounter(db, "Name a fruit", new Date(t0 + 30000).toISOString());
  noteEncounter(db, "Name a fruit", new Date(t0 + 30000 + ENCOUNTER_GAP_MS).toISOString());
  const row = db.prepare("SELECT count, first_seen, last_seen FROM encounters WHERE prompt_key = 'name a fruit'").get();
  assert.equal(row.count, 2);
  assert.equal(row.first_seen, "2026-11-13T00:00:00.000Z");
  db.close();
});

test("encounters backfill from the event log on first open", (t) => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const { openDb } = require("./server.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kch-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "kch.sqlite");
  let db = openDb(file);
  db.exec("DROP TABLE encounters");
  const ins = db.prepare("INSERT INTO events (created_at, kind, prompt_text) VALUES (?, ?, ?)");
  ins.run("2026-11-13T00:00:00.000Z", "cache_miss", "Name a fruit");
  ins.run("2026-11-13T00:00:10.000Z", "cache_hit", "Name a fruit");
  ins.run("2026-11-13T01:00:00.000Z", "cache_hit", "Name a fruit");
  ins.run("2026-11-13T01:00:00.000Z", "feedback", "Name a fruit");
  db.close();
  db = openDb(file);
  const row = db.prepare("SELECT count, last_seen FROM encounters WHERE prompt_key = 'name a fruit'").get();
  assert.equal(row.count, 2);
  assert.equal(row.last_seen, "2026-11-13T01:00:00.000Z");
  db.close();
});
