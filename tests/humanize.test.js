const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadHumanize() {
  const code = fs.readFileSync(path.join(__dirname, "..", "humanize.js"), "utf8");
  const ctx = vm.createContext({ console });
  vm.runInContext(code, ctx);
  const api = ctx.KchHumanize;
  assert.ok(api, "humanize.js must set globalThis.KchHumanize");
  return api;
}

function loadBackground() {
  const code = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  const ctx = vm.createContext({
    console,
    chrome: {
      storage: { local: { get: async () => ({}) } },
      runtime: { onMessage: { addListener() {} } },
    },
  });
  vm.runInContext(code, ctx);
  vm.runInContext("globalThis.__buildUserMessage = buildUserMessage;", ctx);
  vm.runInContext("globalThis.__parseCandidates = parseCandidates;", ctx);
  vm.runInContext("globalThis.__parseSections = parseSections;", ctx);
  vm.runInContext("globalThis.__canonicalKey = canonicalKey;", ctx);
  const fn = (prompt, exclude, party, kind) =>
    vm.runInContext(
      `__buildUserMessage(${JSON.stringify(prompt)}, ${JSON.stringify(exclude)}, ${party}, ${JSON.stringify(kind || null)})`,
      ctx,
    );
  // Array.from / JSON round-trips re-root vm-realm results in this realm.
  fn.parseCandidates = (text, exclude) =>
    Array.from(
      vm.runInContext(`__parseCandidates(${JSON.stringify(text)}, ${JSON.stringify(exclude)})`, ctx),
    );
  fn.parseSections = (text, exclude, options) =>
    JSON.parse(
      JSON.stringify(
        vm.runInContext(
          `__parseSections(${JSON.stringify(text)}, ${JSON.stringify(exclude)}, ${JSON.stringify(options || {})})`,
          ctx,
        ),
      ),
    );
  fn.canonicalKey = (text) => vm.runInContext(`__canonicalKey(${JSON.stringify(text)})`, ctx);
  return fn;
}

function applySteps(steps) {
  let value = "";
  for (const step of steps) value = step.value;
  return value;
}

test("planTyping reconstructs varied answers", () => {
  const { planTyping, createSeededRng } = loadHumanize();
  for (const text of ["Pad thai", "Ulaanbaatar", "a", "New York", "laksa"]) {
    const steps = planTyping(text, createSeededRng(7));
    assert.equal(applySteps(steps), text, text);
    assert.ok(steps.length >= [...text].length, text);
    for (const step of steps) {
      assert.ok(Number.isFinite(step.delay), text);
      assert.ok(step.delay >= 30 && step.delay <= 900, `${text}: delay ${step.delay}`);
      assert.ok(step.value.length <= [...text].length + 1, text);
    }
  }
});

test("planTyping delays are inconsistent, not grid-quantized, slower on spaces", () => {
  const { planTyping, createSeededRng } = loadHumanize();
  const text = "chicken noodle soup";
  const delays = [];
  const spaceDelays = [];
  const letterDelays = [];
  for (let seed = 1; seed <= 20; seed += 1) {
    const steps = planTyping(text, createSeededRng(seed), { allowTypos: false });
    for (let i = 0; i < steps.length; i += 1) {
      delays.push(steps[i].delay);
      if (steps[i].ch === " ") spaceDelays.push(steps[i].delay);
      else letterDelays.push(steps[i].delay);
    }
  }
  assert.ok(new Set(delays).size >= 4, "delays should vary");
  assert.ok(Math.max(...delays) - Math.min(...delays) > 50, "delay spread should be wide");
  assert.ok(delays.some((d) => d % 10 !== 0), "delays must not all sit on a 10ms grid");
  assert.ok(
    delays.some((d) => Math.abs(d % (50 / 3)) > 1e-9),
    "delays must not all sit on a 50/3ms grid",
  );
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(mean(spaceDelays) > mean(letterDelays), "spaces should pause longer on average");
});

