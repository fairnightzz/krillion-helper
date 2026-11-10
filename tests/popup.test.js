const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function makeEl() {
  return {
    value: "",
    checked: false,
    textContent: "",
    className: "",
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
  };
}

function loadPopup({ stored, deferGet, store, failSet, failGet, lsStore }) {
  const elements = {};
  const doc = {
    getElementById(id) {
      return (elements[id] ||= makeEl());
    },
  };
  // Shared backing store across loads (like chrome.storage.local); the
  // fake get returns stored items only and never applies defaults, so
  // the code under test must merge defaults itself.
  const backing = store || { ...stored };
  // Shared localStorage backing across loads (the popup's sync mirror).
  const lsBacking = lsStore || {};
  const localStorageStub = {
    getItem(k) {
      return k in lsBacking ? lsBacking[k] : null;
    },
    setItem(k, v) {
      lsBacking[k] = String(v);
    },
    removeItem(k) {
      delete lsBacking[k];
    },
  };
  let getCallback = null;
  const calls = { get: [], set: [], messages: [] };
  const chromeStub = {
    storage: {
      local: {
        get(_keys, cb) {
          calls.get.push(_keys);
          const run = () => {
            if (failGet) chromeStub.runtime.lastError = { message: failGet };
            try {
              cb(failGet ? {} : { ...backing });
            } finally {
              delete chromeStub.runtime.lastError;
            }
          };
          if (deferGet) getCallback = run;
          else run();
        },
        set(obj, cb) {
          calls.set.push(obj);
          if (failSet) chromeStub.runtime.lastError = { message: failSet };
          try {
            if (cb) cb();
          } finally {
            delete chromeStub.runtime.lastError;
          }
          if (!failSet) Object.assign(backing, obj);
        },
      },
    },
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) {
        calls.messages.push(msg);
        if (cb) cb({ ok: true });
      },
    },
  };
  const ctx = vm.createContext({ document: doc, chrome: chromeStub, console, localStorage: localStorageStub });
  const code = fs.readFileSync(path.join(__dirname, "..", "popup.js"), "utf8");
  vm.runInContext(code, ctx);
  return {
    elements,
    calls,
    flushGet: () => {
      if (getCallback) {
        const cb = getCallback;
        getCallback = null;
        cb();
      }
    },
    click: (id) => {
      const el = elements[id];
      assert.ok(el.listeners.click, `${id} needs a click handler`);
      el.listeners.click.forEach((fn) => fn());
    },
    change: (id) => {
      const el = elements[id];
      assert.ok(el.listeners.change, `${id} needs a change handler`);
      el.listeners.change.forEach((fn) => fn());
    },
    input: (id) => {
      const el = elements[id];
      assert.ok(el.listeners.input, `${id} needs an input handler`);
      el.listeners.input.forEach((fn) => fn());
    },
    store: backing,
    lsStore: lsBacking,
  };
}

test("popup fills fields from chrome.storage.local without messaging the worker at load", () => {
  const popup = loadPopup({
    stored: { apiKey: "sk-ant-x", mode: "fill", autoEnter: true, showOverlay: false },
    deferGet: true,
  });
  // Defaults are in the fields immediately, before storage answers.
  assert.equal(popup.elements.apiKey.value, "");
  assert.equal(popup.elements.model.value, "claude-opus-5-5");
  assert.equal(popup.elements.effort.value, "low");
  assert.equal(popup.elements.mode.value, "auto");
  assert.equal(popup.elements.autoEnter.checked, false);
  assert.equal(popup.elements.showOverlay.checked, true);
  // No background round-trip was needed to show the popup.
  assert.deepEqual(popup.calls.messages, []);
  popup.flushGet();
  assert.equal(popup.elements.apiKey.value, "sk-ant-x");
  assert.equal(popup.elements.mode.value, "fill");
  assert.equal(popup.elements.autoEnter.checked, true);
  assert.equal(popup.elements.showOverlay.checked, false);
  assert.equal(popup.elements.effort.value, "low");
  assert.deepEqual(popup.calls.messages, []);
  assert.equal(popup.calls.get.length, 1);
});

test("popup save writes every field including autoEnter through storage.local.set", () => {
  const popup = loadPopup({ stored: {} });
  popup.elements.apiKey.value = "  sk-ant-y  ";
  popup.elements.model.value = "claude-haiku-4-5";
  popup.elements.effort.value = "high";
  popup.elements.mode.value = "fill";
  popup.elements.autoEnter.checked = true;
  popup.elements.autoAdvance.checked = true;
  popup.elements.showOverlay.checked = false;
  popup.click("save");
  // JSON-normalise: the saved object is built inside the vm realm, whose
  // Object prototype differs from this realm's (see humanize.test.js).
  assert.deepEqual(JSON.parse(JSON.stringify(popup.calls.set)), [
    {
      apiKey: "sk-ant-y",
      model: "claude-haiku-4-5",
      effort: "high",
      mode: "fill",
      autoAdvance: true,
      showOverlay: false,
      autoEnter: true,
    },
  ]);
  assert.equal(popup.elements.status.textContent, "Saved.");
  assert.deepEqual(popup.calls.messages, []);
});

