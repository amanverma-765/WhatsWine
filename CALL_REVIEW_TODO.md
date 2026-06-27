# Call / notification rework — unfixed problems

Tracks everything left open after the "popout-only calling, never leak the web UI"
change and its high-effort code review. Scope: `src/callView.ts`, `src/window.ts`,
`src/bridge/impl/voip.ts`, `src/bridge/impl/startup.ts`, `src/main.ts`.

Status legend: **DECISION** = needs a product/behavior call before fixing ·
**DEFERRED** = mechanical, no decision, skipped as low-value churn ·
**ACCEPTED** = deliberate design choice, recorded so it isn't mistaken for an oversight.

---

## A. Needs a decision (3)

### A1. Silent unanswerable call when WA modules drift  — *highest impact*
- **Where:** `src/callView.ts` `CALL_OBSERVER_JS` (the 500ms observer); `placeCall`.
- **Problem:** The popout is opened only by `WAWebVoipUiManager.openVoipUiPopoutWindow()`.
  If that module name drifts (WA bundle update) or never loads, an **active call**
  (outgoing or live incoming) stays alive in the hidden call layer with **no popout and
  no feedback** — the peer may hear ringing, the user sees nothing. `startCallJs` now
  resolves on `!!mod('WAWebVoipUiManager')`, which catches the *missing-module* case for
  outgoing calls, but **not** the case where the module exists yet `openVoipUiPopoutWindow`
  silently no-ops, and **not** incoming calls at all (they never go through `placeCall`).
- **Fix (≈5 lines):** add a watchdog inside the observer — if `activeCall` is present but
  not in the popout (and not `opening`) for ~4s (≈8 ticks), fire `notifyCallFailed()` once
  and `console.warn`, then latch so it doesn't spam. Requires surfacing a callback from the
  injected JS to the main process (e.g. set a `title`/console marker the main process polls,
  or reuse the existing `did-create-window` / console bridge already wired under
  `WA_CALL_DIAG`).
- **Decision:** today's silent-degrade is the deliberate "never surface the web UI" choice;
  a native toast is the only non-web feedback path. **Recommend: add the watchdog** — a
  silent unanswerable call is the worst failure mode.

### A2. Message-notification read / dismiss side-effects
- **Where:** `src/bridge/impl/startup.ts` notification `click` handler.
- **Problem:** For tags containing `@` (always, on Linux) the handler now calls
  `openChatInHybrid(tag)` and **skips** the bundle's
  `messageNotificationAction({action:'open'})` ToWeb call. That round-trip was WA's signal
  to mark the chat handled — potentially marking read and dismissing the same notification
  on **other linked devices**. Opening the chat *does* mark messages read on focus (which
  drives cross-device clearing), so the effect is **probably** preserved, but unverified.
- **Fix:** either (a) trust open-chat (current — opening the chat marks read), or
  (b) belt-and-suspenders: fire `messageNotificationAction` **and** `openChatInHybrid`.
  Option (b) risks a double-navigate (both target the hybrid bundle).
- **Decision:** **Recommend (a)** — keep current; only revisit if a notification is observed
  lingering on another device after the chat is opened here.

### A3. Window auto-raises on every incoming-call toast (incl. stale)
- **Where:** `src/bridge/impl/voip.ts` `showIncomingCallToast` — the bare `showMainWindow()`
  after `n.show()` (separate from the one in the click handler).
- **Problem:** The main window jumps to the foreground whenever an incoming-call toast is
  shown — including a **stale** missed-call offer replayed when the app opens late. May be
  intentional (bring app forward when called) or unwanted (window steals focus for a call
  that already ended).
- **Fix:** delete the bare `showMainWindow()` so the window only raises on toast **click**
  (−1 line). Keep it if foreground-on-incoming is desired.
- **Decision:** **Recommend: raise only on click** (delete the bare call).

---

## B. Deferred cleanup — no decision, skipped as low-value churn (2)

### B1. `mod()` require-wrapper duplicated across injected scripts
- **Where:** `src/window.ts` (`openChatInHybrid`), `src/callView.ts`
  (`CALL_SHIMS_JS`, `CALL_DIAG_JS`, `startCallJs`, `CALL_OBSERVER_JS`).
- **Problem:** `const mod = (n) => { try { return req(n); } catch (e) { return null; } }`
  is hand-inlined ~5×. (The guard+popout merge already removed one copy.)
- **Fix:** hoist one `const MOD_JS = "const mod=(n)=>{try{return req(n)}catch(e){return null}};"`
  string and prepend it in each injected script. ≈ −8 lines.
- **Why deferred:** spreads a shared string across two files and rewrites **pre-existing**
  scripts (`CALL_SHIMS_JS`, `CALL_DIAG_JS`) outside this change's intent. Low value vs churn.
  Do it only if these scripts get reworked anyway.

### B2. `tag.includes('@')` is a loose JID test
- **Where:** `src/bridge/impl/startup.ts` notification `click` handler.
- **Problem:** Distinguishes "tag is a chat WID" from "not a WID" by substring `@`. Safe on
  Linux/Electron (the bundle always sends `chat.id` here; the macOS `msg.id` branch — whose
  serialized form also contains `@` — never runs), so it is **not** currently wrong.
- **Fix:** tighten to a real suffix test, e.g. `/@(s\.whatsapp\.net|c\.us|g\.us|lid|broadcast|newsletter)$/.test(tag)`.
- **Why deferred:** changes nothing observable on the target platform; pure hardening against
  a hypothetical future bundle/platform change.

---

## C. Accepted by design — recorded, not bugs (for reviewer context)

These were flagged by the review's removed-behavior auditor but are the **intended**
consequences of "calls live only in WhatsApp's own popout, never the web layer."

- **C1. Group calls toast instead of connecting.** `VoipBridge.startGroupCall` has no
  dialable hand-off and must not surface the web layer, so it calls `notifyCallFailed()`.
  Group calling is not supported in this port (documented in `PORTING.md` "Known hard edges").
- **C2. No tray "Calling" fallback.** The tray entry that manually showed the web call layer
  was removed. If the popout mechanism breaks there is intentionally no web-UI escape hatch
  (that's the whole point of the change). A1's watchdog is the substitute feedback.
- **C3. Incoming relies on the call-layer device ringing.** Live incoming works because the
  call layer is a separate linked device that rings on its own and `CALL_OBSERVER_JS` pops it
  out. If that device is logged out/cold, incoming falls through to the stale path
  (toast → open chat) — no web leak, just no auto-popout.
- **C4. Indefinite 500ms polling.** `CALL_OBSERVER_JS` polls forever in the warm-but-hidden
  call view. Negligible CPU; matches the project's existing injected-observer pattern. The
  upgrade path (subscribe to `WAWebCallCollection` change events) is noted in the source.
- **C5. `CALL_OBSERVER_JS` injected on `did-finish-load`.** Theoretically a call arriving
  before the call view's first load would miss the observer; not reachable in practice — the
  view loads at app startup, long before any call, and the `__wwineCallObserver` guard makes
  re-injection idempotent.

---

## Verification reminder (all of the above)
The behavioral paths can only be confirmed on a real machine with a logged-in account and a
second phone: outgoing, live incoming (accept/decline in popout), stale incoming (toast →
chat), and message-notification click (correct contact). Watch `[wwine-call]` logs via
`WA_BRIDGE_DEBUG=1 npm start`.