test("typos are at most one per answer, never first/last, and self-corrected", () => {
  const { planTyping, createSeededRng } = loadHumanize();
  const text = "spaghetti carbonara";
  const chars = [...text];
  let typoPlans = 0;
  for (let seed = 0; seed < 200; seed += 1) {
    const steps = planTyping(text, createSeededRng(seed));
    const backs = steps.filter((s) => s.op === "backspace");
    assert.ok(backs.length <= 1, `seed ${seed}: at most one typo correction`);
    if (backs.length === 1) {
      typoPlans += 1;
      const bi = steps.indexOf(backs[0]);
      const wrong = steps[bi - 1];
      assert.equal(wrong.op, "type");
      // The wrong char is inserted at some middle position: not first two, not last.
      const pos = wrong.value.length - 1;
      assert.ok(pos >= 2 && pos < chars.length - 1, `seed ${seed}: typo at ${pos}`);
      assert.notEqual(wrong.ch, chars[pos], `seed ${seed}: typo must differ`);
      assert.equal(steps[bi + 1].ch, chars[pos], `seed ${seed}: correction retypes the char`);
    }
    assert.equal(applySteps(steps), text, `seed ${seed}`);
  }
  assert.ok(typoPlans >= 20, `typos should happen sometimes, got ${typoPlans}/200`);
  assert.ok(typoPlans < 160, `typos should not happen almost always, got ${typoPlans}/200`);
  for (let seed = 0; seed < 20; seed += 1) {
    const steps = planTyping(text, createSeededRng(seed), { allowTypos: false });
    assert.equal(steps.filter((s) => s.op === "backspace").length, 0);
  }
});

test("planTyping handles empty and single-char text", () => {
  const { planTyping, createSeededRng } = loadHumanize();
  // (length check, not deepEqual: planTyping runs in a vm realm, whose
  // Array prototype differs from this realm's.)
  assert.equal(planTyping("", createSeededRng(1)).length, 0);
  const steps = planTyping("x", createSeededRng(1));
  assert.equal(steps.length, 1);
  assert.equal(steps[0].value, "x");
  assert.equal(steps[0].op, "type");
});

test("typeHumanlike applies steps in order and stops on cancel / shouldContinue", async () => {
  const { typeHumanlike } = loadHumanize();
  const timers = [];
  const clock = {
    setTimeout(fn, ms) {
      const id = timers.length;
      timers.push({ fn, ms, cancelled: false });
      return id;
    },
    clearTimeout(id) {
      if (timers[id]) timers[id].cancelled = true;
    },
  };
  const runNext = () => {
    const t = timers.find((x) => !x.cancelled && !x.ran);
    assert.ok(t, "a timer should be pending");
    t.ran = true;
    t.fn();
  };
  const steps = [
    { op: "type", ch: "a", value: "a", delay: 111.7 },
    { op: "type", ch: "b", value: "ab", delay: 222.3 },
  ];
  const applied = [];
  const run = typeHumanlike(null, "ab", {
    steps,
    timers: clock,
    apply: (value) => applied.push(value),
    shouldContinue: () => true,
  });
  assert.deepEqual(timers.map((t) => t.ms), [111.7]);
  runNext();
  assert.deepEqual(applied, ["a"]);
  assert.deepEqual(timers.map((t) => t.ms), [111.7, 222.3]);
  runNext();
  assert.deepEqual(applied, ["a", "ab"]);
  assert.equal(await run.done, true);

  // Cancel: nothing further is applied.
  const applied2 = [];
  const run2 = typeHumanlike(null, "ab", {
    steps,
    timers: clock,
    apply: (value) => applied2.push(value),
    shouldContinue: () => true,
  });
  runNext();
  assert.deepEqual(applied2, ["a"]);
  run2.cancel();
  assert.equal(await run2.done, false);
  // A pending timer must not fire anything after cancel.
  const pending = timers.filter((t) => !t.cancelled && !t.ran);
  for (const t of pending) t.fn();
  assert.deepEqual(applied2, ["a"]);

  // shouldContinue vetoes the rest once the prefix reaches "a".
  const applied3 = [];
  const run3 = typeHumanlike(null, "ab", {
    steps,
    timers: clock,
    apply: (value) => applied3.push(value),
    shouldContinue: (prefix) => prefix !== "a",
  });
  runNext();
  assert.deepEqual(applied3, ["a"]);
  assert.equal(await run3.done, false);
});

test("typeHumanlike honours initialValue when resuming a prefix", async () => {
  const { typeHumanlike } = loadHumanize();
  const seen = [];
  const clock = {
    setTimeout(fn, ms) {
      fn._ms = ms;
      queueMicrotask(fn);
      return 1;
    },
    clearTimeout() {},
  };
  const steps = [
    { op: "type", ch: "b", value: "xb", delay: 10 },
    { op: "type", ch: "c", value: "xbc", delay: 10 },
  ];
  const run = typeHumanlike(null, "bc", {
    steps,
    initialValue: "x",
    timers: clock,
    apply: (value) => seen.push(value),
    shouldContinue: (prefix) => {
      seen.push(`check:${prefix}`);
      return true;
    },
  });
  assert.equal(await run.done, true);
  // shouldContinue is first checked against the value already in the box.
  assert.equal(seen[0], "check:x");
  assert.deepEqual(
    seen.filter((s) => !s.startsWith("check:")),
    ["xb", "xbc"],
  );
});