test("settings survive close and reopen: a save in one popup load shows in the next", () => {
  const store = {};
  const first = loadPopup({ store });
  first.elements.apiKey.value = "sk-ant-x";
  first.elements.model.value = "claude-sonnet-5-5";
  first.elements.autoAdvance.checked = true;
  first.click("save");
  assert.equal(store.model, "claude-sonnet-5-5");
  const second = loadPopup({ store });
  assert.equal(second.elements.apiKey.value, "sk-ant-x");
  assert.equal(second.elements.model.value, "claude-sonnet-5-5");
  assert.equal(second.elements.autoAdvance.checked, true);
  // Untouched settings keep their defaults on reopen, not blanks.
  assert.equal(second.elements.effort.value, "low");
  assert.equal(second.elements.showOverlay.checked, true);
});

test("changing a setting persists without clicking Save", () => {
  const popup = loadPopup({ stored: { model: "claude-opus-5-5" } });
  popup.elements.model.value = "claude-haiku-4-5";
  popup.change("model");
  assert.equal(popup.store.model, "claude-haiku-4-5");
  popup.elements.autoEnter.checked = true;
  popup.change("autoEnter");
  assert.equal(popup.store.autoEnter, true);
  assert.equal(popup.elements.status.textContent, "Saved.");
});

test("typing the API key persists without blurring or clicking Save", () => {
  const popup = loadPopup({ stored: {} });
  popup.elements.apiKey.value = "sk-ant-typed";
  popup.input("apiKey");
  assert.equal(popup.store.apiKey, "sk-ant-typed");
});

test("empty storage never blanks the fields, and storage errors are shown", () => {
  const empty = loadPopup({ stored: {}, deferGet: true });
  empty.flushGet();
  assert.equal(empty.elements.model.value, "claude-opus-5-5");
  assert.equal(empty.elements.effort.value, "low");
  assert.equal(empty.elements.mode.value, "auto");
  assert.equal(empty.elements.showOverlay.checked, true);
  assert.equal(empty.elements.autoEnter.checked, false);

  const failingSave = loadPopup({ stored: {}, failSet: "quota exceeded" });
  failingSave.elements.model.value = "claude-sonnet-5-5";
  failingSave.click("save");
  assert.match(failingSave.elements.status.textContent, /quota exceeded/);
  assert.equal(failingSave.store.model, undefined);

  const failingLoad = loadPopup({ stored: { model: "claude-sonnet-5-5" }, failGet: "storage unavailable" });
  assert.equal(failingLoad.elements.model.value, "claude-opus-5-5");
  assert.match(failingLoad.elements.status.textContent, /storage unavailable/);
});

test("popup test key only messages the worker when clicked, with the trimmed key", () => {
  const popup = loadPopup({ stored: {} });
  popup.elements.apiKey.value = "";
  popup.click("test");
  assert.deepEqual(popup.calls.messages, []);
  assert.equal(popup.elements.status.textContent, "Enter a key first.");
  popup.elements.apiKey.value = "  sk-ant-z  ";
  popup.click("test");
  assert.deepEqual(JSON.parse(JSON.stringify(popup.calls.messages)), [{ type: "testKey", apiKey: "sk-ant-z" }]);
  assert.equal(popup.elements.status.textContent, "Key works.");
});

test("popup shows saved settings immediately from the local mirror, before chrome.storage answers", () => {
  const lsStore = {
    "kch-settings": JSON.stringify({
      apiKey: "sk-ant-m",
      model: "claude-sonnet-5-5",
      effort: "high",
      mode: "fill",
      autoAdvance: true,
      showOverlay: false,
      autoEnter: true,
    }),
  };
  const popup = loadPopup({ stored: {}, deferGet: true, lsStore });
  // Stored values are visible synchronously, with storage still pending.
  assert.equal(popup.elements.apiKey.value, "sk-ant-m");
  assert.equal(popup.elements.model.value, "claude-sonnet-5-5");
  assert.equal(popup.elements.effort.value, "high");
  assert.equal(popup.elements.mode.value, "fill");
  assert.equal(popup.elements.autoAdvance.checked, true);
  assert.equal(popup.elements.showOverlay.checked, false);
  assert.equal(popup.elements.autoEnter.checked, true);
  // An empty storage answer must not blank the mirrored values.
  popup.flushGet();
  assert.equal(popup.elements.model.value, "claude-sonnet-5-5");
  assert.equal(popup.elements.apiKey.value, "sk-ant-m");
});

test("persist writes the local mirror as well as chrome.storage.local", () => {
  const popup = loadPopup({ stored: {} });
  popup.elements.model.value = "claude-haiku-4-5";
  popup.change("model");
  assert.equal(popup.store.model, "claude-haiku-4-5");
  assert.equal(JSON.parse(popup.lsStore["kch-settings"]).model, "claude-haiku-4-5");
  popup.elements.autoEnter.checked = true;
  popup.change("autoEnter");
  assert.equal(JSON.parse(popup.lsStore["kch-settings"]).autoEnter, true);
});

test("a stale mirror is corrected by chrome.storage values, and a corrupt mirror is ignored", () => {
  const staleLs = {
    "kch-settings": JSON.stringify({ model: "claude-opus-5-5", effort: "low", mode: "auto" }),
  };
  const stale = loadPopup({ stored: { model: "claude-sonnet-5-5" }, lsStore: staleLs });
  assert.equal(stale.elements.model.value, "claude-sonnet-5-5");
  assert.equal(JSON.parse(stale.lsStore["kch-settings"]).model, "claude-sonnet-5-5");

  const corruptLs = { "kch-settings": "{not json" };
  const corrupt = loadPopup({ stored: { model: "claude-sonnet-5-5" }, lsStore: corruptLs });
  assert.equal(corrupt.elements.model.value, "claude-sonnet-5-5");
  assert.equal(JSON.parse(corrupt.lsStore["kch-settings"]).model, "claude-sonnet-5-5");
});
