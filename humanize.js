// Human-like typing for rated Puffer Party: per-character plans with
// inconsistent pacing, plus a cancellable typer that applies them through
// the same native-setter + input-event path React listens to.
//
// Delays are continuous floats, never rounded to a grid: perfectly regular
// timing is exactly what looks automated. The planner is pure (seedable RNG)
// so its behaviour can be tested without a DOM.

function createSeededRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

function typoChar(correct, rng) {
  const upper = correct >= "A" && correct <= "Z";
  let wrong = correct;
  while (wrong === correct) {
    const c = LETTERS[Math.floor(rng() * LETTERS.length)];
    wrong = upper ? c.toUpperCase() : c;
  }
  return wrong;
}

// One step per keystroke. step.value is the whole input value after the
// step, so applying steps in order reproduces `text` exactly, including
// the backspace that undoes a typo.
function planTyping(text, rng, opts) {
  const random = rng || Math.random;
  const options = opts || {};
  const allowTypos = options.allowTypos !== false;
  const typoProbability = options.typoProbability == null ? 0.35 : options.typoProbability;
  const chars = [...(text || "")];
  if (!chars.length) return [];

  const base = 62 + random() * 48; // per-answer pace, 62-110ms
  let typoPos = -1;
  if (allowTypos && chars.length >= 5 && random() < typoProbability) {
    const spots = [];
    for (let i = 2; i < chars.length - 1; i += 1) {
      // A typo replaces the character with a random letter, so it
      // can only land on a letter: digits and punctuation would
      // otherwise turn into implausible letters.
      if (/[A-Za-z]/.test(chars[i])) spots.push(i);
    }
    if (spots.length) typoPos = spots[Math.floor(random() * spots.length)];
  }
  const wrongChar = typoPos >= 0 ? typoChar(chars[typoPos], random) : null;

  const steps = [];
  let pace = base;
  let leftInSegment = 0;
  let prefix = "";
  for (let i = 0; i < chars.length; i += 1) {
    if (leftInSegment <= 0) {
      leftInSegment = 4 + Math.floor(random() * 4);
      pace = base * (0.85 + random() * 0.3); // bursts and lulls
    }
    leftInSegment -= 1;

    let delay;
    if (i === 0) {
      delay = 180 + random() * 270; // reading / deciding before starting
    } else if (chars[i] === " ") {
      delay = pace * (1.5 + random() * 1.5); // word-boundary pause
    } else {
      delay = pace * (0.55 + random() * 0.95);
      if (random() < 0.06) delay *= 2.0 + random() * 1.6; // occasional think pause
    }

    if (i === typoPos) {
      prefix += wrongChar;
      steps.push({ op: "type", ch: wrongChar, value: prefix, delay: Math.min(850, Math.max(38, delay)) });
      prefix = chars.slice(0, typoPos).join("");
      steps.push({ op: "backspace", value: prefix, delay: 90 + random() * 130 }); // noticing it
      prefix += chars[i];
      steps.push({ op: "type", ch: chars[i], value: prefix, delay: 60 + random() * 80 });
      continue;
    }
    prefix += chars[i];
    steps.push({ op: "type", ch: chars[i], value: prefix, delay: Math.min(850, Math.max(38, delay)) });
  }
  return steps;
}

function defaultApply(value, step, input) {
  if (!input) return;
  let setter = null;
  try {
    const desc =
      typeof HTMLInputElement !== "undefined"
        ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        : null;
    setter = desc ? desc.set : null;
  } catch (_) {
    setter = null;
  }
  if (setter) setter.call(input, value);
  else input.value = value;
  // React's onChange fires from the input event. Send a shaped InputEvent
  // (single-char data, insertText / deleteContentBackward) like a real
  // keystroke produces, instead of a bare Event. These are still synthetic
  // events (isTrusted is false); only the pacing and shape are human-like.
  let evt = null;
  try {
    evt =
      typeof InputEvent !== "undefined"
        ? new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            data: step.op === "backspace" ? null : step.ch != null ? step.ch : null,
            inputType: step.op === "backspace" ? "deleteContentBackward" : "insertText",
          })
        : null;
  } catch (_) {
    evt = null;
  }
  input.dispatchEvent(evt || new Event("input", { bubbles: true }));
}

// Types `text` into `input` step by step. opts:
//  rng, steps (override the plan), timers ({setTimeout, clearTimeout}),
//  apply(value, step, input), shouldContinue(prefix, index) -> bool,
//  initialValue (value already in the box when typing starts).
// Returns { cancel(), done } where done resolves true only if every step
// was applied. The caller owns abort policy via shouldContinue; the
// typer never touches the input after a veto.
function typeHumanlike(input, text, opts) {
  const options = opts || {};
  // Never call the real timer builtins as methods of a plain object: in
  // Chrome that throws "Illegal invocation" (the receiver must be the
  // global). Call them on globalThis, or the caller's clock object.
  const clock = options.timers;
  const schedule = clock
    ? (fn, ms) => clock.setTimeout(fn, ms)
    : (fn, ms) => globalThis.setTimeout(fn, ms);
  const unschedule = clock
    ? (id) => clock.clearTimeout(id)
    : (id) => globalThis.clearTimeout(id);
  const apply = options.apply || defaultApply;
  const steps = options.steps || planTyping(text, options.rng, options.plan);
  const shouldContinue = options.shouldContinue;

  let cancelled = false;
  let timer = null;
  let settled = false;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  function finish(ok) {
    if (settled) return;
    settled = true;
    if (timer !== null) unschedule(timer);
    resolveDone(ok);
  }
  function run(i, prefix) {
    if (cancelled || i >= steps.length) return finish(!cancelled && i >= steps.length);
    if (shouldContinue && !shouldContinue(prefix, i)) return finish(false);
    timer = schedule(() => {
      timer = null;
      try {
        if (cancelled) return finish(false);
        if (shouldContinue && !shouldContinue(prefix, i)) return finish(false);
        apply(steps[i].value, steps[i], input);
        run(i + 1, steps[i].value);
      } catch (_) {
        // A throwing step must settle done as failed, not wedge it
        // pending forever with no timer left to rescue it.
        return finish(false);
      }
    }, steps[i].delay);
  }
  if (!input && !options.apply) {
    finish(false);
  } else {
    // initialValue is the value already in the box (e.g. a prefix typed
    // before an interruption); shouldContinue is checked against it.
    try {
      run(0, options.initialValue || "");
    } catch (_) {
      finish(false);
    }
  }
  return {
    cancel() {
      cancelled = true;
      if (timer !== null) unschedule(timer);
      finish(false);
    },
    done,
  };
}

const KchHumanize = { createSeededRng, planTyping, typeHumanlike };
if (typeof globalThis !== "undefined") globalThis.KchHumanize = KchHumanize;
