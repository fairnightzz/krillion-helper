// Content script for krillion.io.
// Watches the game, asks the background worker for candidate answers as soon as a
// prompt is visible (during the 3s preview), then fills / submits them in the
// 25s answer window. Falls through the candidate list on rejections.
// In Puffer Party games (rated and casual) it types, human-like and
// one keystroke at a time (see humanize.js), and submits only in
// Mode "auto"; in Mode "fill" the player presses Enter.

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);

  // Mode drives both games: "auto" fills/types and submits, "fill"
  // fills/types only (you press Enter), "suggest" shows candidates only.
  const settings = {
    enabled: true, // master switch: false disables everything below
    mode: "auto",
    wordStyle: "rare", // rare: rare-first with a common bench; common: common bench only
    autoAdvance: false,
    showOverlay: true,
  };

  // Party games keep two lists (see fetchCandidates): rare answers to
  // chase depth, and a separate common bench. Solo keeps one list.

  const state = {
    roundKey: null,
    prompt: null,
    candidates: [],
    idx: 0,
    rare: [],        // party: rare candidates, rarest first
    common: [],      // party: common bench, rarest first among the certain
    rareIdx: 0,
    commonIdx: 0,
    rejected: [],
    fetching: false,
    refetched: false,
    lastSubmitted: null,
    submittedAt: 0,
    lastReject: null,
    lastCorrection: null,
    filledForUser: null,
    advanceTimer: null,
    error: null,
    status: "idle",
    said: new Set(),      // party: answers already played this category (lowercase)
    saidForms: new Map(), // party: norm -> readable form first seen, for refetch excludes
    copied: null,
    copiedTimer: null,
    partyFetchAt: 0,    // last party candidate fetch, for the refetch cooldown
    typing: null,         // rated party: in-flight humanize.js handle
    typingFor: null,      // candidate being typed
    awaitingResult: null, // rated party: text just submitted, result pending
    awaitingAt: 0,
    enterTimer: null, // rated party: pending auto-Enter timeout
    enterAttemptedFor: null, // rated party: round|candidate already submitted by auto-Enter
    enterDiag: null, // rated party: why the last auto-Enter attempt was blocked
    enterDiagAt: 0,
    prevBoxText: null, // rated party: text submitted/typed last round; a leftover, not fresh typing
    wasMyTurn: false,     // rated party: holder was me on the previous tick
    turnStartAt: 0,      // rated party: when this turn became mine
    rejectCount: 0,      // rejections so far in this turn of mine
    partyRejectSeen: null, // rated party: last .ds-reject text acted on
    ratedLatched: false,  // this room is a rated (queue) table
    ratedForPath: "",
  };

  // Literal comparison for matching SHOWN forms to list entries:
  // lowercase, fold accents, drop spaces and punctuation, then the
  // bounded spelling-variant word rules below (grey, colour, and the
  // like). The text typed and shown stays verbatim. Submitted entries
  // are marked used by event (see attemptPartySubmit), not by this
  // comparison. Keep in sync with canonicalKey in background.js.
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
    // Compounds such as "battleshipgrey" carry the variant inside the
    // word; the whole-word spelling rules below would miss them.
    w = w.replace(/grey/g, "gray");
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
  const norm = (s) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/æ/g, "ae")
      .replace(/œ/g, "oe")
      .replace(/ß/g, "ss")
      .replace(/ø/g, "o")
      .replace(/ł/g, "l")
      .replace(/đ/g, "d")
      .replace(/þ/g, "th")
      .replace(/ð/g, "d")
      .replace(/ı/g, "i")
      .replace(/[“”"]/g, "")
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
      .map(canonicalWord)
      .join("");

  // Variant-aware rejection check: "Battleship grey" counts as the
  // rejected "Battleship gray", and vice versa.
  function isRejected(text) {
    const key = norm(text);
    return state.rejected.some((r) => norm(r) === key);
  }

  // Record a played answer, keeping its readable form: refetch
  // excludes are sent to the model, so they must be names, not the
  // compact norms used for equality.
  function markSaid(text, form) {
    const key = norm(text);
    if (!key) return;
    state.said.add(key);
    if (form && !state.saidForms.has(key)) state.saidForms.set(key, String(form).trim());
  }
  // Names to exclude on a refetch: the original spellings of played
  // and rejected answers, not compact norms.
  function excludeNames() {
    const names = new Set(state.rejected);
    for (const c of displayList()) {
      if (state.said.has(norm(c)) || isRejected(c)) names.add(c);
    }
    for (const form of state.saidForms.values()) names.add(form);
    return [...names].slice(-40);
  }

  // Remember what this extension left in the box when a turn or
  // round ends, so the next turn can tell that leftover from fresh
  // player text. Captures the exact box text when it is this
  // extension's draft — a finished answer, or a prefix of one
  // still being typed when time ran out. Text matching nothing
  // this extension was working on is never captured. Returns
  // whether prevBoxText was (re)set by this call.
  function captureLeftover() {
    const input = partyInput();
    const draft = state.typingFor || state.filledForUser || state.awaitingResult;
    const box = input ? input.value : "";
    if (
      box && draft &&
      (norm(box) === norm(draft) || draft.startsWith(box) ||
        box.startsWith(draft) || norm(draft).startsWith(norm(box)))
    ) {
      state.prevBoxText = box;
      return true;
    }
    if (state.filledForUser || state.awaitingResult) {
      state.prevBoxText = state.filledForUser || state.awaitingResult;
      return true;
    }
    return false;
  }

  // ---------- overlay ----------
  let overlay;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement("div");
    overlay.id = "kch-overlay";
    overlay.innerHTML =
      '<div class="kch-head">HELPER <span class="kch-mode"></span><span class="kch-hint"></span></div>' +
      '<div class="kch-status"></div><ol class="kch-list"></ol>';
    // Click a suggestion to copy it. mousedown is prevented so the game's input keeps focus.
    overlay.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li");
      if (!li) return;
      e.preventDefault();
      copyText(li.dataset.text || li.textContent);
    });
    document.documentElement.appendChild(overlay);
    return overlay;
  }
  function copyText(text) {
    const done = () => {
      state.copied = text;
      clearTimeout(state.copiedTimer);
      state.copiedTimer = setTimeout(() => { state.copied = null; render(); }, 1200);
      render();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text) && done());
    } else if (fallbackCopy(text)) {
      done();
    }
  }
  function fallbackCopy(text) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch (_) {
      return false;
    }
  }
  // The game mutates the DOM constantly (animations, timers), and render()
  // is called from the tick loop, so rebuilding the candidate list on
  // every call churns the DOM for no visible change. Skip the rebuild
  // when everything the overlay shows is unchanged.
  let lastRenderSig = null;
  // Party overlay list: rare list, then the common bench. Solo shows
  // the single candidate list. Common-only play shows and uses the
  // bench alone, even if rare answers are still stored.
  function displayList() {
    if (isParty()) {
      return settings.wordStyle === "common" ? [...state.common] : [...state.rare, ...state.common];
    }
    return state.candidates;
  }
  function render() {
    // Disabled: no overlay at all, even if one was already created.
    if (!settings.enabled) {
      if (overlay) overlay.style.display = "none";
      return;
    }
    // No game surface on this page (homepage, blog, lobby shell):
    // never create or show the overlay here. It is created only
    // once a party root, prompt card, or solo dock exists.
    if (!isParty() && !$(".ds-card") && !$("form.ds-dock")) {
      if (overlay) overlay.style.display = "none";
      return;
    }
    const o = ensureOverlay();
    o.style.display = settings.showOverlay ? "" : "none";
    const party = isParty();
    const rated = party && isRatedParty();
    const items = displayList();
    const curText = party ? norm(state.typingFor || state.filledForUser || "") : "";
    const sig = [
      party, rated, settings.showOverlay, settings.mode,
      state.status, state.error, state.idx, curText, state.copied,
      items.join("\u0000"), state.rejected.join("\u0000"),
      [...state.said].sort().join("\u0000"),
    ].join("\u0000");
    if (sig === lastRenderSig) return;
    lastRenderSig = sig;
    o.classList.toggle("kch-party", party);
    o.classList.toggle("kch-rated", rated);
    $(".kch-mode", o).textContent = rated ? "rated" : party ? "party" : settings.mode;
    $(".kch-hint", o).textContent = items.length ? (partyTypingOn() ? (settings.mode === "auto" ? "auto-Enter on" : "typing — press Enter") : "click = copy") : "";
    const st = $(".kch-status", o);
    st.textContent = state.error ? "error: " + state.error : state.status;
    st.classList.toggle("kch-err", !!state.error);
    const list = $(".kch-list", o);
    list.innerHTML = "";
    items.forEach((c, i) => {
      const li = document.createElement("li");
      li.textContent = c;
      li.dataset.text = c;
      const isCur = party ? (curText !== "" && norm(c) === curText) : i === state.idx;
      if ((!party || rated) && isCur) li.classList.add("kch-cur");
      if (isRejected(c) || state.said.has(norm(c))) li.classList.add("kch-rej");
      if (state.copied === c) li.classList.add("kch-copied");
      list.appendChild(li);
    });
  }
  function setStatus(s) {
    state.status = s;
    render();
  }

  // ---------- React-safe input helpers ----------
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  function fillInput(input, text) {
    nativeSetter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  // Whether box text is this extension's leftover, not fresh player
  // text: it matches the draft being typed or submitted, the
  // remembered leftover, or a list entry already said or rejected.
  function isOwnLeftover(boxText) {
    if (!boxText) return false;
    const draft = state.typingFor || state.filledForUser || state.awaitingResult;
    if (
      draft &&
      (norm(boxText) === norm(draft) || draft.startsWith(boxText) ||
        boxText.startsWith(draft) || norm(draft).startsWith(norm(boxText)))
    ) {
      return true;
    }
    if (state.prevBoxText && norm(boxText) === norm(state.prevBoxText)) return true;
    return displayList().some(
      (c) => norm(c) === norm(boxText) && (state.said.has(norm(c)) || isRejected(c)),
    );
  }

  function submitForm(form) {
    // Let React commit the state update from the input event first.
    setTimeout(() => {
      const btn = $(".ds-dive-btn", form);
      if (btn && !btn.disabled) btn.click();
      else form.requestSubmit();
    }, 60);
  }

  function secondsLeft() {
    const t = $(".ds-time-digits");
    const n = t ? parseInt(t.textContent, 10) : NaN;
    return Number.isFinite(n) ? n : 99;
  }

  // ---------- rated Puffer Party detection ----------
  // Queue tables label themselves RATED / UNRATED in the HUD pod
  // (aria-label "Rated … table <code>", label "RATED …"); the lobby shows
  // "RATED TABLE" / "QUICK PLAY". Hosted rooms have neither label and are
  // not rated. The result is latched per URL: the HUD can re-render between
  // phases, but a room never changes rated-ness mid-game. Elo numbers
  // alone are NOT used: they can show for players in unrated rooms too.
  function ratedLabel() {
    const pod = $(".pf-room-privacy");
    if (pod) {
      const aria = (pod.getAttribute("aria-label") || "").trim();
      if (/^Rated\b/i.test(aria)) return true;
      if (/^Unrated\b/i.test(aria)) return false;
      const label = $(".label", pod);
      const txt = label ? label.textContent.trim() : "";
      // The label check must be case-insensitive like the aria
      // check: a mixed-case "Rated …" label with no aria-label
      // otherwise never latches.
      if (/^Rated\b/i.test(txt)) return true;
      if (/^Unrated\b/i.test(txt)) return false;
      if (/^Quick Play\b/i.test(txt)) return false;
      return null;
    }
    const info = $(".pf-rated-info .label");
    if (info) {
      const txt = info.textContent.trim();
      if (/^Rated\b/i.test(txt)) return true;
      if (/^Quick Play\b/i.test(txt)) return false;
    }
    return null;
  }
  function updateRatedLatch() {
    if (location.pathname !== state.ratedForPath) {
      state.ratedLatched = false;
      state.ratedForPath = location.pathname;
    }
    const label = ratedLabel();
    if (label !== null) state.ratedLatched = label;
  }
  function isRatedParty() {
    return state.ratedLatched;
  }

  // Typing and submitting run in every party game — rated and
  // casual alike — in every mode except suggest, which stays
  // copy-only. The rated latch above now only drives the overlay
  // badge, not whether typing happens.
  function partyTypingOn() {
    return isParty() && settings.mode !== "suggest";
  }

  // ---------- party typing ----------
  // The party dock is a <div>, not a form: its submit control is the
  // "Send answer" button (.ds-dive-btn) beside the input; the timer
  // digits show lives, and Enter on the input also submits. Typing only
  // starts when the game itself says it is our turn: the input is enabled
  // and its placeholder / the status line say "your puffer".
  function partyInput() {
    const dock = $(".pf-root .ds-dock");
    return dock ? $(".ds-input", dock) : null;
  }
  function isMyTurn(input) {
    if (!input || input.disabled) return false;
    const root = $(".pf-root");
    if (root && root.dataset && root.dataset.phase && root.dataset.phase !== "answering") return false;
    if (/your puffer/i.test(input.getAttribute("placeholder") || "")) return true;
    const status = $(".pf-status");
    return !!(status && /your puffer/i.test(status.textContent));
  }
  function focusPartyInput(input) {
    const ae = document.activeElement;
    if (ae === input) return;
    // Never steal focus from chat or another field the user is typing in.
    if (ae && ae !== input && (ae.tagName === "INPUT" || ae.tagName === "TEXTAREA" || ae.tagName === "SELECT" || ae.isContentEditable)) return;
    try {
      input.focus({ preventScroll: true });
    } catch (_) {
      input.focus();
    }
  }
  function clearEnterTimer() {
    if (state.enterTimer !== null) {
      clearTimeout(state.enterTimer);
      state.enterTimer = null;
    }
  }
  function cancelTyping() {
    // Preserve the abandoned draft's identity before dropping it:
    // a partial draft left in the box when typing is cancelled is
    // still this extension's text. Without this, the turn-end
    // delete cannot tell it from text the player typed.
    if (state.typingFor) {
      const live = partyInput();
      if (
        live && live.value &&
        (norm(live.value) === norm(state.typingFor) ||
          state.typingFor.startsWith(live.value) ||
          norm(state.typingFor).startsWith(norm(live.value)))
      ) {
        state.prevBoxText = live.value;
      }
    }
    if (state.typing) {
      state.typing.cancel();
      state.typing = null;
    }
    state.typingFor = null;
    // A pending auto-Enter belongs to the typing just cancelled.
    clearEnterTimer();
  }
  // Auto-submit in Mode "auto": submit by clicking the dock's "Send answer"
  // button (.ds-dive-btn), the same control the solo dive submits with
  // and the same callback Enter on the input calls. A synthetic Enter
  // keydown did not reach that callback in the live game, so it is only
  // a fallback for layouts with no button. Every guard from typing is
  // re-checked at fire time: the box must still hold exactly this
  // candidate, on our turn, in the same round.
  function dispatchEnterKey(input) {
    try {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
      return true;
    } catch (_) {
      return false;
    }
  }
  // A blocked auto-Enter used to fail silently (the overlay kept
  // saying the answer was typed). Record the reason in the overlay and
  // the console so a live failure says which guard stopped it.
  function blockSubmit(reason) {
    state.enterDiag = "auto-Enter blocked: " + reason;
    state.enterDiagAt = Date.now();
    setStatus(state.enterDiag);
    console.warn("[kch] " + state.enterDiag);
    return false;
  }
  function attemptPartySubmit(input, candidate, key) {
    // Re-resolve the live input first: React may remount the dock node
    // between typing and submitting (round/phase transitions), and the
    // node captured when typing started can go stale while the box
    // itself still holds the finished answer.
    const live = partyInput();
    input = live && document.contains(live) ? live : input;
    if (state.roundKey !== key) return blockSubmit("round changed");
    if (!settings.enabled) return blockSubmit("helper is disabled");
    // Re-checked at fire time, not just at schedule time: the user may
    // have switched Mode while the Enter timer was pending.
    if (settings.mode !== "auto") return blockSubmit("mode is not auto");
    if (!isMyTurn(input)) return blockSubmit("not my turn");
    if (!input || !document.contains(input)) return blockSubmit("no input");
    if (norm(input.value) !== norm(candidate)) return blockSubmit("box changed");
    if (state.said.has(norm(candidate)) || isRejected(candidate)) return blockSubmit("answer already used");
    const dock = $(".pf-root .ds-dock");
    const btn = dock ? $(".ds-dive-btn", dock) : null;
    state.awaitingResult = input.value.trim();
    state.awaitingAt = Date.now();
    setStatus('submitting "' + candidate + '"');
    let dispatched = false;
    let usedButton = false;
    if (btn && !btn.disabled) {
      try {
        btn.click();
        dispatched = true;
        usedButton = true;
      } catch (_) {
        // Fall through to the Enter keydown below.
      }
    }
    // Otherwise (no button, a disabled button, or a click that threw):
    // fall through to the Enter keydown below. The button's disabled
    // gate is not the Enter handler's gate, so a disabled button must
    // not give up on its own.
    if (!dispatched) dispatched = dispatchEnterKey(input);
    if (dispatched && usedButton) {
      // Mark the submitted entry crossed at submit time, by event:
      // it counts as used even if the game shows a different corrected
      // form. Also record the box text itself, which may already be
      // the game's corrected spelling.
      markSaid(candidate, candidate);
      const boxText = input.value.trim();
      if (boxText && norm(boxText) !== norm(candidate)) markSaid(boxText, boxText);
    }
    // A synthetic Enter keydown is known not to reach the game's
    // submit callback in some layouts, so dispatching it must not
    // mark the answer used: if it did submit, the turn passing (or
    // the rejection banner) records it; if it did not, the box
    // still holds it for the player to submit by hand. The
    // attempt latch in submitPartyAnswer still stops re-dispatch.
    return dispatched;
  }
  function submitPartyAnswer(input, candidate, key) {
    state.enterTimer = null;
    if (!attemptPartySubmit(input, candidate, key)) return;
    state.enterAttemptedFor = key + "|" + candidate;
    // One attempt only. A retry was tried while chasing the caret bug
    // and only added status churn: a lost click is already covered by
    // fresh DOM lookups inside the attempt and by the tick backup that
    // re-schedules a never-attempted submit, while a second attempt
    // after a slow server reply risks a duplicate submit.
  }
  function startTyping(input, candidate, alreadyTyped) {
    const humanize = globalThis.KchHumanize;
    if (!humanize) return;
    const key = state.roundKey;
    const remaining = candidate.slice(alreadyTyped.length);
    // Plan only the remaining suffix, then shift every step value to the
    // full input value (what is already there + what is typed next).
    const steps = humanize.planTyping(remaining).map((s) => ({ ...s, value: alreadyTyped + s.value }));
    focusPartyInput(input);
    const handle = humanize.typeHumanlike(input, remaining, {
      steps,
      initialValue: alreadyTyped,
      shouldContinue: (prefix) => {
        if (state.roundKey !== key) return false;
        if (settings.mode === "suggest") return false;
        if (!isMyTurn(input)) return false;
        if (partyInput() !== input || !document.contains(input)) return false;
        if (input.value !== prefix) return false; // user or game changed the box
        if (state.said.has(norm(candidate)) || isRejected(candidate)) return false;
        return true;
      },
    });
    state.typing = handle;
    state.typingFor = candidate;
    handle.done.then((ok) => {
      if (state.typing !== handle) return;
      state.typing = null;
      // On abort, keep typingFor: the abandoned draft still identifies
      // what this extension typed, so the dead-candidate recovery in
      // partyAutoTick can clear it. Cleared by cancelTyping,
      // resetRound, or the next startTyping.
      if (ok && state.roundKey === key) {
        state.typingFor = null;
        state.filledForUser = candidate;
        if (settings.mode === "auto") {
          setStatus('typed "' + candidate + '" — pressing Enter…');
          clearEnterTimer();
          // Short, jittered pause before Enter, like glancing at the answer.
          state.enterTimer = setTimeout(() => {
            submitPartyAnswer(input, candidate, key);
          }, 400 + Math.random() * 500);
        } else {
          setStatus('typed "' + candidate + '" — press Enter');
        }
      }
    });
  }

  // ---------- answer lookup ----------
  // Party lists arrive in sections (rare/common). kind: 'both' for the
  // first fetch of a round, 'rare' or 'common' when regenerating one
  // list that ran out. Solo ignores kind and uses one list.
  function fetchCandidates(prompt, exclude, kind) {
    // Common-only play never asks for rare answers, whatever list
    // the caller asked to regenerate.
    if (isParty() && settings.wordStyle === "common") kind = "common";
    if (isParty()) state.partyFetchAt = Date.now();
    state.fetching = true;
    state.error = null;
    setStatus(exclude && exclude.length ? "fetching more…" : "thinking…");
    const key = state.roundKey;
    chrome.runtime.sendMessage({ type: "getAnswers", prompt, exclude, party: isParty(), kind: kind || null, wordStyle: settings.wordStyle }, (res) => {
      if (state.roundKey !== key) return; // round moved on
      state.fetching = false;
      if (chrome.runtime.lastError || !res || !res.ok) {
        state.error = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (res && res.error) || "unknown error";
        render();
        return;
      }
      if (isParty() && (Array.isArray(res.rare) || Array.isArray(res.common))) {
        const have = new Set(displayList().map(norm));
        const freshRare = (res.rare || []).filter((x) => !have.has(norm(x)));
        const freshCommon = (res.common || []).filter((x) => !have.has(norm(x)));
        if (exclude && exclude.length) {
          state.rare = state.rare.concat(freshRare);
          state.common = state.common.concat(freshCommon);
        } else if (freshRare.length || freshCommon.length) {
          // A replace only installs a non-empty list: an overlapping
          // stale response whose entries were all filtered as
          // duplicates of the installed list must not wipe it.
          state.rare = freshRare;
          state.common = freshCommon;
          state.rareIdx = 0;
          state.commonIdx = 0;
        }
        setStatus(partyTypingOn() ? usableCount() + " unused · will type on your turn" : "click a word to copy it · " + usableCount() + " unused");
        return;
      }
      if (isParty()) {
        // Legacy response (a single combined list, e.g. an older worker):
        // split it the way the two-section format would have, rarest
        // first and the last six as the common bench.
        const all = (res.candidates || []).filter((x) => ![...state.rare, ...state.common].some((y) => norm(y) === norm(x)));
        const split = Math.max(0, all.length - 6);
        if (exclude && exclude.length) {
          state.rare = state.rare.concat(all.slice(0, split));
          state.common = state.common.concat(all.slice(split));
        } else if (all.length) {
          state.rare = all.slice(0, split);
          state.common = all.slice(split);
          state.rareIdx = 0;
          state.commonIdx = 0;
        }
        setStatus(partyTypingOn() ? usableCount() + " unused · will type on your turn" : "click a word to copy it · " + usableCount() + " unused");
        return;
      }
      const have = new Set(state.candidates.map(norm));
      const fresh = res.candidates.filter((x) => !have.has(norm(x)));
      if (exclude && exclude.length) {
        state.candidates = state.candidates.concat(fresh);
      } else if (fresh.length || !state.candidates.length) {
        state.candidates = fresh;
        state.idx = 0;
      }
      setStatus(state.candidates.length + " candidates, rarest first");
    });
  }

  function resetRound(key, prompt) {
    clearTimeout(state.advanceTimer);
    // Capture the leftover before cancelTyping drops typingFor: a
    // draft still being typed when the category changed is a
    // leftover too, and the next round must be able to clear it.
    // A leftover already saved by the not-my-turn branch is kept
    // when there is nothing new to capture.
    captureLeftover();
    cancelTyping();
    // The game keeps the last submitted answer in the box into the next
    // category. The captured text above is what lets the next round
    // tell that leftover from text the player is typing fresh. Only
    // text this extension typed or the player submitted counts:
    // unsubmitted typing by the player is left alone and still
    // shows "not overwriting".
    Object.assign(state, {
      roundKey: key,
      prompt,
      candidates: [],
      idx: 0,
      rare: [],
      common: [],
      rareIdx: 0,
      commonIdx: 0,
      rejectCount: 0,
      turnStartAt: 0,
      rejected: [],
      fetching: false,
      refetched: false,
      lastSubmitted: null,
      submittedAt: 0,
      lastReject: null,
      lastCorrection: null,
      filledForUser: null,
      advanceTimer: null,
      error: null,
      partyNoted: false,
      typing: null,
      typingFor: null,
      wasMyTurn: false,
      partyRejectSeen: null,
      awaitingResult: null,
      awaitingAt: 0,
      enterTimer: null,
      enterAttemptedFor: null,
      enterDiag: null,
      enterDiagAt: 0,
      said: new Set(),
      saidForms: new Map(),
      copied: null,
    });
    fetchCandidates(prompt, []);
  }

  // ---------- main loop ----------
  function maybeAutoAdvance() {
    // Feedback phase (the prompt card is gone, a DESCEND button is shown).
    const next = $(".ds-next-wrap .ds-next-btn");
    if (next && settings.autoAdvance && settings.mode === "auto" && !state.advanceTimer) {
      state.advanceTimer = setTimeout(() => {
        state.advanceTimer = null;
        const n = $(".ds-next-wrap .ds-next-btn");
        if (n) n.click();
      }, 2500);
    }
  }

  function isParty() {
    return !!$(".pf-root");
  }

  function partyCard() {
    // Puffer Party: ignore the "New category" placeholder card and cleared categories.
    return $(".ds-card:not(.pf-newcat):not(.cleared)");
  }
  function currentPrompt() {
    if (isParty()) {
      const card = partyCard();
      const p = card ? $(".prompt", card) : null;
      return p ? p.textContent.trim() : "";
    }
    const p = $(".ds-card .prompt");
    return p ? p.textContent.trim() : "";
  }
  function partyRoundCount() {
    // The card's "CATEGORY n" heading is stable for the whole category;
    // its NEW/CLEARED tag is not, so match only the number.
    const card = partyCard();
    const rnd = card ? $(".rnd", card) : null;
    const m = rnd ? rnd.textContent.match(/category\s*\d+/i) : null;
    return m ? m[0].replace(/\s+/g, " ").toUpperCase() : "party";
  }

  function usableIn(list) {
    return list.filter((c) => !isRejected(c) && !state.said.has(norm(c))).length;
  }
  function usableCount() {
    return usableIn(displayList());
  }
  // Find a candidate text in the party lists, for rejection/clear
  // handling. Returns { list: "rare" | "common", index } or null.
  function findPartyCandidate(text) {
    const t = norm(text);
    let i = state.rare.findIndex((c) => norm(c) === t);
    if (i >= 0) return { list: "rare", index: i };
    i = state.common.findIndex((c) => norm(c) === t);
    if (i >= 0) return { list: "common", index: i };
    return null;
  }
  // First usable entry of one party list from a start index; also
  // advances that list's pointer to the entry found.
  function pickFromList(listName, start, maxLen) {
    const list = listName === "rare" ? state.rare : state.common;
    for (let i = start; i < list.length; i += 1) {
      const c = list[i];
      if (c.length > maxLen) continue;
      if (isRejected(c) || state.said.has(norm(c))) continue;
      if (listName === "rare") state.rareIdx = i;
      else state.commonIdx = i;
      return c;
    }
    return null;
  }

  function partyTick() {
    let changed = false;
    // Seats show accepted answers in speech bubbles — but the holder's
    // LIVE TYPING is shown in the same bubble with class "caret". That
    // draft is not a played answer: counting it marked our own answer
    // "already used" and blocked its submit. Exclude caret bubbles;
    // accepted ("ok"/"rest") and rejected ("bad", via the banner below)
    // answers still count.
    document.querySelectorAll(".pf-say.on:not(.bad):not(.caret)").forEach((el) => {
      const t = norm(el.textContent);
      if (t && !state.said.has(t)) { markSaid(el.textContent, el.textContent); changed = true; }
    });
    // Rejected answers ("bad" bubbles) count as tried too, for every
    // player: typing one again only earns another rejection. Caret
    // drafts are still excluded above.
    document.querySelectorAll(".pf-say.on.bad").forEach((el) => {
      const t = norm(el.textContent);
      if (t && !state.said.has(t)) { markSaid(el.textContent, el.textContent); changed = true; }
    });
    // Reject banner: “x”: already said  /  “x”: no echo. keep going
    const rej = $(".ds-reject");
    if (rej) {
      const m = rej.textContent.match(/[“"](.+?)[”"]/);
      if (m) {
        const t = norm(m[1]);
        if (!state.said.has(t)) { markSaid(m[1], m[1]); changed = true; }
      }
    }
    if (state.fetching) { if (changed) render(); return; }
    if (!displayList().length) return;
    const usable = usableCount();
    // Regenerate whichever list has run out, on its own: an empty
    // rare list refills with rare answers, a nearly empty common
    // bench (one left) refills early, since duels burn through it.
    // Both empty refills both. Cooldown: without it, a round with few
    // usable candidates would refetch on every tick and a refetch in
    // flight would starve typing.
    const total = displayList().length;
    const rareUsable = usableIn(state.rare);
    const commonUsable = usableIn(state.common);
    const kind = settings.wordStyle === "common"
      ? (usable < 3 ? "common" : null)
      : rareUsable === 0 && commonUsable === 0 ? "both"
      : rareUsable === 0 ? "rare"
      : commonUsable <= 1 ? "common"
      : usable < 3 ? "both" : null;
    // The cap bounds memory, not usability: the lists only grow
    // within a round, so a low cap strands a long category with
    // "out of candidates" once every entry is said or rejected.
    if (kind && total < 200 && Date.now() - state.partyFetchAt > 5000) {
      const exclude = excludeNames();
      fetchCandidates(state.prompt, exclude, kind);
      return;
    }
    if (changed) setStatus(partyTypingOn() ? usable + " unused" : "click a word to copy it · " + usable + " unused");
  }

  // Every party game, rated or casual. Types the rarest unused
  // candidate when it is our turn, and submits in Mode "auto".
  // Mode "suggest" disables typing; Mode "fill" types only, and
  // the player presses Enter.
  function partyAutoTick() {
    if (settings.mode === "suggest") return;
    const input = partyInput();
    const myTurn = isMyTurn(input);
    if (!myTurn) {
      if (state.wasMyTurn) {
        // Time ran out / the turn passed. Identify the leftover
        // before cancelTyping drops typingFor, then clear this
        // extension's wrong answer from the box so it cannot
        // carry into the next turn. Only text identified as this
        // extension's leftover is cleared; anything else in the
        // box is left alone. The stale-box check on the next
        // turn is the backup if this clear does not stick.
        const live = partyInput();
        const own = live && isOwnLeftover(live.value);
        captureLeftover();
        cancelTyping();
        if (own && live && live.value) fillInput(live, "");
      }
      state.wasMyTurn = false;
      // An attempted answer counts as used even if its bubble was
      // never scanned (the corrected form may have shown only
      // briefly, or not at all). The turn passing is the evidence
      // the attempt was made; a merely typed, never-submitted draft
      // has no awaitingResult and is not recorded here.
      if (state.awaitingResult) markSaid(state.awaitingResult, state.awaitingResult);
      state.filledForUser = null;
      state.awaitingResult = null;
      state.enterDiag = null;
      state.enterAttemptedFor = null;
      return;
    }
    if (!state.wasMyTurn) {
      state.turnStartAt = Date.now();
      // A new turn starts from rare again: one rejection jumps this
      // turn to the common bench, but the next turn gets a fresh
      // chance at rare. (The rejected answers themselves stay
      // rejected for the round; only the jump resets.)
      state.rejectCount = 0;
    }
    state.wasMyTurn = true;
    // Type with the candidates already in hand even while a refetch is in
    // flight; the refetch only appends. Waiting for it would starve typing
    // whenever few candidates are usable.
    if (!displayList().length) return;

    // A rejection the player just got for the answer they submitted:
    // advance past it, and clear the rejected text out of the box so the
    // next candidate can be typed. The banner disappears once acted on;
    // forgetting it then lets an identical later rejection act again.
    const rej = $(".ds-reject");
    const rejText = rej ? rej.textContent.trim() : "";
    if (!rejText) {
      state.partyRejectSeen = null;
    } else if (rejText !== state.partyRejectSeen) {
      state.partyRejectSeen = rejText;
      state.rejectCount += 1;
      state.awaitingResult = null;
      cancelTyping();
      const m = rejText.match(/[“"](.+?)[”"]/);
      if (m) {
        const rejectedText = m[1];
        const found = findPartyCandidate(rejectedText);
        if (found) {
          const list = found.list === "rare" ? state.rare : state.common;
          if (!isRejected(list[found.index])) state.rejected.push(list[found.index]);
          if (found.list === "rare") {
            if (found.index >= state.rareIdx) state.rareIdx = found.index + 1;
          } else if (found.index >= state.commonIdx) {
            state.commonIdx = found.index + 1;
          }
        }
        if (state.filledForUser && norm(state.filledForUser) === norm(rejectedText)) state.filledForUser = null;
        if (norm(input.value) === norm(rejectedText)) fillInput(input, "");
      }
      render();
    }
    if (state.typing) return;

    // The player just pressed Enter on this text and the result has not
    // arrived yet (acceptance passes the turn; rejection shows the banner
    // above). Do not retype it into a box the game just cleared.
    if (state.awaitingResult && Date.now() - state.awaitingAt < 5000) return;
    // Expiry is not a free re-pick of the same answer: the attempt
    // counts as used (the auto path already records it; the manual
    // Enter path did not), so the next pick moves on instead of
    // retyping and resubmitting the same candidate.
    if (state.awaitingResult) markSaid(state.awaitingResult, state.awaitingResult);
    state.awaitingResult = null;

    // The answer this extension typed has become unusable since it was
    // typed — said by another player while typing, or rejected — so
    // drop it and move to the next candidate instead of leaving it in
    // the box, where every later tick would refuse to overwrite it as
    // "your text". A prefix of the abandoned draft qualifies only when
    // it was this extension's draft; a full match to a dead candidate
    // qualifies whoever typed it, since submitting it can only be
    // rejected as already said.
    const ours = state.typingFor || state.filledForUser;
    const oursDead = !!ours && (state.said.has(norm(ours)) || isRejected(ours));
    const boxedDead = !!input.value && displayList().some(
      (c) => norm(c) === norm(input.value) && (state.said.has(norm(c)) || isRejected(c)),
    );
    if (input.value && ((oursDead && ours.startsWith(input.value)) || boxedDead)) {
      const dead = oursDead ? ours : input.value;
      cancelTyping();
      const foundDead = findPartyCandidate(dead);
      if (foundDead) {
        const list = foundDead.list === "rare" ? state.rare : state.common;
        if (!isRejected(list[foundDead.index])) state.rejected.push(list[foundDead.index]);
      }
      state.filledForUser = null;
      state.enterDiag = null;
      fillInput(input, "");
    }

    const maxLen = input.maxLength > 0 ? input.maxLength : 60;
    // Pick rarest-first, then the common bench. Jump: after one
    // rejection in this turn, or late in the turn, skip the rest of
    // the rare list and go straight to the common bench, where the
    // certain answers are. If the bench is empty too, fall back to
    // whatever usable rare answers remain. Common-only play picks
    // from the bench alone.
    const elapsed = Date.now() - (state.turnStartAt || Date.now());
    const jump = state.rejectCount >= 1 || elapsed >= 9000;
    let candidate;
    if (settings.wordStyle === "common") {
      candidate = pickFromList("common", state.commonIdx, maxLen);
    } else {
      candidate = jump ? pickFromList("common", state.commonIdx, maxLen) : null;
      if (!candidate) candidate = pickFromList("rare", state.rareIdx, maxLen);
      if (!candidate) candidate = pickFromList("common", state.commonIdx, maxLen);
    }
    // Always type lowercase: no Shift keys, and the game's matching
    // is case-insensitive. The stored list keeps its spelling for
    // display and for readable refetch excludes.
    if (candidate) candidate = candidate.toLowerCase();
    if (!candidate) {
      setStatus("out of candidates");
      return;
    }
    // Variant-aware: the box may hold the game's autocorrected
    // spelling of this candidate (grey for gray), which still counts
    // as typed and submittable.
    if (norm(input.value) === norm(candidate)) {
      state.filledForUser = candidate;
      // A fresh block reason stays visible instead of being overwritten
      // by this status on the next tick.
      if (settings.mode === "auto" && state.enterDiag && Date.now() - state.enterDiagAt < 5000) {
        setStatus(state.enterDiag);
      } else {
        setStatus('typed "' + candidate + '" — press Enter');
      }
      // Backup for a lost auto-Enter timer: typing finished (done
      // handler) but no submit was attempted and no timer is pending,
      // e.g. a turn/phase flicker cancelled the timer after typing.
      // Only schedules once per round+candidate, and never while a
      // result is pending or a block reason is fresh.
      const attemptKey = state.roundKey + "|" + candidate;
      const blockedRecently = state.enterDiag && Date.now() - state.enterDiagAt < 5000;
      if (
        settings.mode === "auto" &&
        state.enterTimer === null &&
        !state.awaitingResult &&
        state.enterAttemptedFor !== attemptKey &&
        !blockedRecently
      ) {
        state.enterTimer = setTimeout(() => {
          submitPartyAnswer(input, candidate, state.roundKey);
        }, 400 + Math.random() * 500);
      }
      return;
    }
    if (input.value && !candidate.startsWith(input.value)) {
      // The box holds a spelling variant of this candidate's prefix
      // (the game's autocorrect): appending the suffix by raw length
      // would corrupt it, so clear and type the whole word fresh.
      if (norm(candidate).startsWith(norm(input.value)) && norm(input.value).length > 0) {
        fillInput(input, "");
      } else if (state.prevBoxText && norm(input.value) === norm(state.prevBoxText)) {
        // Leftover from the previous round: the game keeps the last
        // submitted answer in the box, and it is not this round's
        // candidate. Clear exactly that text once, then type. Anything
        // else in the box is the player's own text: never overwrite it.
        state.prevBoxText = null;
        fillInput(input, "");
      } else {
        setStatus("your text is in the box — not overwriting");
        return;
      }
    }
    setStatus('typing "' + candidate + '"…');
    startTyping(input, candidate, input.value);
  }

  function tick() {
    // Disabled: no fetching, typing, submitting, or auto-advance.
    // The overlay is hidden by render(); nothing else runs.
    if (!settings.enabled) return;
    maybeAutoAdvance();
    updateRatedLatch();

    const party = isParty();
    const prompt = currentPrompt();
    if (!prompt) {
      if (state.roundKey !== null) {
        // A prompt-free gap between categories must not wipe the
        // leftover's identity: identify and clear it here, before
        // the state below is cleared, or the next category treats
        // it as text the player typed.
        const live = partyInput();
        const own = state.wasMyTurn && live && isOwnLeftover(live.value);
        captureLeftover();
        cancelTyping();
        state.wasMyTurn = false;
        state.awaitingResult = null;
        state.enterDiag = null;
        state.roundKey = null;
        state.candidates = [];
        state.rare = [];
        state.common = [];
        if (own && live && live.value) fillInput(live, "");
        setStatus("waiting for a prompt");
      }
      return;
    }
    const countEl = $(".ds-prompt-count");
    const count = party ? partyRoundCount() : (countEl ? countEl.textContent.trim() : "");
    // The room is part of the identity: the same category number
    // and prompt in a different room is a new round and must reset
    // the lists, the rejection count, and the jump to the common
    // bench. (A replay under the same room code with an identical
    // first prompt still collides unless a prompt-free gap
    // intervenes and nulls the round key.)
    const key = location.pathname + "|" + count + "|" + prompt;
    if (key !== state.roundKey) resetRound(key, prompt);

    if (party) {
      partyTick();
      partyAutoTick();
      return;
    }

    const form = $("form.ds-dock");
    if (!form) return;

    if (settings.mode === "suggest") return;
    if (state.fetching || !state.candidates.length) return;

    const input = $(".ds-input", form);
    if (!input) return;
    const diveBtn = $(".ds-dive-btn", form);
    const inFlight = diveBtn && diveBtn.textContent.trim() === "…";
    if (inFlight) return;

    // Autocorrect suggestion: the game already replaced the input value; submit again to confirm.
    const corr = $(".ds-correction-panel");
    if (!corr) state.lastCorrection = null;
    if (corr) {
      const text = corr.textContent;
      if (state.lastCorrection !== text) {
        state.lastCorrection = text;
        const toEl = $(".ds-correction-change b", corr);
        const to = toEl ? toEl.textContent.replace(/[“”"]/g, "").trim() : input.value;
        setStatus("confirming correction → " + to);
        if (settings.mode === "auto") {
          state.lastSubmitted = input.value;
          state.submittedAt = Date.now();
          submitForm(form);
        }
      }
      return;
    }

    // Rejection: move to the next candidate (or resend on a network blip).
    const rej = $(".ds-reject");
    if (!rej) state.lastReject = null;
    if (rej) {
      const text = rej.textContent.trim();
      if (state.lastReject !== text) {
        state.lastReject = text;
        if (/^signal lost/i.test(text)) {
          state.lastSubmitted = null; // resend the same one
        } else {
          if (state.lastSubmitted) state.rejected.push(state.lastSubmitted);
          state.idx += 1;
          state.lastSubmitted = null;
          state.filledForUser = null;
        }
        render();
      }
    }

    // Waiting on the server for the answer we just sent.
    if (state.lastSubmitted && Date.now() - state.submittedAt < 8000) return;

    if (secondsLeft() <= 1) return;

    const candidate = state.candidates[state.idx];
    if (!candidate) {
      if (!state.refetched && secondsLeft() > 6) {
        state.refetched = true;
        fetchCandidates(state.prompt, state.rejected);
      } else {
        setStatus("out of candidates");
      }
      return;
    }

    if (settings.mode === "fill") {
      if (state.filledForUser !== candidate) {
        // Always type lowercase; the stored candidate keeps its
        // spelling for rejection tracking and refetch excludes.
        fillInput(input, candidate.toLowerCase());
        state.filledForUser = candidate;
        state.lastSubmitted = candidate; // so a rejection advances the list
        state.submittedAt = Date.now() + 1e9; // never auto-timeout in fill mode
        setStatus('filled "' + candidate + '" — press Enter');
      }
      return;
    }

    // auto mode
    fillInput(input, candidate.toLowerCase());
    state.lastSubmitted = candidate;
    state.submittedAt = Date.now();
    setStatus('submitting "' + candidate + '"');
    submitForm(form);
  }

  // ---------- wiring ----------
  // The content script only ever needs these settings. Read
  // exactly those keys: reading everything would load the API key
  // into this page's content-script context, which the worker's
  // comment promises never happens.
  const SETTING_KEYS = ["enabled", "mode", "wordStyle", "autoAdvance", "showOverlay"];
  function loadSettings() {
    chrome.storage.local.get(SETTING_KEYS, (s) => {
      if (s) {
        for (const k of SETTING_KEYS) if (k in s) settings[k] = s[k];
      }
      render();
    });
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    const wasMode = settings.mode;
    const wasEnabled = settings.enabled;
    for (const k of Object.keys(changes)) {
      if (k in settings) settings[k] = changes[k].newValue;
    }
    if (wasEnabled && !settings.enabled) {
      // Just disabled: stop everything in flight at once.
      cancelTyping();
      clearTimeout(state.advanceTimer);
      state.advanceTimer = null;
    }
    if (settings.mode !== wasMode) {
      // A pending auto-Enter must not fire after the user left auto
      // mode (attemptPartySubmit re-checks mode too); typing in
      // progress must stop if suggestions-only was chosen.
      if (settings.mode === "suggest") cancelTyping();
      else clearEnterTimer();
    }
    render();
  });

  // Enter submits in party games. Stop typing the moment it is pressed
  // so no keystroke lands after the submission, and remember what was
  // submitted until the result arrives. This listener only ever cancels
  // the extension's typing; it never prevents or handles the key itself.
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || !settings.enabled || !isParty()) return;
      const input = partyInput();
      if (!input || e.target !== input) return;
      cancelTyping();
      const text = input.value.trim();
      if (text) {
        state.awaitingResult = text;
        state.awaitingAt = Date.now();
      }
    },
    true,
  );

  loadSettings();
  ensureOverlay();
  setStatus("waiting for a prompt");

  // The game mutates the DOM constantly, and the observer below fires on
  // every batch of mutations. Without a floor, tick() — dozens of
  // document queries — runs up to once per animation frame and makes the
  // page (and the popup) feel sluggish. Coalesce to at most one tick per
  // 120ms; a trailing tick is always scheduled so no change is lost.
  // The extra latency is negligible next to the API call that follows.
  let lastTickAt = 0;
  let pendingTick = null;
  function safeTick() {
    const now = Date.now();
    if (now - lastTickAt < 120) {
      if (pendingTick === null) {
        pendingTick = setTimeout(() => {
          pendingTick = null;
          safeTick();
        }, 120 - (now - lastTickAt));
      }
      return;
    }
    lastTickAt = now;
    try {
      tick();
    } catch (e) {
      state.error = e.message;
      render();
    }
  }

  let scheduled = false;
  const obs = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      safeTick();
    });
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(safeTick, 300);
})();
