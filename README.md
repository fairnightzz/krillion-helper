# Krillion Helper

Chrome extension that suggests and fills answers on krillion.io using your own API key.

## Install (unpacked)

1. Open chrome://extensions
2. Turn on Developer mode (top right).
3. Click Load unpacked and pick this folder.
4. Click the extension icon, paste your API key (sk-ant-...), click Test key, then Save.
5. Open krillion.io and start a dive.

## Settings

| Setting | Default | Notes |
|---|---|---|
| Model | Opus 5.5 | Sonnet 5.5 / Haiku 4.5 are faster and cheaper. |
| Effort | low | Higher effort is slower. The answer window is 25 s. |
| Mode | auto | One control for solo and party: auto (fill + submit) / fill (you press Enter) / suggest (overlay only). |
| Word choice | Rare first | Rare first with a common bench, or Common only (safe bench / all-common answers). Words are always typed in lowercase. |
| Auto-click descend | off | Clicks DESCEND about 2.5 s after each result. |
| Overlay | on | Status and candidates panel, bottom-left. |

Settings save automatically when you change them (the API key also saves as you type); Save writes them immediately too. The popup shows saved settings immediately from a local copy (the API key is not in that copy and waits for the storage read), then refreshes them from `chrome.storage.local`, which stays the source of truth.

## Puffer Party

In Puffer Party tables, rated and casual alike, the helper types the rarest unused candidate when it is your turn. Mode decides submitting, same as in the solo dive: "auto" submits, "fill" leaves it for you to press Enter, and "suggest" turns the typing off (click a candidate to copy it). Rated (Elo) tables are detected from the game's own RATED label, not from Elo numbers, and shown with a "rated" badge on the overlay. The game leaves the last submitted answer in the box into the next category; the helper clears exactly that leftover once, while text you typed yourself is never overwritten. An answer counts as used the moment it is submitted (that entry is crossed even if the game shows a different corrected form), and shown answers — accepted or rejected, by any player — cross the matching list entries after only lowercasing, accent-folding, and stripping spaces and punctuation.

In Mode "auto", it submits once after a short, jittered pause and only if the box still holds exactly that candidate on your turn, by clicking the dock's "Send answer" button (falling back to an Enter keydown if the button is absent). If the attempt is blocked, the overlay says why. Pressing Enter yourself first cancels the pending auto-submit, so it never submits twice. Model replies are parsed defensively: preambles, numbering, markdown, and explanations are stripped, commentary lines are dropped instead of typed, and candidate names are capped at six words.

The typing is human-like in pacing, not in provenance: it types one keystroke at a time with inconsistent, unquantized delays, word-boundary pauses, occasional pauses and a rare typo + backspace correction, and it stops the moment the turn passes, the answer is already said, or you edit the box. It still uses synthetic input events — a content script cannot produce trusted keystrokes — so the game's input telemetry will still count them as synthetic. What is human-like is what other players and the game's typing stream see: the answer appearing gradually, not pasted whole.

## Tests

`node --test tests/*.test.js` — covers the typing planner, the cancellable typer, the party refetch prompt, and popup loading/saving. No dependencies.