test("typeHumanlike default apply uses the native setter and shaped InputEvents", async () => {
  const code = fs.readFileSync(path.join(__dirname, "..", "humanize.js"), "utf8");
  const ctx = vm.createContext({ console });
  vm.runInContext(
    `class FakeInput {
      constructor() { this._v = ""; this.dispatched = []; }
      dispatchEvent(e) { this.dispatched.push(e); return true; }
    }
    Object.defineProperty(FakeInput.prototype, "value", {
      get() { return this._v; },
      set(v) { this._v = String(v); },
      configurable: true,
    });
    class FakeInputEvent {
      constructor(type, init) { this.type = type; this.data = init.data !== undefined ? init.data : null; this.inputType = init.inputType || ""; }
    }
    class FakeEvent { constructor(type) { this.type = type; } }
    globalThis.HTMLInputElement = FakeInput;
    globalThis.InputEvent = FakeInputEvent;
    globalThis.Event = FakeEvent;
    globalThis.__makeInput = () => new FakeInput();`,
    ctx,
  );
  vm.runInContext(code, ctx);
  const input = vm.runInContext("__makeInput()", ctx);
  const timers = [];
  const clock = {
    setTimeout(fn, ms) {
      const id = timers.length;
      timers.push({ fn, ms, cancelled: false });
      return id;
    },
    clearTimeout(id) {
      if (timers[id]) timers[id].cancelled = true;
    },
  };
  const steps = [
    { op: "type", ch: "a", value: "a", delay: 10 },
    { op: "type", ch: "b", value: "ab", delay: 20 },
    { op: "backspace", value: "a", delay: 30 },
    { op: "type", ch: "b", value: "ab", delay: 40 },
  ];
  const run = ctx.KchHumanize.typeHumanlike(input, "ab", { steps, timers: clock });
  for (let i = 0; i < steps.length; i += 1) {
    const t = timers.find((x) => !x.cancelled && !x.ran);
    assert.ok(t, "a timer should be pending");
    t.ran = true;
    t.fn();
  }
  assert.equal(await run.done, true);
  assert.equal(input._v, "ab");
  // Array.from re-roots the cross-realm array in this realm for deepEqual.
  assert.deepEqual(
    Array.from(input.dispatched, (e) => [e.data, e.inputType]),
    [
      ["a", "insertText"],
      ["b", "insertText"],
      [null, "deleteContentBackward"],
      ["b", "insertText"],
    ],
  );
});

test("typeHumanlike calls timer builtins with the global as receiver", async () => {
  // Chrome throws "Illegal invocation" when a timer builtin is called
  // with the wrong receiver (e.g. as a method of a plain object). Node's
  // timers do not brand-check, so this test installs brand-checking
  // globals in the vm context, like Chrome's.
  const code = fs.readFileSync(path.join(__dirname, "..", "humanize.js"), "utf8");
  const ctx = vm.createContext({ console });
  vm.runInContext(
    `globalThis.__timerLog = [];
    globalThis.setTimeout = function (fn, ms) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      const id = globalThis.__timerLog.length;
      globalThis.__timerLog.push({ fn, ms, cancelled: false });
      return id;
    };
    globalThis.clearTimeout = function (id) {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      if (globalThis.__timerLog[id]) globalThis.__timerLog[id].cancelled = true;
    };`,
    ctx,
  );
  vm.runInContext(code, ctx);
  const applied = [];
  const run = ctx.KchHumanize.typeHumanlike(null, "ab", {
    steps: [
      { op: "type", ch: "a", value: "a", delay: 10 },
      { op: "type", ch: "b", value: "ab", delay: 20 },
    ],
    apply: (value) => applied.push(value),
  });
  for (let guard = 0; guard < 10; guard += 1) {
    const entries = Array.from(vm.runInContext("globalThis.__timerLog", ctx));
    const next = entries.find((e) => !e.ran && !e.cancelled);
    if (!next) break;
    next.ran = true;
    next.fn();
  }
  assert.equal(await run.done, true);
  assert.deepEqual(applied, ["a", "ab"]);
});

