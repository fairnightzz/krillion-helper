// Committed tests for content.js: the real content.js + humanize.js
// run in a vm against a fake rated-party DOM, adapted from the
// scratch probe that used to live only in /tmp. Each scenario drives
// the DOM the way the game does and asserts what was typed,
// submitted, and refetched.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Ev {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
  }
  preventDefault() {}
}
class InputEv extends Ev {
  constructor(type, init = {}) {
    super(type, init);
    this.data = init.data !== undefined ? init.data : null;
    this.inputType = init.inputType || "";
  }
}
class KeyEv extends Ev {
  constructor(type, init = {}) {
    super(type, init);
    this.key = init.key || "";
    this.code = init.code || "";
  }
}

function compoundMatches(el, compound) {
  const tagM = compound.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  let rest = compound;
  if (tagM && !compound.startsWith(".")) {
    if (el.tagName.toLowerCase() !== tagM[0].toLowerCase()) return false;
    rest = compound.slice(tagM[0].length);
  }
  const nots = [];
  rest = rest.replace(/:not\(\.([a-zA-Z0-9_-]+)\)/g, (_, c) => {
    nots.push(c);
    return "";
  });
  const classes = [...rest.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  for (const c of classes) if (!el.classList.contains(c)) return false;
  for (const c of nots) if (el.classList.contains(c)) return false;
  return true;
}
function selectorMatches(el, selector) {
  const parts = selector.trim().split(/\s+/);
  let cur = el;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    let found = false;
    while (cur) {
      if (compoundMatches(cur, parts[i])) {
        found = true;
        cur = cur.parent;
        break;
      }
      cur = cur.parent;
    }
    if (!found) return false;
  }
  return true;
}

class El {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parent = null;
    this._classes = new Set();
    this.classList = {
      add: (...cs) => cs.forEach((c) => this._classes.add(c)),
      remove: (...cs) => cs.forEach((c) => this._classes.delete(c)),
      toggle: (c, force) => {
        if (force === undefined) force = !this._classes.has(c);
        if (force) this._classes.add(c);
        else this._classes.delete(c);
      },
      contains: (c) => this._classes.has(c),
    };
    this.dataset = {};
    // The game's tier signal is the --cc custom property on a
    // bubble; support get/setProperty like CSSStyleDeclaration.
    this.style = {
      _vars: {},
      getPropertyValue(name) {
        return this._vars[name] || "";
      },
      setProperty(name, value) {
        this._vars[name] = String(value);
      },
    };
    this.attributes = {};
    this._text = "";
    this.disabled = false;
    this.maxLength = -1;
    this.events = [];
    this.listeners = {};
    this._doc = null;
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join("");
    return this._text;
  }
  set textContent(v) {
    this.children = [];
    this._text = String(v);
  }
  get innerHTML() {
    return "";
  }
  set innerHTML(v) {
    this.children = [];
    this._text = "";
    if (String(v).includes("kch-mode")) {
      const head = new El("div");
      head.classList.add("kch-head");
      const mode = new El("span");
      mode.classList.add("kch-mode");
      const hint = new El("span");
      hint.classList.add("kch-hint");
      head.appendChild(mode);
      head.appendChild(hint);
      const status = new El("div");
      status.classList.add("kch-status");
      const list = new El("ol");
      list.classList.add("kch-list");
      this.appendChild(head);
      this.appendChild(status);
      this.appendChild(list);
    }
  }
  appendChild(child) {
    child.parent = this;
    this.children.push(child);
    return child;
  }
  remove() {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }
  setAttribute(k, v) {
    this.attributes[k] = String(v);
  }
  getAttribute(k) {
    return k in this.attributes ? this.attributes[k] : null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ||= []).push(fn);
  }
  dispatchEvent(ev) {
    ev.target = this;
    this.events.push(ev);
    // Document listeners run first when bubbling, approximating
    // capture: the content script's Enter listener is on document.
    if (ev.bubbles && this._doc) {
      for (const fn of this._doc._listeners[ev.type] || []) fn(ev);
    }
    for (const fn of this.listeners[ev.type] || []) fn(ev);
    return true;
  }
  click() {
    this._clicked = (this._clicked || 0) + 1;
    this.dispatchEvent(new Ev("click", { bubbles: true }));
  }
  focus() {
    if (this._doc) this._doc.activeElement = this;
  }
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] || null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (selectorMatches(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (compoundMatches(cur, sel.split(/\s+/).pop())) return cur;
      cur = cur.parent;
    }
    return null;
  }
}

class InputEl extends El {
  constructor() {
    super("input");
    this._v = "";
    this.maxLength = 60;
  }
}
// The React native-setter path content.js reads at load time.
Object.defineProperty(InputEl.prototype, "value", {
  get() {
    return this._v;
  },
  set(v) {
    this._v = String(v);
  },
  configurable: true,
});

