# Call / notification rework — open items

What's still open after the "popout-only calling, never leak the web UI" change and its
high-effort code review. Resolved items were removed (see git history); accepted-by-design
decisions moved to `CALLING.md`. Delete this file when both items below are closed.

## A2. Message-notification read / dismiss side-effects — needs a decision

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

## B2. `tag.includes('@')` is a loose JID test — deferred hardening

- **Where:** `src/bridge/impl/startup.ts` notification `click` handler.
- **Problem:** Distinguishes "tag is a chat WID" from "not a WID" by substring `@`. Safe on
  Linux/Electron (the bundle always sends `chat.id` here; the macOS `msg.id` branch — whose
  serialized form also contains `@` — never runs), so it is **not** currently wrong.
- **Fix:** tighten to a real suffix test, e.g. `/@(s\.whatsapp\.net|c\.us|g\.us|lid|broadcast|newsletter)$/.test(tag)`.
- **Why deferred:** changes nothing observable on the target platform; pure hardening against
  a hypothetical future bundle/platform change.

## Verification reminder

The behavioral paths can only be confirmed on a real machine with a logged-in account and a
second phone: outgoing, live incoming (accept/decline in popout), stale incoming (toast →
chat), and message-notification click (correct contact). Watch `[wwine-call]` logs via
`WA_BRIDGE_DEBUG=1 npm start`.
