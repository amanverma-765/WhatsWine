# Call / notification rework — unfixed problems

Tracks everything left open after the "popout-only calling, never leak the web UI"
change and its high-effort code review. Scope: `src/callView.ts`, `src/window.ts`,
`src/bridge/impl/voip.ts`, `src/bridge/impl/startup.ts`, `src/main.ts`.

Status legend: **DECISION** = needs a product/behavior call before fixing ·
**DEFERRED** = mechanical, no decision, skipped as low-value churn ·
**ACCEPTED** = deliberate design choice, recorded so it isn't mistaken for an oversight.

---

## A. Needs a decision (1)

### ~~A1. Silent unanswerable call when WA modules drift~~ — DONE (watchdog added)
`CALL_OBSERVER_JS` now counts ticks where a call is active but not in (or opening) the
popout; after ~4s (8 ticks) it emits a `[wwine-call-watchdog]` console marker once per
call, and the main process's `console-message` listener turns it into `notifyCallFailed()`.
Covers the silent-no-op and incoming-call cases `startCallJs`'s module check missed.

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

### ~~A3. Window auto-raises on every incoming-call toast (incl. stale)~~ — DONE
The bare `showMainWindow()` after `n.show()` is removed; the window raises only on toast
click, so a stale offer replayed at app start can't steal focus.

---

## B. Deferred cleanup — no decision, skipped as low-value churn (1)

### ~~B1. `mod()` require-wrapper duplicated across injected scripts~~ — DONE
Hoisted as `MOD_JS` in `src/waConfig.ts`, interpolated into every injected script
(`callView.ts` ×4, `callOnboarding.ts` `STATUS_JS`, `window.ts` `openChatInHybrid`).

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