function buildDoc({ rated, myTurn, prompt, category, initialBubbles, endButtons = false, joinButton = false, joinLabel = "JOIN NEXT GAME" }) {
  const docEl = new El("html");
  const body = new El("body");
  docEl.appendChild(body);
  const doc = {
    documentElement: docEl,
    body,
    activeElement: body,
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    },
    createElement(tag) {
      const el = tag === "input" ? new InputEl() : new El(tag);
      el._doc = doc;
      return el;
    },
    querySelector(sel) {
      return docEl.querySelector(sel);
    },
    querySelectorAll(sel) {
      return docEl.querySelectorAll(sel);
    },
    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === docEl) return true;
        cur = cur.parent;
      }
      return false;
    },
  };
  const root = new El("div");
  root.classList.add("pf-root");
  root.dataset.phase = "answering";
  body.appendChild(root);
  const pod = new El("div");
  pod.classList.add("pf-room-privacy");
  pod.setAttribute("aria-label", rated ? "Rated 1V1 table ABCD" : "Unrated 1V1 table ABCD");
  const podLabel = new El("div");
  podLabel.classList.add("label");
  podLabel.textContent = rated ? "RATED 1V1" : "UNRATED 1V1";
  pod.appendChild(podLabel);
  root.appendChild(pod);
  const status = new El("div");
  status.classList.add("pf-status");
  status.textContent = myTurn ? "▸ your puffer · type an answer" : "▸ KRILL is up";
  root.appendChild(status);
  const card = new El("div");
  card.classList.add("ds-card");
  const rnd = new El("div");
  rnd.classList.add("rnd");
  rnd.textContent = category;
  const promptEl = new El("div");
  promptEl.classList.add("prompt");
  promptEl.textContent = prompt;
  card.appendChild(rnd);
  card.appendChild(promptEl);
  root.appendChild(card);
  const dock = new El("div");
  dock.classList.add("ds-dock");
  const input = new InputEl();
  input._doc = doc;
  input.classList.add("ds-input");
  input.setAttribute("placeholder", myTurn ? "your puffer — type!" : "KRILL is up…");
  input.disabled = !myTurn;
  dock.appendChild(input);
  const button = new El("button");
  button.classList.add("ds-dive-btn");
  button.setAttribute("aria-label", "Send answer");
  button.textContent = "SEND";
  dock.appendChild(button);
  root.appendChild(dock);
  for (const bub of initialBubbles || []) {
    const el = doc.createElement("div");
    el.classList.add("pf-say", "on", bub.cls);
    el.textContent = bub.text;
    if (bub.tier) {
      const cc = `var(--tier-${bub.tier}, #8fa3c4)`;
      el.style.setProperty("--cc", cc);
      el.setAttribute("style", `left: 0px; bottom: -109px; --cc: ${cc};`);
    }
    root.appendChild(el);
  }
  let endButton = null;
  let findGameButton = null;
  if (endButtons) {
    const wrap = new El("div");
    wrap.classList.add("pf-end-buttons");
    endButton = new El("button");
    endButton.classList.add("ds-next-btn");
    endButton.textContent = "PLAY AGAIN";
    endButton.addEventListener("click", () => wrap.remove());
    findGameButton = new El("button");
    findGameButton.classList.add("ds-next-btn", "pf-find-game");
    findGameButton.textContent = "NEW TABLE";
    wrap.appendChild(endButton);
    wrap.appendChild(findGameButton);
    root.appendChild(wrap);
  }
  let joinBtn = null;
  if (joinButton) {
    joinBtn = new El("button");
    joinBtn.classList.add("ds-begin-btn", "pf-start");
    joinBtn.textContent = joinLabel;
    joinBtn.addEventListener("click", () => joinBtn.remove());
    root.appendChild(joinBtn);
  }
  return { doc, root, status, card, rnd, promptEl, dock, input, button, endButton, findGameButton, joinBtn };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function setup({ mode = "auto", wordStyle = "rare", rated = true, enabled = true, autoAdvance = false, autoPlayAgain = false, endButtons = false, joinButton = false, joinLabel, responder, rejectFirst = 0, rejectReason = "already said", retainDraft = false, initialBubbles, prompt = "Name a noodle dish", category = "CATEGORY 3" }) {
  const { doc, root, status, rnd, promptEl, input, button, endButton, findGameButton, joinBtn } = buildDoc({
    rated,
    myTurn: true,
    prompt,
    category,
    initialBubbles,
    endButtons,
    joinButton,
    ...(joinLabel === undefined ? {} : { joinLabel }),
  });
  const location = { pathname: "/party/ABCD" };
  // The content script's 300ms tick interval would keep the test
  // process alive forever if left running; record it for teardown.
  const intervals = [];
  const store = { enabled, mode, wordStyle, autoAdvance, autoPlayAgain, showOverlay: true };
  const calls = [];
  const submittedTexts = [];
  let submits = 0;
  const onGameSubmit = () => {
    submits += 1;
    const liveNode = doc.querySelector(".pf-root .ds-dock .ds-input");
    if (liveNode) submittedTexts.push(liveNode.value);
    if (rejectFirst && submits <= rejectFirst && liveNode) {
      let rejEl = doc.querySelector(".ds-reject");
      if (!rejEl) {
        rejEl = doc.createElement("div");
        rejEl.classList.add("ds-reject");
        root.appendChild(rejEl);
      }
      rejEl.textContent = `“${liveNode.value}”: ${rejectReason}`;
    }
    if (retainDraft) return;
    if (liveNode) liveNode._v = "";
  };
  button.addEventListener("click", onGameSubmit);
  input.addEventListener("keydown", (e) => {
    // The game only sees trusted Enter; the extension's synthetic
    // Enter keydown does not reach this callback.
    if (e.key === "Enter" && e.isTrusted) onGameSubmit();
  });
  let changeListener = null;
  const chromeStub = {
    storage: {
      local: {
        get: (keys, cb) => {
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) if (k in store) out[k] = store[k];
            cb(out);
          } else {
            cb({ ...store });
          }
        },
        set: (obj, cb) => {
          Object.assign(store, obj);
          if (cb) cb();
        },
      },
      onChanged: { addListener: (fn) => { changeListener = fn; } },
    },
    runtime: {
      lastError: undefined,
      sendMessage: (msg, cb) => {
        calls.push(msg);
        const res = responder(msg, calls.length, location);
        setTimeout(() => cb(res), 0);
      },
    },
  };
  const ctx = vm.createContext({
    console,
    document: doc,
    location,
    navigator: {},
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms, ...args) => {
      const id = setInterval(fn, ms, ...args);
      intervals.push(id);
      return id;
    },
    clearInterval,
    Event: Ev,
    InputEvent: InputEv,
    KeyboardEvent: KeyEv,
    HTMLInputElement: InputEl,
    Math,
    Promise,
    chrome: chromeStub,
  });
  const humanize = fs.readFileSync(path.join(__dirname, "..", "humanize.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInContext(humanize, ctx);
  vm.runInContext(content, ctx);
  const setMyTurn = (mine) => {
    input.disabled = !mine;
    input.setAttribute("placeholder", mine ? "your puffer — type!" : "KRILL is up…");
    status.textContent = mine ? "▸ your puffer · type an answer" : "▸ KRILL is up";
  };
  const setPrompt = (text, cat) => {
    promptEl.textContent = text;
    rnd.textContent = cat;
  };
  return {
    doc, root, status, input, button, endButton, findGameButton, joinBtn, location, store, calls, submittedTexts,
    get submits() {
      return submits;
    },
    get clicks() {
      return button._clicked || 0;
    },
    fireChange: (changes) => changeListener && changeListener(changes, "local"),
    setMyTurn, setPrompt,
    teardown() {
      for (const id of intervals) clearInterval(id);
    },
  };
}

function sectionResponder(rare, common) {
  return () => ({ ok: true, rare: [...rare], common: [...common] });
}

test("a mode change during the Enter delay cancels the pending auto-Enter", async (t) => {
  const g = setup({ responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await waitFor(() => g.input.value === "ab", 4000, "ab typed");
  g.fireChange({ mode: { oldValue: "auto", newValue: "fill" } });
  await sleep(1500);
  assert.equal(g.clicks, 0);
  assert.equal(g.submits, 0);
  assert.equal(g.input.value, "ab");
});

test("a timed-out wrong answer is deleted from the box when the turn passes", async (t) => {
  const g = setup({
    responder: (msg) =>
      msg.prompt.includes("second")
        ? { ok: true, rare: ["xy", "zw"], common: ["qq", "rr"] }
        : { ok: true, rare: ["ab", "cd"], common: ["ef", "gh"] },
    retainDraft: true,
  });
  t.after(() => g.teardown());
  await waitFor(() => g.submits >= 1, 5000, "first submit");
  assert.equal(g.input.value, "ab");
  g.setMyTurn(false);
  await sleep(800);
  assert.equal(g.input.value, "", "leftover must be deleted at turn end");
  g.setPrompt("Name a second dish", "CATEGORY 4");
  g.setMyTurn(true);
  await waitFor(() => g.input.value === "xy", 5000, "second-category answer typed");
  await waitFor(() => g.submittedTexts.includes("xy"), 5000, "second-category answer submitted");
});

test("a draft cancelled mid-word is deleted when the turn passes", async (t) => {
  const g = setup({
    responder: sectionResponder(["12345678", "cd"], ["ef", "gh"]),
  });
  t.after(() => g.teardown());
  // Catch typing part-way through the digit-only candidate (no
  // typo can land on digits, so every prefix is a strict prefix).
  const deadline = Date.now() + 4000;
  while (g.input.value.length < 2 && Date.now() < deadline) await sleep(10);
  assert.ok(g.input.value.length >= 2 && g.input.value.length < 8, `partial draft, got ${JSON.stringify(g.input.value)}`);
  g.setMyTurn(false);
  await sleep(900);
  assert.equal(g.input.value, "", "cancelled draft must be deleted at turn end");
  g.setMyTurn(true);
  await waitFor(() => g.submittedTexts.includes("12345678"), 8000, "draft retyped and submitted next turn");
});

test("a word the player typed and never submitted is deleted when time runs out", async (t) => {
  const g = setup({ responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await waitFor(() => g.submits >= 1, 5000, "first submit");
  // The player types their own word into the cleared box and never
  // presses Enter before the fuse runs out. No draft record
  // identifies it, so the turn-end delete must treat whatever is
  // in the box as the previous turn's text.
  g.input._v = "zz";
  g.setMyTurn(false);
  await sleep(800);
  assert.equal(g.input.value, "", "player-typed leftover must be deleted at turn end");
  g.setMyTurn(true);
  await waitFor(() => g.submittedTexts.includes("cd"), 8000, "fresh candidate submitted next turn");
});

test("fresh player text at the start of a turn is never overwritten", async (t) => {
  const g = setup({ responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  g.input._v = "zz";
  await sleep(2500);
  assert.equal(g.input.value, "zz");
  assert.equal(g.submittedTexts.length, 0);
  assert.match(g.doc.querySelector(".kch-status").textContent, /your text/);
});

test("a prompt-free gap does not make the leftover look player-typed", async (t) => {
  const g = setup({
    responder: (msg) =>
      msg.prompt.includes("second")
        ? { ok: true, rare: ["xy", "zw"], common: ["qq", "rr"] }
        : { ok: true, rare: ["ab", "cd"], common: ["ef", "gh"] },
    retainDraft: true,
  });
  t.after(() => g.teardown());
  await waitFor(() => g.submits >= 1, 5000, "first submit");
  assert.equal(g.input.value, "ab");
  g.setMyTurn(false);
  g.setPrompt("", "CATEGORY 3");
  await sleep(1000);
  assert.equal(g.input.value, "", "leftover must be deleted across the prompt gap");
  g.setPrompt("Name a second dish", "CATEGORY 4");
  g.setMyTurn(true);
  await waitFor(() => g.submittedTexts.includes("xy"), 8000, "second-category answer submitted");
});

test("one rejection jumps to common, and the next turn starts from rare again", async (t) => {
  const g = setup({
    responder: sectionResponder(["ra", "rb", "rc"], ["ca", "cb", "cc"]),
    rejectFirst: 1,
  });
  t.after(() => g.teardown());
  await waitFor(() => g.submittedTexts.length >= 2, 9000, "two submits");
  assert.deepEqual(g.submittedTexts.slice(0, 2), ["ra", "ca"]);
  // "Already said" is a duplicate, not a wrong answer: it is
  // reported as a duplicate for curation, even though picking
  // still skips the word this round.
  const reports = g.calls.filter((c) => c.type === "reportOutcome");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, "duplicate");
  assert.equal(reports[0].text, "ra");
  g.setMyTurn(false);
  await sleep(700);
  g.setMyTurn(true);
  await waitFor(() => g.submittedTexts.includes("rb"), 8000, "rare retried next turn");
  assert.equal(g.submittedTexts[2], "rb");
});

test("a no-echo rejection is reported as rejected, not as a duplicate", async (t) => {
  const g = setup({
    responder: sectionResponder(["ra", "rb", "rc"], ["ca", "cb", "cc"]),
    rejectFirst: 1,
    rejectReason: "no echo",
  });
  t.after(() => g.teardown());
  await waitFor(() => g.submittedTexts.length >= 2, 9000, "two submits");
  assert.deepEqual(g.submittedTexts.slice(0, 2), ["ra", "ca"]);
  const reports = g.calls.filter((c) => c.type === "reportOutcome");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, "rejected");
  assert.equal(reports[0].text, "ra");
});

test("another player's shown answer is reported as accepted, once", async (t) => {
  const g = setup({ responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  const bubble = g.doc.createElement("div");
  bubble.classList.add("pf-say", "on");
  bubble.textContent = "zz";
  g.root.appendChild(bubble);
  await sleep(1500);
  const reports = g.calls.filter((c) => c.type === "reportOutcome" && c.text === "zz");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, "accepted");
  assert.equal(reports[0].source, "other");
});

test("another player's bad bubble for a word already played is reported as a duplicate", async (t) => {
  const g = setup({ responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await waitFor(() => g.submits >= 1, 5000, "first submit");
  g.setMyTurn(false);
  await sleep(700);
  const bubble = g.doc.createElement("div");
  bubble.classList.add("pf-say", "on", "bad");
  bubble.textContent = "ab";
  g.root.appendChild(bubble);
  await sleep(800);
  const dups = g.calls.filter((c) => c.type === "reportOutcome" && c.text === "ab" && c.outcome === "duplicate");
  assert.equal(dups.length, 1);
  assert.equal(dups[0].source, "other");
  assert.equal(g.calls.filter((c) => c.type === "reportOutcome" && c.text === "ab" && c.outcome === "rejected").length, 0);
  await sleep(800);
  assert.equal(g.calls.filter((c) => c.type === "reportOutcome" && c.text === "ab" && c.outcome === "duplicate").length, 1);
});

test("another player's bad bubble for an unseen word is never reported as wrong", async (t) => {
  const g = setup({ responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  const bubble = g.doc.createElement("div");
  bubble.classList.add("pf-say", "on", "bad");
  bubble.textContent = "qq";
  g.root.appendChild(bubble);
  await waitFor(() => g.submittedTexts.length >= 1, 8000, "own submit still happens");
  assert.equal(g.submittedTexts[0], "ab");
  assert.equal(g.calls.filter((c) => c.type === "reportOutcome" && c.text === "qq").length, 0);
});

test("a turn passing without a rejection reports the attempt as accepted", async (t) => {
  const g = setup({ responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await waitFor(() => g.submits >= 1, 5000, "first submit");
  g.setMyTurn(false);
  await sleep(800);
  const reports = g.calls.filter((c) => c.type === "reportOutcome");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, "accepted");
  assert.equal(reports[0].text, "ab");
  assert.equal(reports[0].source, "own");
});

test("regeneration is not blocked once the two lists total 60", async (t) => {
  const rare = Array.from({ length: 30 }, (_, i) => `r${String(i).padStart(2, "0")}`);
  const common = Array.from({ length: 30 }, (_, i) => `c${String(i).padStart(2, "0")}`);
  const bubbles = [...rare.slice(1), ...common.slice(1)].map((text) => ({ text, cls: "rest" }));
  const g = setup({
    responder: (msg, callNo) =>
      callNo >= 2
        ? { ok: true, rare: ["n1", "n2"], common: ["n3", "n4"] }
        : { ok: true, rare: [...rare], common: [...common] },
    initialBubbles: bubbles,
  });
  t.after(() => g.teardown());
  // Scope the probe to getAnswers messages: logEvent messages
  // also carry a `kind` field (a game-event kind), so an unscoped
  // probe would match the first log line instead of the refetch.
  const fetches = () => g.calls.filter((c) => c.type === "getAnswers");
  await waitFor(() => fetches().some((c) => c.kind), 9000, "a refetch with a kind");
  assert.ok(fetches().some((c) => c.kind === "both" || c.kind === "rare" || c.kind === "common"));
});

test("the same category and prompt in a new room resets to the rare list", async (t) => {
  const g = setup({
    responder: (_msg, _callNo, location) =>
      location.pathname.includes("WXYZ")
        ? { ok: true, rare: ["r1", "r2"], common: ["c1", "c2"] }
        : { ok: true, rare: ["ra", "rb"], common: ["ca", "cb"] },
    rejectFirst: 1,
  });
  t.after(() => g.teardown());
  await waitFor(() => g.submittedTexts.length >= 2, 9000, "two submits");
  assert.deepEqual(g.submittedTexts.slice(0, 2), ["ra", "ca"]);
  g.setMyTurn(false);
  await sleep(700);
  const rej = g.doc.querySelector(".ds-reject");
  if (rej) rej.remove();
  g.location.pathname = "/party/WXYZ";
  g.setMyTurn(true);
  await waitFor(() => g.submittedTexts.includes("r1"), 8000, "fresh rare list in the new room");
});

test("common-only types from the common bench and never the rare list", async (t) => {
  const g = setup({ wordStyle: "common", responder: sectionResponder(["ra", "rb"], ["ca", "cb"]) });
  t.after(() => g.teardown());
  await waitFor(() => g.calls.length >= 1, 4000, "first fetch");
  assert.equal(g.calls[0].kind, "common");
  assert.equal(g.calls[0].wordStyle, "common");
  await waitFor(() => g.submittedTexts.length >= 2, 9000, "two common submits");
  assert.deepEqual(g.submittedTexts.slice(0, 2), ["ca", "cb"]);
  // The overlay must show only the bench: no rare entry anywhere,
  // and the hint must say the common-only choice is in effect.
  const shown = [...g.doc.querySelector(".kch-list").children].map((li) => li.textContent);
  assert.deepEqual(shown, ["ca", "cb"]);
  assert.match(g.doc.querySelector(".kch-hint").textContent, /common only/);
});

test("party typing folds accents to plain letters", async (t) => {
  const g = setup({ responder: sectionResponder(["Crème Brûlée", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await waitFor(() => g.submittedTexts.length >= 1, 8000, "folded submit");
  assert.equal(g.submittedTexts[0], "creme brulee");
});

test("party typing is always lowercase, whatever the list spelling", async (t) => {
  const g = setup({ responder: sectionResponder(["Battleship Gray", "Cd"], ["Ef", "Gh"]) });
  t.after(() => g.teardown());
  await waitFor(() => g.submittedTexts.length >= 1, 8000, "lowercase submit");
  assert.equal(g.submittedTexts[0], "battleship gray");
});

function setupSolo({ candidates, rejectReason = null }) {
  const docEl = new El("html");
  const body = new El("body");
  docEl.appendChild(body);
  const doc = {
    documentElement: docEl,
    body,
    activeElement: body,
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] ||= []).push(fn);
    },
    createElement(tag) {
      const el = tag === "input" ? new InputEl() : new El(tag);
      el._doc = doc;
      return el;
    },
    querySelector(sel) {
      return docEl.querySelector(sel);
    },
    querySelectorAll(sel) {
      return docEl.querySelectorAll(sel);
    },
    contains(node) {
      let cur = node;
      while (cur) {
        if (cur === docEl) return true;
        cur = cur.parent;
      }
      return false;
    },
  };
  const card = new El("div");
  card.classList.add("ds-card");
  const promptEl = new El("div");
  promptEl.classList.add("prompt");
  promptEl.textContent = "Name a noodle dish";
  card.appendChild(promptEl);
  body.appendChild(card);
  const form = new El("form");
  form.classList.add("ds-dock");
  const input = new InputEl();
  input._doc = doc;
  input.classList.add("ds-input");
  const button = new El("button");
  button.classList.add("ds-dive-btn");
  button.textContent = "SEND";
  form.appendChild(input);
  form.appendChild(button);
  body.appendChild(form);
  const submitted = [];
  const messages = [];
  button.addEventListener("click", () => {
    submitted.push(input.value);
    if (rejectReason && submitted.length === 1) {
      const rejEl = doc.createElement("div");
      rejEl.classList.add("ds-reject");
      rejEl.textContent = `“${input.value}”: ${rejectReason}`;
      body.appendChild(rejEl);
    }
    input._v = "";
  });
  const intervals = [];
  const store = { mode: "auto", wordStyle: "rare", autoAdvance: false, showOverlay: true };
  const chromeStub = {
    storage: {
      local: {
        get: (keys, cb) => {
          if (Array.isArray(keys)) {
            const out = {};
            for (const k of keys) if (k in store) out[k] = store[k];
            cb(out);
          } else {
            cb({ ...store });
          }
        },
        set: (obj, cb) => {
          Object.assign(store, obj);
          if (cb) cb();
        },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      lastError: undefined,
      sendMessage: (msg, cb) => {
        messages.push(msg);
        setTimeout(() => cb({ ok: true, candidates: [...candidates] }), 0);
      },
    },
  };
  const ctx = vm.createContext({
    console,
    document: doc,
    location: { pathname: "/dive" },
    navigator: {},
    MutationObserver: class {
      observe() {}
    },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    setTimeout,
    clearTimeout,
    setInterval: (fn, ms, ...args) => {
      const id = setInterval(fn, ms, ...args);
      intervals.push(id);
      return id;
    },
    clearInterval,
    Event: Ev,
    InputEvent: InputEv,
    KeyboardEvent: KeyEv,
    HTMLInputElement: InputEl,
    Math,
    Promise,
    chrome: chromeStub,
  });
  const humanize = fs.readFileSync(path.join(__dirname, "..", "humanize.js"), "utf8");
  const content = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  vm.runInContext(humanize, ctx);
  vm.runInContext(content, ctx);
  return {
    input,
    submitted,
    messages,
    get clicks() {
      return button._clicked || 0;
    },
    teardown() {
      for (const id of intervals) clearInterval(id);
    },
  };
}

test("solo filling is always lowercase, whatever the list spelling", async (t) => {
  const g = setupSolo({ candidates: ["Udon", "Ramen"] });
  t.after(() => g.teardown());
  await waitFor(() => g.submitted.length >= 1, 5000, "solo submit");
  assert.equal(g.submitted[0], "udon");
  assert.equal(g.clicks, 1);
});

test("a solo no-echo rejection is reported as rejected for the submitted word", async (t) => {
  const g = setupSolo({ candidates: ["Udon", "Ramen"], rejectReason: "no echo" });
  t.after(() => g.teardown());
  await waitFor(() => g.submitted.length >= 2, 8000, "second solo submit after rejection");
  assert.deepEqual(g.submitted.slice(0, 2), ["udon", "ramen"]);
  const reports = g.messages.filter((m) => m.type === "reportOutcome");
  assert.equal(reports.length, 1);
  assert.equal(reports[0].outcome, "rejected");
  assert.equal(reports[0].text, "udon");
  assert.equal(reports[0].source, "banner");
});

test("solo filling folds accents to plain letters", async (t) => {
  const g = setupSolo({ candidates: ["Café", "Ramen"] });
  t.after(() => g.teardown());
  await waitFor(() => g.submitted.length >= 1, 5000, "solo folded submit");
  assert.equal(g.submitted[0], "cafe");
  assert.equal(g.clicks, 1);
});

test("casual party games get auto typing and submit too, not just rated", async (t) => {
  const g = setup({ rated: false, responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await waitFor(() => g.submittedTexts.length >= 1, 8000, "casual submit");
  assert.equal(g.submittedTexts[0], "ab");
  assert.equal(g.clicks, 1);
});

test("a disabled helper fetches, types, and submits nothing", async (t) => {
  const g = setup({ enabled: false, responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await sleep(2500);
  assert.equal(g.calls.length, 0);
  assert.equal(g.submittedTexts.length, 0);
  assert.equal(g.input.value, "");
});

test("re-enabling the helper resumes fetching and typing", async (t) => {
  const g = setup({ enabled: false, responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await sleep(1200);
  assert.equal(g.calls.length, 0);
  g.fireChange({ enabled: { oldValue: false, newValue: true } });
  await waitFor(() => g.submittedTexts.length >= 1, 8000, "submit after re-enable");
  assert.equal(g.submittedTexts[0], "ab");
});

test("casual party games stay copy-only in suggest mode", async (t) => {
  const g = setup({ rated: false, mode: "suggest", responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await sleep(2500);
  assert.equal(g.submittedTexts.length, 0);
  assert.equal(g.clicks, 0);
  assert.equal(g.input.value, "");
});

test("auto Play again clicks Play again once when on, auto, and rated", async (t) => {
  const g = setup({ endButtons: true, autoPlayAgain: true, responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await waitFor(() => (g.endButton._clicked || 0) >= 1, 6500, "Play again clicked");
  await sleep(1500);
  assert.equal(g.endButton._clicked, 1);
  assert.equal(g.findGameButton._clicked || 0, 0);
});

test("auto Play again does not click when off", async (t) => {
  const g = setup({ endButtons: true, responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await sleep(4500);
  assert.equal(g.endButton._clicked || 0, 0);
});

test("auto Play again does not click in fill mode", async (t) => {
  const g = setup({ endButtons: true, autoPlayAgain: true, mode: "fill", responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await sleep(4500);
  assert.equal(g.endButton._clicked || 0, 0);
});

test("auto-advance alone does not click Play again", async (t) => {
  const g = setup({ endButtons: true, autoAdvance: true, responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await sleep(4500);
  assert.equal(g.endButton._clicked || 0, 0);
});

test("auto Join next game clicks JOIN NEXT GAME once when on, auto, and rated", async (t) => {
  const g = setup({ joinButton: true, autoPlayAgain: true, responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await waitFor(() => (g.joinBtn._clicked || 0) >= 1, 5000, "Join next game clicked");
  await sleep(1200);
  assert.equal(g.joinBtn._clicked, 1);
});

test("auto Join next game does not click when off", async (t) => {
  const g = setup({ joinButton: true, responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await sleep(3500);
  assert.equal(g.joinBtn._clicked || 0, 0);
});

test("auto Join next game never clicks Wake the Puffer", async (t) => {
  const g = setup({ joinButton: true, joinLabel: "▼ WAKE THE PUFFER ▼", autoPlayAgain: true, responder: sectionResponder(["ab", "cd"], ["ef", "gh"]) });
  t.after(() => g.teardown());
  await sleep(3500);
  assert.equal(g.joinBtn._clicked || 0, 0);
});

test("party answers over 20 characters are skipped, including at the 20 boundary", async (t) => {
  const g = setup({ responder: sectionResponder(["abcdefghijklmnopqrstu", "abcdefghijklmnopqrst", "ab"], ["cd"]) });
  t.after(() => g.teardown());
  // Pass the turn after the first submit, as a real game does on
  // acceptance, so the second pick does not wait out the 5s
  // result window the harness game would otherwise leave open.
  await waitFor(() => g.submittedTexts.length >= 1, 8000, "first submit");
  g.setMyTurn(false);
  await sleep(600);
  g.setMyTurn(true);
  await waitFor(() => g.submittedTexts.length >= 2, 8000, "short submits");
  assert.equal(g.submittedTexts[0], "abcdefghijklmnopqrst");
  assert.equal(g.submittedTexts[1], "ab");
  assert.ok(!g.submittedTexts.includes("abcdefghijklmnopqrstu"));
});

test("when only long answers remain, the shortest usable one is typed", async (t) => {
  const g = setup({ responder: sectionResponder(["abcdefghijklmnopqrstu"], []) });
  t.after(() => g.teardown());
  await waitFor(() => g.submittedTexts.length >= 1, 8000, "long fallback submit");
  assert.equal(g.submittedTexts[0], "abcdefghijklmnopqrstu");
});

test("only opponent krillion-tier bubbles are promoted, once, from --cc", async (t) => {
  const g = setup({
    responder: (msg) =>
      msg.type === "getAnswers"
        ? { ok: true, rare: ["ab", "cd"], common: ["ef", "gh"] }
        : { ok: true },
  });
  t.after(() => g.teardown());
  await waitFor(() => g.submits >= 1, 5000, "first submit");
  // "ab" was just submitted by this extension: its own krillion
  // bubble must not promote. "quux" is a bad bubble, not an
  // acceptance, even with a krillion --cc on it. Seat or toast
  // signals are never consulted: only the bubble's own --cc.
  const addBubble = ({ text, cls, tier, attrOnly }) => {
    const el = g.doc.createElement("div");
    el.classList.add("pf-say", "on", cls);
    el.textContent = text;
    const cc = `var(--tier-${tier}, #8fa3c4)`;
    if (!attrOnly) el.style.setProperty("--cc", cc);
    el.setAttribute("style", `left: 0px; bottom: -109px; --cc: ${cc};`);
    g.root.appendChild(el);
  };
  addBubble({ text: "Zork", cls: "ok", tier: "krillion" });
  addBubble({ text: "Vex", cls: "ok", tier: "krillion", attrOnly: true });
  addBubble({ text: "Sweden", cls: "ok", tier: "plankton" });
  addBubble({ text: "ab", cls: "ok", tier: "krillion" });
  addBubble({ text: "Quux", cls: "bad", tier: "krillion" });
  await sleep(1000);
  const promotes = g.calls.filter((c) => c.type === "promoteKrillion");
  assert.deepEqual(promotes.map((c) => c.text).sort(), ["Vex", "Zork"]);
  assert.ok(promotes.every((c) => c.tier === "krillion" && c.prompt === "Name a noodle dish"));
  const accepted = g.calls.filter((c) => c.type === "reportOutcome" && c.outcome === "accepted");
  assert.deepEqual(accepted.map((c) => c.text).sort(), ["Sweden", "Vex", "Zork"]);
  // Bubbles persist across ticks: the same evidence promotes once.
  await sleep(700);
  assert.equal(g.calls.filter((c) => c.type === "promoteKrillion").length, 2);
});

test("game events are logged and relayed to the server log", async (t) => {
  const g = setup({
    responder: (msg) =>
      msg.type === "getAnswers"
        ? { ok: true, rare: ["ab", "cd"], common: ["ef", "gh"] }
        : { ok: true },
  });
  t.after(() => g.teardown());
  await waitFor(() => g.submits >= 1, 5000, "first submit");
  const el = g.doc.createElement("div");
  el.classList.add("pf-say", "on", "ok");
  el.textContent = "Zork";
  el.style.setProperty("--cc", "var(--tier-krillion, #ffd166)");
  el.setAttribute("style", "left: 0px; bottom: -109px; --cc: var(--tier-krillion, #ffd166);");
  g.root.appendChild(el);
  await sleep(1000);
  const logEvents = g.calls.filter((c) => c.type === "logEvent");
  const kinds = logEvents.map((c) => c.kind);
  for (const kind of ["fetch_result", "typing_start", "typing_done", "submit_attempt", "bubble_seen", "outcome_reported", "promote_sent"]) {
    assert.ok(kinds.includes(kind), `missing logEvent ${kind}`);
  }
  const fetchEvent = logEvents.find((c) => c.kind === "fetch_result");
  assert.equal(fetchEvent.detail.cached, false);
  assert.equal(fetchEvent.prompt, "Name a noodle dish");
  const bubble = logEvents.find((c) => c.kind === "bubble_seen" && c.text === "Zork");
  assert.ok(bubble);
  assert.equal(bubble.detail.tier, "krillion");
  assert.ok(logEvents.some((c) => c.kind === "outcome_reported" && c.text === "Zork" && c.detail.outcome === "accepted"));
  // Bubbles persist across ticks: first sighting logs once.
  await sleep(700);
  assert.equal(g.calls.filter((c) => c.type === "logEvent" && c.kind === "bubble_seen" && c.text === "Zork").length, 1);
});