test("buildUserMessage asks for two labelled sections in party games, one list solo", () => {
  const buildUserMessage = loadBackground();
  const bothMsg = buildUserMessage("Name a noodle dish", [], true, "both");
  assert.match(bothMsg, /RARE:/);
  assert.match(bothMsg, /COMMON:/);
  assert.match(bothMsg, /12/);
  assert.match(bothMsg, /10/);
  const rareMsg = buildUserMessage("Name a noodle dish", [], true, "rare");
  assert.match(rareMsg, /12/);
  assert.match(rareMsg, /RARE:/);
  assert.doesNotMatch(rareMsg, /COMMON:/);
  const commonMsg = buildUserMessage("Name a noodle dish", [], true, "common");
  assert.match(commonMsg, /10/);
  assert.match(commonMsg, /COMMON:/);
  assert.doesNotMatch(commonMsg, /RARE:/);
  const soloMsg = buildUserMessage("Name a noodle dish", [], false);
  assert.match(soloMsg, /8 candidate answers/);
  assert.match(soloMsg, /last 2 .*safe fallbacks/);
  assert.doesNotMatch(soloMsg, /RARE:/);
  assert.doesNotMatch(soloMsg, /COMMON:/);
});

test("parseSections splits labelled rare/common sections", () => {
  const { parseSections } = loadBackground();
  assert.deepEqual(
    parseSections("RARE:\nUdon\nRamen\nCOMMON:\nPho\nPad thai\n", [], {}),
    { rare: ["Udon", "Ramen"], common: ["Pho", "Pad thai"], hasSections: true },
  );
  assert.deepEqual(
    parseSections("## Rare Answers\nUdon\n### Common\nPho\n", [], {}),
    { rare: ["Udon"], common: ["Pho"], hasSections: true },
  );
  assert.deepEqual(parseSections("Common: Udon, Ramen\n", [], {}), {
    rare: [],
    common: ["Udon", "Ramen"],
    hasSections: true,
  });
  assert.deepEqual(
    parseSections("Here are the answers:\nRARE:\nUdon\nCOMMON:\nPho\n", [], {}),
    { rare: ["Udon"], common: ["Pho"], hasSections: true },
  );
});

test("parseSections falls back to a tail split or a default section without headers", () => {
  const { parseSections } = loadBackground();
  const eight = parseSections("A\nB\nC\nD\nE\nF\nG\nH\n", [], { tailSize: 6 });
  assert.deepEqual(eight.rare, ["A", "B"]);
  assert.deepEqual(eight.common, ["C", "D", "E", "F", "G", "H"]);
  assert.equal(eight.hasSections, false);
  assert.deepEqual(parseSections("Udon\nRamen\nPho\n", [], { tailSize: 6 }), {
    rare: ["Udon", "Ramen", "Pho"],
    common: [],
    hasSections: false,
  });
  assert.deepEqual(parseSections("Udon\nRamen\n", [], { defaultSection: "rare" }).rare, ["Udon", "Ramen"]);
  assert.deepEqual(parseSections("Udon\nRamen\n", [], { defaultSection: "common" }).common, ["Udon", "Ramen"]);
});

test("canonicalKey maps spelling variants to one key without colliding distinct words", () => {
  const { canonicalKey } = loadBackground();
  const same = (a, b) => assert.equal(canonicalKey(a), canonicalKey(b), `${a} vs ${b}`);
  const different = (a, b) => assert.notEqual(canonicalKey(a), canonicalKey(b), `${a} vs ${b}`);
  same("Battleship gray", "battleship grey");
  same("Colour", "color");
  same("Favourite colour", "favorite color");
  same("Organise", "organize");
  same("Organised", "organized");
  same("Centre", "center");
  same("Theatre", "theater");
  same("Travelled", "traveled");
  same("Modelling", "modeling");
  same("Defense", "defence");
  same("Analyse", "analyze");
  same("Catalogue", "catalog");
  same("Foetus", "fetus");
  same("Manoeuvre", "maneuver");
  same("7-layer dip", "7-layer dip");
  different("Llama", "lama");
  different("Tour", "tor");
  different("Surprise", "surprize");
  different("Udon", "Ramen");
});

test("parseCandidates dedupes spelling variants within and across sections", () => {
  const { parseCandidates, parseSections } = loadBackground();
  assert.deepEqual(parseCandidates("Battleship gray\nBattleship grey\nUdon\n", []), ["Battleship gray", "Udon"]);
  assert.deepEqual(parseCandidates("Colour\nColor\nUdon\n", []), ["Colour", "Udon"]);
  const sections = parseSections("RARE:\nBattleship gray\nCOMMON:\nBattleship grey\nUdon\n", [], {});
  assert.deepEqual(sections, { rare: ["Battleship gray"], common: ["Udon"], hasSections: true });
});

