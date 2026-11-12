// Popup: read/write settings straight from chrome.storage.local. The
// previous version asked the background worker for settings on every
// open, which wakes the worker up and is what made the popup slow.
// The worker is now messaged only when "Test key" is clicked.
//
// Settings persist on change, not only on Save: closing the popup
// without clicking Save used to lose dropdown/checkbox changes. Loads
// merge stored values over defaults in this file instead of trusting
// the storage API to apply defaults, so a partial or empty store can
// never blank the fields.
const DEFAULTS = {
  apiKey: "",
  model: "claude-opus-5-5",
  effort: "low",
  mode: "auto",
  wordStyle: "rare",
  enabled: true,
  autoAdvance: false,
  autoPlayAgain: false,
  showOverlay: true,
  serverUrl: "http://localhost:8787",
  serverToken: "",
};
const fields = ["apiKey", "model", "effort", "mode", "wordStyle", "serverUrl", "serverToken"];
const checks = ["enabled", "autoAdvance", "autoPlayAgain", "showOverlay"];
const statusEl = document.getElementById("status");

function show(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || "";
}

function collect() {
  const out = {};
  for (const f of fields) out[f] = document.getElementById(f).value.trim();
  for (const c of checks) out[c] = document.getElementById(c).checked;
  return out;
}

// Fields the user has edited since the popup opened: a late
// storage answer must never overwrite them.
const edited = new Set();
function fill(s) {
  // Merge over the values already showing, not just over
  // defaults: a partial storage answer must not reset the fields
  // it does not mention to defaults.
  const merged = { ...DEFAULTS, ...collect(), ...(s || {}) };
  for (const f of fields) {
    const el = document.getElementById(f);
    let v = merged[f] == null ? "" : merged[f];
    // An unmatched stored value must fall back to the default,
    // never blank the select (a blank select persists as "").
    if (el && el.options) {
      const allowed = Array.from(el.options, (o) => o.value);
      if (allowed.length && !allowed.includes(v)) v = DEFAULTS[f];
    }
    el.value = v;
  }
  for (const c of checks) document.getElementById(c).checked = !!merged[c];
}

// Synchronous mirror in the popup page's own localStorage: reading
// chrome.storage.local is an async round-trip, and saved values only
// appeared after it answered, which is the wait felt when opening the
// popup. The mirror shows saved settings on the first paint; the
// async storage read below stays authoritative and refreshes it.
// The API key is never mirrored: it waits for the storage read.
// chrome.storage.local remains the source of truth (the content
// script and worker can only read that one); the mirror is never
// read anywhere else.
const MIRROR_KEY = "kch-settings";
function readMirror() {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(MIRROR_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    // Mirrors written by older versions may contain the key; never
    // read it back from here. The key waits for the storage read.
    // The cache server token is likewise never mirrored.
    delete parsed.apiKey;
    delete parsed.serverToken;
    return parsed;
  } catch (_) {
    return null;
  }
}
function writeMirror(values) {
  try {
    if (typeof localStorage === "undefined") return;
    // The key lives only in chrome.storage.local (see popup.html):
    // it is never copied into localStorage, where clearing the
    // extension store would leave it behind. Same for the cache
    // server token.
    const copy = { ...values };
    delete copy.apiKey;
    delete copy.serverToken;
    localStorage.setItem(MIRROR_KEY, JSON.stringify(copy));
  } catch (_) {
    // Mirror is best-effort; chrome.storage.local below is authoritative.
  }
}
function hasKnownKey(s) {
  return fields.some((f) => f in s) || checks.some((c) => c in s);
}

function persist(showSaved) {
  const out = collect();
  // Synchronous, so closing the popup before the async write finishes
  // cannot lose the change; the next open still sees it in the mirror.
  writeMirror(out);
  chrome.storage.local.set(out, () => {
    const err = chrome.runtime.lastError;
    if (err) {
      show("Could not save settings: " + err.message, "err");
      // The mirror must not keep values the store rejected: refresh
      // it from what storage actually holds.
      chrome.storage.local.get(null, (s2) => {
        if (chrome.runtime.lastError || !s2) return;
        const keep = collect();
        for (const k of [...fields, ...checks]) if (k in s2) keep[k] = s2[k];
        writeMirror(keep);
      });
    } else if (showSaved) show("Saved.", "ok");
  });
}

// Fill with defaults, then the mirror, so saved values are visible
// immediately; the storage read below refreshes anything stale.
fill(DEFAULTS);
const mirror = readMirror();
if (mirror) fill(mirror);
chrome.storage.local.get(null, (s) => {
  const err = chrome.runtime.lastError;
  if (err) {
    show("Could not load settings: " + err.message, "err");
    return;
  }
  // An empty answer must not blank values the mirror already showed.
  // Fields edited while the read was in flight keep the user's
  // values: the read is stale for those.
  if (s && hasKnownKey(s)) {
    const fresh = { ...s };
    for (const k of edited) delete fresh[k];
    fill(fresh);
    writeMirror(collect());
  }
});

for (const f of fields) document.getElementById(f).addEventListener("change", () => { edited.add(f); persist(true); });
for (const c of checks) document.getElementById(c).addEventListener("change", () => { edited.add(c); persist(true); });
// The key saves as it is typed too, so closing the popup mid-typing
// does not lose it; change/blur and Save cover the rest.
document.getElementById("apiKey").addEventListener("input", () => { edited.add("apiKey"); persist(false); });

document.getElementById("save").addEventListener("click", () => persist(true));

document.getElementById("test").addEventListener("click", () => {
  const apiKey = document.getElementById("apiKey").value.trim();
  if (!apiKey) return show("Enter a key first.", "err");
  show("Testing…");
  chrome.runtime.sendMessage({ type: "testKey", apiKey }, (r) => {
    const err = chrome.runtime.lastError;
    if (err) show("Key failed: " + err.message, "err");
    else if (r && r.ok) show("Key works.", "ok");
    else show("Key failed: " + ((r && r.error) || "unknown error"), "err");
  });
});