test("parseCandidates flattens sectioned replies in order", () => {
  const { parseCandidates } = loadBackground();
  assert.deepEqual(parseCandidates("RARE:\nUdon\nCOMMON:\nPho\n", []), ["Udon", "Pho"]);
});

test("buildUserMessage tells the model already-used answers in party refetches", () => {
  const buildUserMessage = loadBackground();
  const partyMsg = buildUserMessage("Name a noodle dish", ["Pad thai"], true, "both");
  assert.match(partyMsg, /already used up/);
  assert.match(partyMsg, /Pad thai/);
  const soloMsg = buildUserMessage("Name a noodle dish", ["Pad thai"], false);
  assert.match(soloMsg, /REJECTED/);
  assert.match(soloMsg, /Pad thai/);
});

test("parseCandidates drops preambles, headers, and commentary of every shape", () => {
  const { parseCandidates } = loadBackground();
  assert.deepEqual(parseCandidates("Here are the top 10 words:\nUdon\nRamen\nPho\n", []), ["Udon", "Ramen", "Pho"]);
  assert.deepEqual(parseCandidates("Here are the top 10 words\nUdon\nRamen\n", []), ["Udon", "Ramen"]);
  assert.deepEqual(
    parseCandidates("Sure! Here are the rarest answers:\nUdon\nRamen\n", []),
    ["Udon", "Ramen"],
  );
  assert.deepEqual(
    parseCandidates("Of course, here are some picks:\nUdon\n", []),
    ["Udon"],
  );
  assert.deepEqual(parseCandidates("Top 10 rarest answers:\nUdon\n", []), ["Udon"]);
  assert.deepEqual(parseCandidates("## Rarest answers\nUdon\n", []), ["Udon"]);
  assert.deepEqual(parseCandidates("Answers:\nUdon\n", []), ["Udon"]);
  assert.deepEqual(
    parseCandidates("These are all well documented dishes that appear on Wikipedia lists for sure\nUdon\n", []),
    ["Udon"],
  );
  assert.deepEqual(parseCandidates("What about Udon?\nRamen\n", []), ["Ramen"]);
  assert.deepEqual(parseCandidates("Here are the answers:\n", []), []);
});

test("parseCandidates recovers candidates listed inline after a preamble", () => {
  const { parseCandidates } = loadBackground();
  assert.deepEqual(parseCandidates("Here are the answers: Udon, Ramen, Pho\n", []), ["Udon", "Ramen", "Pho"]);
  assert.deepEqual(
    parseCandidates("Here are my picks: 1. Udon, 2. Ramen, 3. Pho\n", []),
    ["Udon", "Ramen", "Pho"],
  );
  assert.deepEqual(parseCandidates("Here are picks: 1. Udon 2. Ramen 3. Pho\n", []), ["Udon", "Ramen", "Pho"]);
});

test("parseCandidates strips numbering, markdown, and explanations from names", () => {
  const { parseCandidates } = loadBackground();
  assert.deepEqual(
    parseCandidates("1. **Udon**\n- *Ramen*\n• `Pho`\n3) __Pad thai__\n", []),
    ["Udon", "Ramen", "Pho", "Pad thai"],
  );
  assert.deepEqual(
    parseCandidates(
      "Udon — a Japanese noodle soup\nRamen (tonkotsu style)\nPho: Vietnamese soup\nPad thai - stir-fried noodles\n",
      [],
    ),
    ["Udon", "Ramen", "Pho", "Pad thai"],
  );
  assert.deepEqual(parseCandidates("Udon.\nRamen,\n", []), ["Udon", "Ramen"]);
  assert.deepEqual(parseCandidates("“Udon”\n'Ramen'\n7-layer dip\n", []), ["Udon", "Ramen", "7-layer dip"]);
});

test("parseCandidates enforces the six-word cap and keeps exclusions", () => {
  const { parseCandidates } = loadBackground();
  assert.deepEqual(parseCandidates("One two three four five six seven\nUdon\n", []), ["Udon"]);
  assert.deepEqual(parseCandidates("One two three four five six\nUdon\n", []), [
    "One two three four five six",
    "Udon",
  ]);
  assert.deepEqual(parseCandidates("Udon\nRamen\n", ["udon"]), ["Ramen"]);
  assert.deepEqual(parseCandidates("Udon\nudon\nUDON\n", []), ["Udon"]);
});
