# 42. Notifications & Push

> Target: Meta native **WhatsApp for Windows** (`WhatsApp.Root.exe`, WinUI 3 / Windows App SDK 1.6, v2.2607.106.0).
> All `path:LINE` citations are **relative to `decompiled_source/`** and were read directly from the decompiled C# / `x64/AppxManifest.xml`.
> "Confirmed" = read in code. "Inferred" = deduced, not directly visible. This subsystem is essentially pure C#/WinRT, so there is virtually no native body to recover here regardless of tooling — note that the native binaries elsewhere *are* readable (the crypto core was statically disassembled with radare2, doc 96), so the absence of native artifacts below reflects this subsystem's design, not a tooling gap.

---

## 1. Purpose & Scope

This document covers the **native notification & push surface** of the hybrid app — everything that turns a server-side "wake up / show this" into a Windows toast, taskbar badge, or web-client resume. It is the OS-integration counterpart to the message/receipt logic, which lives in the WhatsApp Web JS bundle.

In scope, confirmed in code:

1. **WNS push channel lifecycle** — creating a `PushNotificationChannelManager` channel (with retry), forwarding the channel URI to the JS client as a `WnsToken`, the token-acknowledgement handshake, and channel-revocation refresh (`WebLifecycleController`, `WnsToken`, `PushRegistration`).
2. **The push→suspend/resume gate** — how an acknowledged WNS token is the *precondition* for ever suspending the web client, and how an inbound raw push force-resumes it (`WebLifecycleController`).
3. **The out-of-process push background task** — a WNS-raw-push-triggered COM server (`PushNotificationBackgroundTask`, CLSID `082f08a8…`) that wakes the packaged app even when the main window is gone, plumbed through an unbounded channel to the "you may have new messages" throttled toast (`ComServer`, `BackgroundTaskHelper`, `MayHaveMessagesNotificationManager`, `App.cs`).
4. **Message toasts** — `AppNotificationManager` (Windows App SDK) toasts with circle-cropped avatar, quick-reply text box, context-menu items, and custom tones (`NotificationsManager`, `MessageNotification`, `CustomTones`).
5. **VoIP call toasts** — legacy `ToastNotificationManager` incoming-call toasts with looping ringtone, Accept/Decline/Settings, group-call-link reminders (`VoipToastController`).
6. **Toast activation routing** — the `bebd6a5e…` toast-activator COM CLSID, `ToastLaunchArgs` (the `action=…&key=…` query encoder/parser), `NotificationActionEnum`, and how clicks/quick-replies/context-menu/call-link actions are dispatched back into the JS bundle or into the VoIP engine (`ToastLaunchArgs`, `NotificationsManager.HandleNotificationActivation`, `App.cs`, `Program.cs`).
7. **Taskbar / tray badges** — numeric app-badge updates and the per-app-state suppression rules (`TaskbarManager`, `SystemIntegrationsManager`).
8. **Settings gating** — `WhenShowNotificationBanner` / `WhenShowTaskbarBadge` / call-mute facades and the background-task enable switch (`WebPreferencesProvider`, `SystemIntegrationsManager`, `BackgroundTaskHelper`).

**Out of scope** (sibling docs): the actual message decode/receipt logic (JS bundle), the noise/Smax protocol, VoIP engine internals, the broader WebView2 bridge plumbing (doc 31), packaging/activation generalities (doc 01) — referenced here only where they cross into notifications.

---

## 2. Where It Lives

All paths below are under `decompiled/WhatsApp.Root/` unless noted.

### Push (WNS) plumbing
| Concern | File |
|---|---|
| WNS channel create/retry, token→JS, ack handshake, suspend/resume gate, raw-push force-resume | `WhatsApp.Bridge/WebLifecycleController.cs` |
| Projected `WnsToken` value type (`{Data, Channel}`) marshalled across the bridge | `WinRTAdapter/WnsToken.cs`, `WinRTAdapter/IWnsTokenStatics.cs` |
| Bridge interfaces JS↔native (`ConnectionBridge`/Lifecycle) | `WinRTAdapter/ILifecycleBridgeToNative.cs`, `WinRTAdapter/ILifecycleBridgeToWeb.cs` |
| **Legacy / dead** WNS channel helper (no callers) | `WhatsApp.Notifications/PushRegistration.cs` |

### Push background task (out-of-proc COM)
| Concern | File |
|---|---|
| `IBackgroundTask` impl, CLSID `082f08a8…`, channel-fan-out of a `Unit` per push | `WhatsApp.Background/PushNotificationBackgroundTask.cs` |
| `IClassFactory` + `CoRegisterClassObject`/`CoRevokeObject` P/Invokes | `WhatsApp.Background/ComServer.cs` |
| `PushNotificationTrigger` registration / unregistration, `RequestAccessAsync` | `WhatsApp.SystemIntegrations/BackgroundTaskHelper.cs` |
| Throttled "may have new messages" toast + last-shown persistence | `WhatsApp.SystemIntegrations/MayHaveMessagesNotificationManager.cs`, `WhatsApp.SystemIntegrations/AppSettingBasedPushNotificationHandlerStorage.cs` |

### Message / file toasts (Windows App SDK `AppNotificationManager`)
| Concern | File |
|---|---|
| Toast build (avatar/quick-reply/context-menu/tone), activation dispatch, close/cancel, file-saved toasts | `WhatsApp.SystemIntegrations/NotificationsManager.cs` |
| DTOs | `WhatsApp.SystemIntegrations/MessageNotification.cs`, `MessageNotificationContextMenuItem.cs` |
| Tone catalogue (`Sounds/…m4a/.wma`) | `WhatsApp.SystemIntegrations/CustomTones.cs`, `Tone.cs` |

### VoIP toasts (legacy `Windows.UI.Notifications.ToastNotificationManager`)
| Concern | File |
|---|---|
| Incoming-call toast, ringtone loop, group-call-link reminder, no-device error toast | `WhatsApp.Notifications/VoipToastController.cs` |

### Activation / launch-arg encoding
| Concern | File |
|---|---|
| `action=…&key=…&tag=…` encoder + parser | `WhatsApp.SystemIntegrations/ToastLaunchArgs.cs` |
| Action enum | `WhatsApp.SystemIntegrations/NotificationActionEnum.cs` |
| App-launch/restore metrics consumed on toast click | `WhatsApp.SystemIntegrations/AppLaunchMetricsRecorder.cs` |

### Taskbar badge / settings gate / wiring
| Concern | File |
|---|---|
| Numeric taskbar badge via `BadgeUpdateManager` | `WhatsApp.SystemIntegrations/TaskbarManager.cs` |
| Banner/badge/mute settings facades | `WhatsApp.SystemIntegrations/WebPreferencesProvider.cs` |
| `ISystemIntegrationsBridgeToNative` impl — JS calls `ShowMessageNotification`/`UpdateTaskbarBadge`/…; gates on settings; dispatches toast actions back to JS | `WhatsApp.SystemIntegrations/SystemIntegrationsManager.cs` |
| App bootstrap: registers push BG task, subscribes to push channel, wires toast activation, registers `ConnectionBridge`/`SystemIntegrationsBridge` | `WhatsApp/App.cs`, `WhatsApp/AppModel.cs`, `WhatsApp.Design/ViewsController.cs` |
| STA entry, single-instance, `/pushnotification` no-redirect | `WhatsApp/Program.cs` |
| Manifest: toast-activator CLSID, push BG-task COM server, capabilities | `x64/AppxManifest.xml` |

---

## 3. How It Works

### 3.0 Two notification stacks coexist

The app uses **two distinct Windows notification APIs** at once:

- **Windows App SDK** `Microsoft.Windows.AppNotifications.AppNotificationManager` — used for **message** toasts and **file-downloaded** toasts (`NotificationsManager.cs:9,25,48`). Built with `Microsoft.Toolkit.Uwp.Notifications.ToastContent` XML (`NotificationsManager.cs:6,56`).
- **Legacy UWP** `Windows.UI.Notifications.ToastNotificationManager` — used for **VoIP** call toasts (`VoipToastController.cs:9,37`), the **"may have messages"** toast (`MayHaveMessagesNotificationManager.cs:3,68`), and **scheduled** notification cancellation in `NotificationsManager` (`ToastNotifierCompat`, `NotificationsManager.cs:37,99`).

Both ultimately resolve to the same activator COM CLSID (`bebd6a5e…`) declared once in the manifest (`x64/AppxManifest.xml:100-102`).

---

### 3.1 WNS push channel: create → forward token → ack → gate suspend

The center of push is **`WebLifecycleController`** (`WhatsApp.Bridge/WebLifecycleController.cs`), which is registered with the WebView2 as the host object **`ConnectionBridge`** (`App.cs:315`: `webView.AddWinRTBridge("ConnectionBridge", new LifecycleBridge(_webLifecycle))`). It implements `ILifecycleBridgeToNative` (`WebLifecycleController.cs:16`).

**Channel constant:** the WNS channel name string is hard-coded `"uwp_public"` (`WebLifecycleController.cs:18`).

**Warmup / channel creation** (`WebLifecycleController.cs:239-250`): `Warmup()` (called from `App.StartModel` at `App.cs:194`) subscribes to `PushNotificationChannelManager.ChannelsRevoked` (guarded by `OperatingSystem.IsWindowsVersionAtLeast(10,0,19041)`) and triggers `RefreshChannelSource`.

`DoRefreshChannelSource()` (`WebLifecycleController.cs:178-196`):
1. `CreatePushNotificationChannelWithRetryAsync(5, 5000)` — **5 attempts, 5000 ms apart** (`WebLifecycleController.cs:181,207-237`). Each attempt calls `PushNotificationChannelManager.CreatePushNotificationChannelForApplicationAsync()` (`:224`). On exhaustion it logs via `FailuresService.Investigate(...)` (`:234`).
2. Stores `_pushNotificationChannel` and subscribes `PushNotificationReceived += OnPushNotification` (`:187-188`).
3. If the channel URI differs from `_wnsToken`, it caches it and **pushes it to JS**: `_webClient?.UpdateNotificationsToken(WnsToken.Create(_wnsToken, "uwp_public"))` (`:189-193`).

**`WnsToken`** is a CsWinRT-projected runtime class `WinRTAdapter.WnsToken` with `{ string Data, string Channel }` and a static `Create(data, channel)` factory (`WnsToken.cs:66-78`; statics IID `975B9383-…`, `IWnsTokenStatics.cs`). It is delivered to JS through `ILifecycleBridgeToWeb.UpdateNotificationsToken(WnsToken token)` (`ILifecycleBridgeToWeb.cs:13`; ABI marshalling `ABI.WinRTAdapter/ILifecycleBridgeToWeb.cs:25-29`). The JS client listens for this as the `updateNotificationsTokenEvent` bridge event and **registers the WNS URI with the server** via a push IQ. The full bundle path (round-2 beautified bundle):

- The bridge handler is `WindowsHybridBridgeConnection` (`U2j2EhR17gV.js:753`): on `updateNotificationsTokenEvent` it `await`s main-stream-ready, then calls `WAWebSetWindowsPushConfig.setWindowsPushConfig(tokenData, channel)`, `handleConnectionState(true)`, and finally `acknowledgeNotificationsToken(tokenData, channel)` — the exact JS counterpart of the native ack handshake (`WebLifecycleController.cs:283-289`).
- `setWindowsPushConfig` (`TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js:184790-184838`) builds `iq{ to=S_WHATSAPP_NET, type=set, xmlns="urn:xmpp:whatsapp:push" } > config{ id:<channelUri>, platform:"wns", version:m(channel) }` and sends it via `WADeprecatedSendIq.deprecatedSendIq`. The `version` attribute is the channel-name mapping `m()` (`:184836`): `uwp_public ⇒ DROP_ATTR` (no version attr), while `uwp_beta`/`uwp_alpha`/`uwp_hybrid_dogfooding` pass through as-is, default `uwp_beta` (channel param defaults to `"uwp_beta"` at `:184811`). **Note:** the native side mints the channel with the hard-coded name `"uwp_public"` (`WebLifecycleController.cs:18`), so in this build the `version` attr is dropped and the registration is `config{ id, platform:"wns" }` with no `version`.
- The Smax-typed equivalent builder is `WASmaxOutPushConfigWNSClientMixin.mergeWNSClientMixin` (`SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:111273-111290`) — one entry in a six-platform push-config mixin group `{androidClient, appleClient, enterpriseClient, fBClient, wNSClient, webClient}` (`:111315-111325`), wrapped by `WASmaxOutPushConfigSetRequest.makeSetRequest` (`:111363-111372`). The same six platforms appear in the open protocol: whatsmeow's `push.go` defines `FCMPushConfig` (`platform:"gcm"`), `APNsPushConfig` (`platform:"apple"`), and `WebPushConfig` (`platform:"web"`) over the identical `urn:xmpp:whatsapp:push` namespace (cross-reference: `whatsmeow/push.go:19-108`).

The server-side registration is thus in the JS bundle, not native; the native side only mints the channel and hands JS the token.

**Subscribe / re-send on (re)connect** (`WebLifecycleController.cs:291-300`): when JS calls `Subscribe(ILifecycleBridgeToWeb web)`, the controller stores `_webClient` and, if a token already exists, immediately re-sends it via `UpdateNotificationsToken`.

**The acknowledgement handshake** — JS calls back `AcknowledgeNotificationsToken(tokenData, channel)` (`ILifecycleBridgeToNative.cs:15`; impl `WebLifecycleController.cs:283-289`) to confirm it has successfully registered the token server-side. The controller records `_acknowledgedToken` / `_acknowledgedChannel`.

**`IsSuspendAllowed()`** (`WebLifecycleController.cs:302-309`) is the crux:
```
IsSuspendingEnabled && _wnsToken != null && _wnsToken == _acknowledgedToken && _acknowledgedChannel == "uwp_public"
```
i.e. the web client may be suspended **only after** the server has been given a WNS token *and JS has confirmed it*. This guarantees the server can wake the app via push before the app stops its own connection. If suspend is *not* allowed and there is no token yet, `DoUpdateWebState` re-kicks `RefreshChannelSource` (`:133-135`).

> **`PushRegistration.cs` is a dead/legacy path.** It also calls `PushNotificationChannelManager.CreatePushNotificationChannelForApplicationAsync()` (`PushRegistration.cs:37`) and sets `Settings.Instance.WnsRegistered = true` (`:27`), but a repo-wide grep finds **no callers** of any of its members (`PushRegistration.` type ref, `UriObservable`, `RequestNewUri`, `OnPushRegistered` — only self-references). The one settings key it writes, `WnsRegistered` (`Settings.cs:60` slot 81, accessor `Settings.cs:261-269`), is **read by nothing** — it appears only as its own definition plus that single write. Since CsWinRT activation is non-reflective, the static class is genuinely unreachable. The live channel path is entirely `WebLifecycleController`.

---

### 3.2 Suspend / resume state machine (push as keep-alive)

`WebLifecycleController` runs all mutations on a single `ConcurrentQueueDispatcher` (`:20`) and memoizes three time-dependent tasks: `_updateWebState`, `_forceResumeWeb`, `_refreshChannelSource` (`:46-50, 91-93`).

**Visibility input.** `App` subscribes window-tray transitions and calls `ApplyAppState(main, voip)` (`App.cs:130-134`; `WebLifecycleController.cs:96-101`), where `NativeState = (VisibilityState)Math.Max((int)main, (int)voip)` (`:99`). The enum is `VisibilityState { None=0, SystemTray=1, Minimized=2, Visible=3, Focused=4 }` (`WhatsApp.Bridge/VisibilityState.cs:3-10`), so `Math.Max` selects the **more-visible / less-suspendable** of the main and VoIP window states — a focused VoIP window keeps the app awake even when the main window is in the tray. Only `NativeState == SystemTray` (numeric `1`) is treated as "minimised to tray" for suspend (`isMinimisedToTray`, `:106`), is the sole state where `IsThrottleAllowed()` is true (`:311-318`), and `GetMemoryLimit()` returns its 500 MB cap only at `Minimized` (`:320-327`).

**`DoUpdateWebState(forceResume)`** (`:103-138`):
- Adjusts WebView memory target: `RestoreMemoryUsageTargetLevel()` unless minimised-to-tray, else `LowerMemoryUsageTargetLevel()` (`:107-117`).
- If `IsSuspendAllowed()`:
  - `forceResume || !minimisedToTray` → `TryResume()`; else `TrySuspend()` (`:122-131`).
- Else (no acked token) and `_wnsToken == null` → kick `RefreshChannelSource` (`:133-135`).

**`TrySuspend()`** (`:140-153`): if connected, `_webClient.Disconnect()`; else if not `Visible`, `_webView.StartSuspending()`. **`TryResume()`** (`:155-169`): `_webView.Resume()`, then if not connected `_webClient.Connect()`, set `_isResuming`, wait **30 s**, clear it, re-update. `Disconnect()`/`Connect()` are JS-side callbacks (`ILifecycleBridgeToWeb.cs:15-16`) — the native side asks JS to drop/raise the socket.

**Force-resume triggers:** OS session unlock (`App.onSessionSwitch` → `ForceResume`, `App.cs:167-173`), power resume (`App.PowerResumeHandler`, `App.cs:348-351`), activation by toast/protocol/share (`App.OnActivated`, `App.cs:562-565`), and **any inbound raw push** (next section).

---

### 3.3 In-process raw push: force-resume + unhandled-push subject

When the app *is* running, the WNS channel raises `OnPushNotification` (`WebLifecycleController.cs:198-205`):
```csharp
private void OnPushNotification(PushNotificationChannel sender, PushNotificationReceivedEventArgs args) {
    if (_webClient == null)
        _unhandledPushNotificationSubject.OnNext(args.RawNotification);
    ForceResume();
}
```
So every raw push **force-resumes** the web client (`ForceResume` → `_forceResumeWeb` → `DoUpdateWebState(forceResume:true)`, `:252-259`). If no web client is attached yet, the raw notification is buffered on `WhenUnhandledPushNotificationReceived` (`:84`). **Inference:** the actual message fetch ("there are new messages, go get them") happens in JS once resumed — native does not parse the push payload here; it only nudges the web client awake.

**Wake-ping model corroborated by live data + cross-reference (final pass).** Three independent lines of evidence now back the "WNS push is a pure wake-ping, content arrives over the resumed socket" claim:
- **[live-appdata]** The decoded WebView IndexedDB (docs 94/95; `research/idb_schema.txt`) contains **no inbound-push-payload decode or staging store** anywhere across its 13 databases / 103 `model-storage` stores. The only push-adjacent stores are token/registration and receipt-orphan stores — `orphan-tc-token` (#41), `acs-tokens` (#77), `direct-connection-keys` (#35), `history-sync-notification` (#15), `orphan-payment-notification` (#29) — none of which holds decrypted push *content*. If WNS pushes carried message bodies, a decode-staging store would exist; it does not. Message content lives in the `message`/`chat`/app-state stores populated over the Noise socket.
- **[protocol-cross-ref]** Re-read this session: `whatsmeow/push.go` only *registers* a token (`RegisterForPushNotifications`, `push.go:94-108`, namespace `urn:xmpp:whatsapp:push`) and has **no inbound-push decode path**; Baileys `src/` likewise has only outbound registration (`Socket/socket.ts:793` `should_show_push_notification`) and WAM push-interaction analytics (`WAM/constants.ts:4607-4608` `PUSH_NOTIFICATION_CLICK/RENDER`) — **no inbound-push-payload decode**. In both open clients all message content arrives over the single Noise socket (`Baileys/src/Utils/noise-handler.ts:147-265` `decodeFrame`/`onFrame`; whatsmeow `socket/noisesocket.go`). The open protocol has no second content-bearing push channel, so the native client (which interoperates) cannot have one either.
- **[bundle]** A re-grep of all three Windows-shell bundle files finds no inbound-push decode (`decryptPush`/`decodePush`/`pushPayload`/`parsePush`/`onRawNotification` ⇒ zero hits); only the outbound registration path and the `web_push_notifications` feature flag, which is `[1643,"bool",!1,!0]` ⇒ **default `false`** (`n6o0-NaJTww.js:13438`).

---

### 3.4 Out-of-process push background task (app not running)

When the **main window is gone** (or the process was never launched), an in-process channel handler can't run. Windows instead activates the registered **background-task COM server**.

**The COM class** `PushNotificationBackgroundTask` (`WhatsApp.Background/PushNotificationBackgroundTask.cs`):
- `[Guid("082f08a8-6f51-4fa3-9a14-7563c83d7c49")]`, `[ComVisible(true)]`, implements `IBackgroundTask` (`:9-13`). **This GUID matches the manifest** `082f08a8…` (`x64/AppxManifest.xml:113`).
- `Run(IBackgroundTaskInstance)` (`:33-37`) does **only** `PushReceivedChannel.Writer.TryWrite(Unit.Default)` — it writes a single `Unit` into a static **unbounded** `Channel<Unit>` (`:15`) and returns. No payload is inspected.
- `WhenPushNotificationReceived => PushReceivedChannel.Reader` (`:17`) is the consumer-facing stream.
- `Register(out uint? token)` (`:19-31`) calls `ComServer.CoRegisterClassObject(ref classId, new PushNotificationBackgroundTaskClassFactory(), CLSCTX_LOCAL_SERVER=4, REGCLS_MULTIPLEUSE=1, out token)`.

**The class factory + P/Invoke** (`WhatsApp.Background/ComServer.cs`):
- `IClassFactory` (`IID 00000001-…-46`) with `CreateInstance`/`LockServer` (`:13-24`).
- `PushNotificationBackgroundTaskClassFactory.CreateInstance` rejects aggregation (`CLASS_E_NOAGGREGATION=0x80040110`), validates the requested IID is the task GUID or `IUnknown`, else `E_NOINTERFACE=0x80004002`, and returns `MarshalInterface<IBackgroundTask>.FromManaged(new PushNotificationBackgroundTask())` (`:30-44`).
- `CoRegisterClassObject` / `CoRevokeObject` are `[LibraryImport("ole32.dll")]` (`:71-112`).

**Manifest registration** (`x64/AppxManifest.xml:104-116`):
```xml
<Extension Category="windows.backgroundTasks" EntryPoint="Microsoft.Windows.ApplicationModel.Background.UniversalBGTask.Task">
  <BackgroundTasks><Task Type="general" /></BackgroundTasks>
</Extension>
<com:Extension Category="windows.comServer">
  <com:ComServer>
    <com:ExeServer Executable="WhatsApp.Root.exe"
        Arguments="-RegisterForBGTaskServer /nowindow /pushnotification"
        DisplayName="PushTask" LaunchAndActivationPermission="O:PSG:BUD:(A;;11;;;IU)(A;;11;;;S-1-15-2-1)S:(ML;;NX;;;LW)">
      <com:Class Id="082f08a8-6f51-4fa3-9a14-7563c83d7c49" DisplayName="BackgroundTask" />
    </com:ExeServer>
  </com:ComServer>
</com:Extension>
```
So Windows launches `WhatsApp.Root.exe -RegisterForBGTaskServer /nowindow /pushnotification` to host the task out-of-process. The **`/pushnotification` flag suppresses single-instance redirection**: `Program.DecideRedirection` only calls `RedirectActivationToAsync` when the args do **not** contain `/pushnotification` (`Program.cs:45-49`), and `App.OnLaunched` skips main-window init + activation handling when `/pushnotification` is present (`App.cs:238`). This lets the BG-task process run lightweight without spinning up the full UI.

Of the three args in that launch line, only `/pushnotification` and `/nowindow` are WhatsApp-owned: both are named constants (`PushNotificationCommandLineArgument = "/pushnotification"`, `NoWindowCommandLineArgument = "/nowindow"`, `WhatsApp.VoIP/WhatsApp/Constants.cs:62,64`) and both are inspected by WhatsApp code (`Program.cs:45`, `App.cs:304`/`:238`). The leading `-RegisterForBGTaskServer` token is **not** a WhatsApp argument: it has no constant in the C# and is read by neither `Program` nor `App` — and a [native-binary] strings scan confirms the literal is **absent from the WhatsApp DLLs too** (`WhatsApp.Root.dll`, `WhatsApp.VoIP.dll`), appearing only in `AppxManifest.xml`. It is therefore consumed entirely by the closed Windows App SDK background-host entry point (`Microsoft.Windows.ApplicationModel.Background.UniversalBGTask.Task`, `AppxManifest.xml:104`), which parses it and dispatches into the registered CLSID `082f08a8…` out-of-process.

**Registration via WinRT trigger** — separately from the raw COM registration, `BackgroundTaskHelper` registers the task with a `PushNotificationTrigger` (`WhatsApp.SystemIntegrations/BackgroundTaskHelper.cs`):
- Task name constant `"WhatsApp Push Notification"` (`:13`).
- `UpdatePushTask(bool enabled)` first `await BackgroundExecutionManager.RequestAccessAsync()`; bails on `Denied*` states (`:19-24`).
- `RegisterPushTask` builds a `BackgroundTaskBuilder { Name="WhatsApp Push Notification" }`, `SetTaskEntryPointClsid(typeof(PushNotificationBackgroundTask).GUID)`, `SetTrigger(new PushNotificationTrigger())`, `Register()` (`:50-56`); it no-ops if already registered unless `forceReregister` (`:41-48`).
- Driven by `PushBgTaskStateSwitcher` (`:15`), flipped from `AppModel` when the banner setting changes: `BackgroundTaskHelper.PushBgTaskStateSwitcher.Switch(mode == ShowNotificationBannerOption.Always)` (`AppModel.cs:188`). **So the BG push task is only active when the notification-banner setting is `Always`.** (Confirmed.)

**App-side registration + consumption** (`App.cs`):
- Ctor: `PushNotificationBackgroundTask.Register(out _pushNotificationBackgroundRegistrationToken)` (`App.cs:123`); finalizer revokes it (`ComServer.CoRevokeObject`, `App.cs:154-158`).
- `StartModel` builds the `MayHaveMessagesNotificationManager` and calls `SubscribeToPushNotificationFromBackgroundTask` (`App.cs:195-196`).
- That method loops `await foreach (Unit … in PushNotificationBackgroundTask.WhenPushNotificationReceived.ReadAllAsync())` and, **only if the web client is not active** (`!_webLifecycle.IsWebClientActive`, `App.cs:223`; `IsWebClientActive => _webClient != null`, `WebLifecycleController.cs:86`), calls `mayHaveMessagesNotificationManager.HandlePushNotification()` (`App.cs:215-227`).

---

### 3.5 "You may have new messages" throttled toast

`MayHaveMessagesNotificationManager` (`WhatsApp.SystemIntegrations/MayHaveMessagesNotificationManager.cs`) is the user-visible result of a background push when no live web client could fetch the message itself.

`HandlePushNotification()` (`:20-41`):
- Gated by `AbProps.Props.MayHaveMessagesEnabled` (`:24`). This A/B flag's **compile-time default is `false`** in both release and debug (`AbPropsValues.cs:7533-7538`), so the whole "may have new messages" fallback toast is **off by default** and only fires when the server pushes `may_have_messages_enabled=true` (AB code 25303).
- Runs on a serial dispatcher (`:18,26`).
- **Throttle window** `_minTimeBetweenNotifications` = **24 h** in release, **5 min** in debug (`:16`).
- Reads `storage.GetLastShowTime()`; if older than the window (or never), updates last-show-time and shows the toast **with popup**; otherwise shows it **suppressed** (silent, history-only) by passing `suppressDisplay` (`:27-34`).

`ShowMayHaveNewMessagesNotification(bool suppressDisplay)` (`:43-69`) builds a legacy `ToastNotification` (`Windows.UI.Notifications`) with body `Strings.WaStrings.PushMayHaveMessages`, an action button, `Tag="mayHaveNewMessagesNotification"`, `SuppressPopup = suppressDisplay`, launch arg `ToastLaunchArgs.CreateOpenWindowAction("mayHaveNewMessagesNotification")`, shown via `ToastNotificationManager.CreateToastNotifier().Show(...)`.

`OnMainAppStarted()` (`:71-84`) **resets** last-show-time to `null` when the main app starts (`App.cs:339`), so the throttle doesn't carry across an interactive launch.

**Persistence** — `AppSettingBasedPushNotificationHandlerStorage` (`AppSettingBasedPushNotificationHandlerStorage.cs`) stores the last-show-time in the **per-session** local settings as a Unix-millis `Int64` blob under `SettingsKey.LastTimePushNotificationShownUtc` (`:11-26`), via `loginSessionDataProvider.SessionLocalSettings`.

---

### 3.6 Message toasts (Windows App SDK)

`NotificationsManager` (`WhatsApp.SystemIntegrations/NotificationsManager.cs`) wraps `AppNotificationManager.Default`. Ctor registers it (`Register()`) and hooks `NotificationInvoked` (`:48-51`).

**Entry from JS:** JS calls the `SystemIntegrationsBridge` host object → `SystemIntegrationsManager.ShowMessageNotification(key, tag, header, body, thumbnailPath, footer, contextMenuContents[], contextMenuActionIds[], replyInputPlaceholder, replyButtonContent, suppressToast, toneId)` (`SystemIntegrationsManager.cs:82-90`). It **gates on the banner setting** (`:84`): skip if `Never`, or if `OnlyWhenAppIsOpen && IsAppInSystemTray`. It zips the parallel content/action-id arrays into `MessageNotificationContextMenuItem`s, maps `toneId==0 → null`, and forwards a `MessageNotification` record (`MessageNotification.cs:5`).

**`ShowMessageNotification(MessageNotification)`** (`NotificationsManager.cs:54-75`):
- `CreateToastContent` (`:246-295`): two `AdaptiveText` lines (`Header`, `Body`), a circle-cropped `AppLogoOverride` from `ThumbnailPath` (`:265-269`), and an optional centered `Footer` subgroup.
- `Launch = ToastLaunchArgs.CreateClickMessageAction(Key, Tag)` (`:57`).
- `Actions = CreateToastActions` (`:217-244`): adds each context-menu item (`ToastContextMenuItem`, background activation), and — if both `ReplyInputPlaceholder` and `ReplyButtonContent` are set — a `ToastTextBox("quickReplyInputBoxId")` + a `ToastButton` bound to that box (background activation). **Cap: while buttons+context-items > 5, drop the oldest context item** (`:239-242`).
- **Tone:** `CustomTones.GetTone(ToneId)` → `ToastAudio { Silent = SuppressToast || tone==null, Src = tone.Uri }` (`:59-68`).
- `AppNotification { Tag = Tag ?? Key, SuppressDisplay = SuppressToast }`, then `_appNotificationManager.Show(...)` (`:69-74`).

**Close / cancel:** `CloseMessageNotification(key, tag)` → `RemoveByTagAsync(tag ?? key)` (`:77-81`); `CloseAllNotifications()` → `RemoveAllAsync()` (`:83-93`); `CancelScheduledNotifications(groupKey)` removes scheduled toasts whose `Group==groupKey` via the legacy `ToastNotifierCompat` (`:95-111`). On login, `SystemIntegrationsManager.Reset()` clears badge, cancels `"LoginRequired.Group"`, and closes all (`SystemIntegrationsManager.cs:75-80`).

**Tone catalogue** (`CustomTones.cs`): default tone id 1 = `Sounds/whatsapp_windows_pn_02.m4a` (`:8-10`); ids 2–11 = `Sounds/Alert-01.wma … Alert-10.wma` (`:38-42`). `toneId==0` ⇒ silent (`GetToneIdByPath` returns 0 for `"Silent"`, `:31-34`). `Tone.Uri = ms-appx:///<path>` (`Tone.cs:9`).

**File-saved toasts:** `ShowMediaDownloadedNotification(resultFilePath)` (`:307-362`) and `ShowBulkSavingCompletionNotification(folder, n)` (`:364-413`) build `ActivationType=Protocol` toasts whose buttons launch the file/folder path directly (`GetSavedFileToastActions`, `:415-442`). Wired from `App.cs:296-303` (`MediaDownloaded` / `BulkSavingCompleted` events).

---

### 3.7 VoIP call toasts (legacy `ToastNotificationManager`)

`VoipToastController` (`WhatsApp.Notifications/VoipToastController.cs`) creates a single `ToastNotifier` (`:37`) and uses fixed grouping: `Group="VoipToast.Group"`, incoming `Tag="VoipToast.Incoming"` (`:17-19`).

**Incoming call** — `ShowCall(callModel, profilePhoto, name, groupName)` (`:152-160`) → `Show(...)` (`:202-250`):
- `Scenario = ToastScenario.IncomingCall` (`:219`) — gives the persistent full-screen-ish incoming-call treatment.
- **Looping ringtone**: `Audio = { Src = ms-appx:///Sounds/whatsapp_windows_ringtone_02.m4a, Loop = true, Silent = IsCallNotificationsMuted || IsCallRingtoneMuted }` (`:220-225`). Mute flags come from `WebPreferencesProvider.IsCallNotificationsMuted` / `IsCallRingtoneMuted` (`:209-211`; facades keyed `"WAGlobalCallNotifications"` / `"WAGlobalCallRingtone"`, `WebPreferencesProvider.cs:387-388`).
- `SuppressPopup = IsCallNotificationsMuted` (`:231`).
- De-dup: removes the prior incoming toast from history first (`RemoveIncomingToastFromNotificationHistory`, `:162-172,207`); only shows if `_activeCall == call.Id`.
- Drives a `VoipNotificationStateTracker` state machine (`GoToStateToastShowAttempted/Success/Failure`, `:154,238,243,247`).

**Buttons** (`GetNormalActions`, `:174-200`): Decline/Ignore (background, `IgnoreIncomingVoipAction`), Accept/Open (foreground, `AnswerVoipAction`); plus a Settings button (foreground, `SettingsIncomingVoipAction`) constructed but, in this version, **not added to the returned actions** (the `new ToastButton(...Settings...)` at `:177-181` is discarded — only the Decline+Accept pair is returned at `:192-199`). This is a **deliberate trim, not a bug**: the `AbProps.Props.UwpVoipIncomingCallNotificationVersion` read at `:176` is intentionally discarded (`_ = …`) and that flag's **compile-time default is `0`** (`AbPropsValues.cs:6909-6914`); the newer-version path that re-introduces the Settings/lobby flow lives at the *activation* side (`ViewsController.cs:272-294`, gated on `> 0`), dormant until the server raises the version. Group calls relabel Decline→Ignore, Accept→Open (`:182,187`). Button icons from `WhatsApp.Design/Voip/Assets/ToastIcons/*` (`:180,185,190`).

**Button activation → call window.** The toast's launch args are parsed and dispatched in `ViewsController.TryProcessArgActivation` (`ViewsController.cs:247-314`), reached via `ProcessNotificationRequest → TryProcessArgActivation` (`:120-122`): `IsAnswerVoipAction` records accept and `ShowCallWindow(callId, answer:true)` (`:257-271`); `IsLaunchVoipAction` opens the call **lobby** when `UwpVoipIncomingCallNotificationVersion > 0` else answers plain (`:272-294`); `IsSettingsIncomingVoipAction` goes to the lobby (`:297-312`). `ShowCallWindow` (`:316+`) builds an `IVoipVm` via `VoipVmFactory` and obtains device permissions. **`IgnoreIncomingVoipAction` has no branch here** — it is a *Background*-activation button, so declining merely drops the toast from history; no window is raised.

**Group-call-link reminder** — `ShowGroupCallReminder(args)` (`:91-150`): builds a toast titled by the joiner name(s) ("X & N others", or two-name form), avatar circle-cropped, `Launch = ToastLaunchArgs.CreateLaunchVoipCallLinkAction(token, isVideo, isFirst)`; reports a WAM `NotificationDelivery` event (`ReportNotificationDelivery`, `:83-89`). Wired from `ViewsController.cs:387,484-486`.

**No-device error** — `ShowError(...)` (`:54-60`) shows a toast explaining the missing mic/speaker with Message/Dismiss buttons (`GetNoDevicesActions`, `:252-270`).

`ChangeActiveCall(id)` (`:45-52`) updates the active-call id and clears stale incoming toasts; wired from `ViewsController.cs:402`.

---

### 3.8 Toast activation: CLSID, launch-arg encoding, dispatch

**Activator CLSID** `bebd6a5e-1b14-4a57-a195-c772d28b6d15` is declared once as the toast activator and as a COM ExeServer (`x64/AppxManifest.xml:100-102, 118-124`):
```xml
<desktop:ToastNotificationActivation ToastActivatorCLSID="bebd6a5e-1b14-4a57-a195-c772d28b6d15" />
…
<com:ExeServer Executable="WhatsApp.Root.exe" DisplayName="WhatsApp Toast Activator"
               Arguments="----AppNotificationActivated:">
  <com:Class Id="bebd6a5e-1b14-4a57-a195-c772d28b6d15" />
</com:ExeServer>
```
When a toast is clicked while the app is closed, Windows launches `WhatsApp.Root.exe ----AppNotificationActivated:` and the Windows App SDK surfaces it as `ExtendedActivationKind.AppNotification`.

**Launch-arg format** — `ToastLaunchArgs` (`ToastLaunchArgs.cs`) encodes a query-string-ish `key=value&key=value` (`ToString`, `:64-67`). Reserved keys: `action`, `key`, `tag`, `id` (call id), `contextMenuActionId`, `video`, `link`, `isFirst` (`:9-25`). `ParseParams` (`:177-209`) URL-decodes each `k=v` (bare key ⇒ value `"1"`, leading `?` stripped). `TryParse` requires an `action` key (`:44-57`). Factory + predicate pairs exist for each action, e.g. `CreateClickMessageAction`/`IsClickMessageAction`, `CreateQuickReplyAction`/`IsQuickReplyMessageAction`, `CreateContextMenuAction`/`IsContextMenuAction`, `Create*VoipAction`/`Is*VoipAction`, `CreateOpenWindowAction`/`LaunchApp`. `NotificationActionEnum` = `{None, Click, QuickReply, ContextMenuClick, AnswerVoipAction, LaunchVoipAction, NewCallVoipAction, IgnoreIncomingVoipAction, SettingsIncomingVoipAction, NewCallLinkVoipAction, LaunchApp}` (`NotificationActionEnum.cs`).

**Activation entry points:**
- **App already running:** `AppNotificationManager.NotificationInvoked` → `NotificationsManager.OnNotificationInvoked` (`:297-305`) → `await EnsureMainWindowInitialized()` → `HandleNotificationActivation(args)`.
- **App launched by the toast:** `App.OnLaunched` checks `activatedEventArgs.Kind == ExtendedActivationKind.AppNotification` and calls `_views.Notifications.HandleNotificationActivation((AppNotificationActivatedEventArgs)…Data)` (`App.cs:242-245`). For a redirected secondary instance, `Program.OnActivated → App.OnActivated` force-resumes for `AppNotification`/`Protocol`/`ShareTarget` (`App.cs:561-565`).

**`HandleNotificationActivation(AppNotificationActivatedEventArgs)`** (`NotificationsManager.cs:137-206`):
1. `ToastLaunchArgs.TryParse(args.Argument, out args)`; bail if no `action` (`:139-142`).
2. Resolve the UI dispatcher (`:143`).
3. Branch on the parsed action:
   - **Click** (`IsClickMessageAction`, `:149-158`): `_appLaunchMetrics.RecordAppRestore()`, then on the UI thread emit `(key, Click, "")` on `_notificationActionSubject`, `ShowWindow()`, and compact the VoIP window.
   - **QuickReply** (`:159-165`): pull the typed text from `args.UserInput["quickReplyInputBoxId"]` and emit `(key, QuickReply, inputText)` — **without** showing the window.
   - **ContextMenuClick** (`:166-172`): emit `(key, ContextMenuClick, contextMenuActionId)`.
   - **Call-link VoIP** (`IsCallLinkVoipAction`, `:173-195`): request device permissions (`DevicePermissionUtils.TryGetDevicePermissions(webView, useVideo)`), capture the native `IVoip` worker, and `obj.PreviewCallLink(new CallLinkParams { Token, VideoEnabled, IsLidCall = AbProps.Props.CallingLidVersion>0 })` — this is the only activation path that reaches the **native VoIP engine** directly.
   - **LaunchApp** (`:196-204`): record restore + `ShowWindow()` + compact VoIP window.
4. Always call `_navigation(activatedArgsData)` (`:205`) — the `Action<…>` passed in is `ViewsController.ProcessNotificationRequest` (`ViewsController.cs:88,120-123`), which forwards the raw argument string into `TryProcessArgActivation(...)` (the `whatsapp://`-style deep-link replay path).

**Action → JS.** The emitted `(key, action, additionalData)` triplets are consumed in `SystemIntegrationsManager`'s ctor, which subscribes `NotificationActionObservable` and pipes each through `MessageNotificationAction(key, action.ToString(), additionalData)` (`SystemIntegrationsManager.cs:71`). That method **waits for the web bridge to be present and the web screen to be `Main`** before invoking `bridgeToWeb.MessageNotificationAction(MessageNotificationActionArgs.Create(...))` (`:144-149`). So a quick-reply typed against a toast becomes a JS call once the web client is ready — the actual send happens in the JS bundle.

---

### 3.9 Taskbar / app badge

`TaskbarManager` (`TaskbarManager.cs:8-29`): `UpdateAppBadge(badgeCount)` → if `0`, `BadgeUpdateManager.CreateBadgeUpdaterForApplication().Clear()`; else fetch the `BadgeNumber` template, set `value=<count>` on `/badge`, and `Update(...)`.

JS drives it via `SystemIntegrationsManager.UpdateTaskbarBadge(count)` (`:102-112`), **gated** by `WhenShowTaskbarBadge` (`Never`, or `OnlyWhenAppIsOpen && IsAppInSystemTray` ⇒ force `0`; else show `count`). Setting key `"WindowsTaskbarNotificationSetting"`, default `Always` (`WebPreferencesProvider.cs:328,390`). Badge is reset to `0` on login (`SystemIntegrationsManager.Reset`, `:77`) and on tray-clear paths (`ViewsController.cs:356`).

---

### 3.10 End-to-end sequences

**A. Server-initiated push, app backgrounded but running:**
`WNS → WebLifecycleController.OnPushNotification (:198) → ForceResume() (:204) → DoUpdateWebState(forceResume:true) → TryResume() → _webClient.Connect()/Resume()` → JS reconnects and fetches messages → JS calls `ShowMessageNotification` over the bridge → `NotificationsManager` shows the toast.

**B. Server-initiated push, app fully closed:**
`WNS raw push → Windows activates COM CLSID 082f08a8… → new WhatsApp.Root.exe -RegisterForBGTaskServer /nowindow /pushnotification → PushNotificationBackgroundTask.Run writes Unit (:36) → App.SubscribeToPushNotificationFromBackgroundTask reads it (:220) → !IsWebClientActive ⇒ MayHaveMessagesNotificationManager.HandlePushNotification() → throttled "you may have new messages" toast`. (No message content is available to the native side here.)

**C. User clicks a message toast (app closed):**
`Windows launches WhatsApp.Root.exe ----AppNotificationActivated: → App.OnLaunched sees Kind==AppNotification (:242) → NotificationsManager.HandleNotificationActivation → ToastLaunchArgs.TryParse → Click branch → RecordAppRestore + ShowWindow + emit (key,Click) → SystemIntegrationsManager waits for web Main screen → bridgeToWeb.MessageNotificationAction(...)` opens the chat in JS.

**D. Quick reply from toast:**
Same activation, `QuickReply` branch reads `UserInput["quickReplyInputBoxId"]`, emits `(key,QuickReply,text)`, **no window shown**; `SystemIntegrationsManager` forwards to JS once ready.

---

## 4. Native Dependencies

This subsystem is almost entirely **C# over WinRT/Win32**; there is very little custom C++/Rust here, so nothing below is recovered from native bodies — not because the native binaries are unreadable (they are: the crypto core was disassembled with radare2, doc 96) but because the notification surface simply has no native implementation to recover.

**Windows platform APIs (confirmed, all via OS/SDK, not WhatsApp native):**
- `Windows.Networking.PushNotifications.PushNotificationChannelManager` / `PushNotificationChannel` — WNS channel + raw-push events (`WebLifecycleController.cs:10,224,244`; `PushRegistration.cs:5,37`).
- `Windows.ApplicationModel.Background.{BackgroundExecutionManager, BackgroundTaskBuilder, PushNotificationTrigger, IBackgroundTask}` — BG task registration/trigger (`BackgroundTaskHelper.cs:7,19,50-55`; `PushNotificationBackgroundTask.cs:5,13`).
- `ole32.dll` `CoRegisterClassObject` / `CoRevokeObject` — out-of-proc COM server registration (`ComServer.cs:71-112`).
- `Microsoft.Windows.AppNotifications.AppNotificationManager` (Windows App SDK 1.6) — message/file toasts (`NotificationsManager.cs:9`).
- `Windows.UI.Notifications.{ToastNotificationManager, ToastNotifier, BadgeUpdateManager, ToastNotificationManagerCompat}` (legacy UWP) — VoIP toasts, "may have messages" toast, scheduled-toast cancel, app badge (`VoipToastController.cs:9`; `MayHaveMessagesNotificationManager.cs:3`; `TaskbarManager.cs:2`; `NotificationsManager.cs:12,37`).
- `Microsoft.Toolkit.Uwp.Notifications` — `ToastContent`/`AdaptiveText`/`ToastButton` XML builders (`NotificationsManager.cs:6`, `VoipToastController.cs:3`).

**WinRT projection / bridge types (CsWinRT, generated — confirmed):**
- `WinRTAdapter.WnsToken` + `IWnsTokenStatics` — the `{Data,Channel}` value the token is delivered as (`WnsToken.cs`, statics IID `975B9383-4743-5DC8-8AB0-A4A2DCE9F9A8`).
- `WinRTAdapter.LifecycleBridge` / `ILifecycleBridgeToNative` (GUID `2053755C-…`) / `ILifecycleBridgeToWeb` (GUID `0E807FD2-…`) — the `ConnectionBridge` host object (`App.cs:315`).
- `WinRTAdapter.SystemIntegrationsBridge` / `ISystemIntegrationsBridgeToNative` — the `SystemIntegrationsBridge` host object carrying `ShowMessageNotification`/`UpdateTaskbarBadge`/etc. (`AppModel.cs:234`).

**The only native-engine reach from this subsystem (confirmed call site, body unavailable):** the call-link toast path captures the native `IVoip` worker and calls `IVoip.PreviewCallLink(CallLinkParams)` (`NotificationsManager.cs:185-192`). The VoIP engine itself is in `WhatsAppNative.dll` (C++/Rust) — see doc 41 — not part of notifications.

---

## 5. Linux/Electron Port Mapping

| Windows piece | Linux/Electron equivalent | Notes / risk |
|---|---|---|
| **WNS push channel** (`PushNotificationChannelManager`, `WnsToken{uri, "uwp_public"}`) | **No equivalent.** Linux has no OS push broker. Options: (a) keep a persistent socket alive (no suspend); (b) self-host a push relay; (c) on macOS use APNs. | **Biggest gap.** WNS lets Windows wake a *terminated* app. On Linux/Electron the realistic port is: **never suspend the renderer's WA socket** while running, and rely on a background `BrowserWindow`/utility process kept alive (or run headless via the WA JS bundle in Node) — i.e. drop the suspend/resume-on-push design entirely. The whole `IsSuspendAllowed`/ack-token handshake (`WebLifecycleController`) becomes moot if you don't suspend. |
| **WNS token → server registration** (token forwarded to JS, JS registers it) | If you keep the WA socket open, no push token is needed — the server delivers over the live socket. | The waweb JS bundle's WNS-token registration code can simply be fed an empty/n-a token, or the suspend path disabled so it never asks. **Reuse from bundle:** the JS already handles "no native push" gracefully in web mode. |
| **Out-of-proc BG task** (COM CLSID `082f08a8…`, `WhatsApp.Root.exe /pushnotification`) waking the app | A long-running **Electron main process** (or a systemd user service / `--hidden` autostart) that keeps a background connection. `app.setLoginItemSettings({ openAtLogin })` for autostart. | The "wake a dead process" semantics don't exist; you keep one lightweight process resident. The `MayHaveMessages` fallback toast becomes unnecessary if the live connection fetches the actual message. |
| **`MayHaveMessagesNotificationManager`** throttled generic toast (24 h window) | `new Notification({ body })` (Electron) with your own throttle timer + persisted last-shown timestamp (e.g. `electron-store`). | Only needed if you adopt a wake-without-content model; with a live socket you show the *real* message instead. |
| **Message toasts** (`AppNotificationManager`, avatar circle-crop, quick-reply textbox, context-menu, custom tone) | Electron **`Notification`** API. | Linux/`libnotify` (via Electron) supports `body`, `icon`, and **`actions`** (buttons) and **inline reply** *only on some backends*. **Risk:** **quick-reply text input** is **not portable** — supported on macOS (`hasReply`/`replyPlaceholder`) and some Freedesktop servers via `"inline-reply"` cap, but **not GNOME Shell by default**. Detect cap; fall back to "click → open chat + focus composer". Circle-cropped avatar: pre-crop the PNG yourself (no `HintCrop` equivalent). |
| **Custom per-chat tones** (`Sounds/*.m4a/.wma`, `ToastAudio.Src`) | Notifications on Linux generally use a single system sound; play tones yourself with an `<audio>` element / Web Audio in the renderer, or `sound`/`node-speaker`. | Per-notification custom audio is **not** reliably supported by Freedesktop notifications. Play decoupled from the toast. `.wma` assets must be re-encoded (`.ogg`/`.mp3`). |
| **VoIP incoming-call toast** (`ToastScenario.IncomingCall`, looping ringtone, persistent, Accept/Decline) | No "incoming call" scenario on Linux notifications. Build a **custom always-on-top, focus-stealing `BrowserWindow`** for the ringing UI; loop the ringtone in-renderer. | **Significant work.** The persistent/looping/high-priority behavior of `IncomingCall` has no portable analog; a borderless top window is the standard Electron approach (Discord/Slack do this). |
| **Toast activation** (CLSID `bebd6a5e…`, `----AppNotificationActivated:`, `ExtendedActivationKind.AppNotification`) | Electron `Notification` **`click`** / **`action`** / **`reply`** events; for closed-app launch use a single-instance lock + `second-instance` / `open-url` (deep links). | `app.requestSingleInstanceLock()` replaces `AppInstance.FindOrRegisterForKey` (`Program.cs:37`). Register a `whatsapp://` protocol via `app.setAsDefaultProtocolClient`. The `ToastLaunchArgs` `action=…&key=…` scheme ports 1:1 as a JS object passed to the notification's click handler — no need for query encoding since Electron gives you the JS closure directly. |
| **`ToastLaunchArgs` query encode/parse** | Plain JS object captured in the notification's `click` closure. | Delete the encoder; it only exists because Win32 activation is string-based. |
| **Taskbar badge** (`BadgeUpdateManager`, numeric) | Electron **`app.setBadgeCount(n)`** (Unity launcher on Linux; Dock on macOS). | Works on Linux only under Unity/KDE with `.desktop` `X-Unity` support; otherwise overlay on the tray icon (`Tray.setImage`). Gating rules (`WhenShowTaskbarBadge`) port directly as JS conditionals. |
| **Settings gates** (`WhenShowNotificationBanner`, `WhenShowTaskbarBadge`, `IsCallNotificationsMuted`, `IsCallRingtoneMuted`) | Same enum/boolean prefs in your store; the WA JS bundle already owns these keys (`"WindowsNotificationBannerSetting"`, `"WindowsTaskbarNotificationSetting"`, `"WAGlobalCallNotifications"`, `"WAGlobalCallRingtone"`). | **Reuse from bundle:** these are *web* preferences the bundle reads/writes; the native side only consumes them. Port the consumption logic, keep the bundle's storage. |
| **Background-task enable switch** (`PushBgTaskStateSwitcher`, banner==Always) | Map to "keep background connection alive" toggle. | Simplifies to a boolean. |

**Net recommendation for the port:** the **suspend/resume-on-push architecture is the load-bearing Windows-specific design** and should be replaced with a *persistent connection* model on Linux. Once you do that, ~60% of this subsystem (`WebLifecycleController`'s token/ack/suspend machinery, the BG-task COM server, `MayHaveMessages`) disappears, and what remains is straightforward Electron `Notification` + `Tray` + `setBadgeCount` work driven by the same JS-bundle calls.

---

## 6. Open Questions / Unverified

Each item below was **re-investigated this session** against the C# dump, the `waweb` JS bundle, and the manifest; every entry is now prefixed with a verdict tag (`[RESOLVED]` / `[PARTIAL]` / `[CANNOT RESOLVE STATICALLY]`) followed by the concrete finding and citation, with the original question preserved.

1. **Raw push payload contents.** *Original question:* `PushNotificationReceivedEventArgs.RawNotification` is force-resumed/buffered but never parsed natively (`WebLifecycleController.cs:198-205`). Whether WhatsApp's WNS pushes carry an encrypted/opaque payload that JS decodes, or are pure "wake" pings, is not visible in native code. Inferred: pure wake pings.
   **[PARTIAL]** (tightened, round 2 — still PARTIAL because it requires proving a negative). Confirmed in native code that the raw notification is never decoded on the native side — `OnPushNotification` only re-emits `args.RawNotification` onto `_unhandledPushNotificationSubject` when no web client is attached, then calls `ForceResume()` (`WebLifecycleController.cs:198-205`). The JS side's role is now pinned down in the bundle: the token is registered server-side via an IQ `to=S_WHATSAPP_NET, type=set, xmlns="urn:xmpp:whatsapp:push"` carrying `config{ id:<channelUri>, platform:"wns", version:<v> }`, sent through `WADeprecatedSendIq.deprecatedSendIq` (bundle module `WAWebSetWindowsPushConfig.setWindowsPushConfig`, `TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js:184790-184838`; the `version` attr maps the channel name via `m()` at `:184836`: `uwp_public → DROP_ATTR`, otherwise `uwp_beta`/`uwp_alpha`/`uwp_hybrid_dogfooding` pass through, default `uwp_beta` at `:184811`). The Smax-typed builder form is `WASmaxOutPushConfigWNSClientMixin.mergeWNSClientMixin` (`SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js:111273-111290`), one of a `{android, apple, enterprise, fb, wns, web}` push-platform mixin group (`:111315-111325`), routed through `WASmaxOutPushConfigSetRequest.makeSetRequest` (`:111363-111372`). The full bridge handshake is visible in `WindowsHybridBridgeConnection` (`U2j2EhR17gV.js:753`): on `updateNotificationsTokenEvent` it waits for main-stream-ready, calls `setWindowsPushConfig(i, l)`, `handleConnectionState(true)`, then `acknowledgeNotificationsToken(i, l)` — matching the native ack path exactly (`WebLifecycleController.cs:283-289`).
   **New round-2 evidence for the wake-ping claim:** a bundle-wide grep for any inbound push-payload decode (`decryptPush`/`decodePush`/`pushPayload`/`parsePush`/`onRawNotification`/inbound `w:push` handler) returns **nothing** across all three Windows-shell bundle files — only the outbound registration and the `web_push_notifications` feature flag (`n6o0-NaJTww.js:13438`, declared `[1643,"bool",!1,!0]` ⇒ **default `false`**) exist. (cross-reference: whatsmeow `push.go` and Baileys `src/` — both *register* a push token (`RegisterForPushNotifications`, "generally not necessary… don't use this if you don't know what you're doing", `whatsmeow/push.go:94-108`) but neither contains any inbound-push-payload decode; **all** message content arrives over the single Noise socket via `NoiseSocket.receiveEncryptedFrame → onFrame` (`whatsmeow/socket/noisesocket.go:112-119`), i.e. the open protocol has no second content-bearing push channel.) This is strong cross-reference + bundle-grep corroboration that WNS pushes are pure wake-pings (content always arrives over the resumed socket), but the WNS payload itself is an opaque OS-broker blob and proving it content-free is proving a negative against minified code, so it stays PARTIAL. A live WNS wire capture of an inbound raw push (`args.RawNotification.Content`) would make it RESOLVED.
   **New final-pass evidence (live appdata + re-verified cross-ref):** [live-appdata] the decoded WebView IndexedDB (docs 94/95; `research/idb_schema.txt`) — the **authoritative** WhatsApp-Web state store — has **no inbound-push-payload decode or staging object store** anywhere across its 13 databases / 103 `model-storage` stores. The only push-adjacent stores are token/registration and receipt-orphan stores (`orphan-tc-token` #41, `acs-tokens` #77, `direct-connection-keys` #35, `history-sync-notification` #15, `orphan-payment-notification` #29); none stages decrypted push *content*. Real message bodies live in the `message`/`chat`/app-state stores populated over the Noise socket. If WNS pushes carried decryptable content, a decode-staging store would exist on disk — it does not. [protocol-cross-ref, re-read this session] Baileys `src/` confirms the same shape: its only push touchpoints are outbound registration (`Socket/socket.ts:793` `should_show_push_notification`) and WAM click/render analytics (`WAM/constants.ts:4607-4608`), with content arriving via `Utils/noise-handler.ts:147-265` (`decodeFrame`/`onFrame`); whatsmeow has zero inbound-push decode. So three provenance classes (live-on-disk store schema, the bundle, and two open interoperating clients) all agree the push channel carries no content. Verdict still **PARTIAL** for the same reason: the WNS `RawNotification` blob is an opaque OS-broker payload and "carries no content" is a negative that only a live WNS wire capture of `args.RawNotification.Content` can convert to RESOLVED — no static artifact in this corpus can.
2. **`MayHaveMessagesEnabled` default.** *Original question:* Gated on `AbProps.Props.MayHaveMessagesEnabled` (`MayHaveMessagesNotificationManager.cs:24`); the default/rollout value was thought to live only in server A/B config (`abprops.db`).
   **[RESOLVED]** The **compile-time client default is `false`** in both release and debug builds (`AbPropsValues.cs:7533-7538` — `case AbPropertyCode.may_have_messages_enabled: … return false;`), wired in as the field initializer `_mayHaveMessagesEnabled = GetAbPropertyDefaultBool(...)` (`AbPropsValues.cs:544`). So out of the box the "may have new messages" throttled toast is **OFF**; only a server A/B push of `may_have_messages_enabled=true` (code 25303, `AbPropsValues.cs:154`) enables it. The *runtime* rolled-out value still lives in server config and is not knowable statically, but the shipped default is now confirmed.
3. **Settings VoIP button discarded intentionally?** *Original question:* In `VoipToastController.GetNormalActions` the Settings `ToastButton` is constructed but not added to the returned `ToastActionsCustom`; the `UwpVoipIncomingCallNotificationVersion` A/B read at `:176` is also discarded (`_ = …`). Unverified whether a newer A/B branch re-adds it, and whether the discard is deliberate.
   **[RESOLVED]** Deliberate, and gated on an A/B version that defaults OFF. `uwp_voip_incoming_call_notification_version` has a **compile-time default of `0`** in both release and debug (`AbPropsValues.cs:6909-6914`; field init `AbPropsValues.cs:656`). The version is genuinely consumed at *activation* time, not at toast-build time: `ViewsController.TryProcessArgActivation` branches on `AbProps.Props.UwpVoipIncomingCallNotificationVersion > 0` for the `LaunchVoip` action to route into the call **lobby** instead of answering directly (`ViewsController.cs:272-294`). With the default `0`, that newer lobby branch is inactive, the `GetNormalActions` read at `VoipToastController.cs:176` is intentionally discarded (`_ = …`), and the shipped incoming-call toast is the 2-button Decline/Accept layout (`VoipToastController.cs:182-199`). A newer branch *exists in code* but is dormant unless the server raises the version (code 7541, `AbPropsValues.cs:210`).
4. **`PushRegistration` truly dead?** *Original question:* No callers found in the C# dump; treated as dead. May be reflective/vestigial.
   **[RESOLVED]** Dead/vestigial. A repo-wide grep for every public member — `PushRegistration.` type ref, `UriObservable`, `RequestNewUri`, `OnPushRegistered` — returns **only the definitions in `PushRegistration.cs` itself** (no external callers). Its single side effect, `Settings.Instance.WnsRegistered = true` (`PushRegistration.cs:27`), writes a settings key (`Settings.cs:60` enum slot 81, accessor `Settings.cs:261-269`) that is **read by nothing** — `WnsRegistered` appears only as its own definition and that one write. The live WNS channel path is entirely `WebLifecycleController`. (CsWinRT activation is non-reflective, so an unreferenced static class is genuinely unreachable here.)
5. **`-RegisterForBGTaskServer` handling.** *Original question:* The manifest passes this arg to the BG-task ExeServer (`AppxManifest.xml:112`), but explicit handling was not located in `Program.cs`/`App.cs` beyond the `/pushnotification` checks. Unverified exact dispatch.
   **[PARTIAL]** (re-confirmed final pass; native-binary scan now added but still no artifact closes it). A whole-tree grep re-run this session confirms the literal `-RegisterForBGTaskServer` appears **only in `x64/AppxManifest.xml`** (the ExeServer `Arguments` declaration) and **nowhere in the decompiled C#** — neither `Program.Main`/`DecideRedirection` (`Program.cs:19-52`, which only special-cases `/pushnotification` at `:45`) nor `App` inspect it; it is also **absent from the waweb bundle** (the JS shell never sees this process arg). **New [native-binary] evidence (final pass):** a `strings` scan of the shipping WhatsApp DLLs (`x64/WhatsApp.Root.dll`, `x64/WhatsApp.VoIP.dll`) confirms the literal `RegisterForBGTaskServer` is **absent from the native binaries as well** — it occurs nowhere in WhatsApp's own code, native or managed, only in the manifest. **New [decompiled-C#] contrast:** the two args WhatsApp *does* own each have a named constant and a real reader — `PushNotificationCommandLineArgument = "/pushnotification"` and `NoWindowCommandLineArgument = "/nowindow"` (`WhatsApp.VoIP/WhatsApp/Constants.cs:62,64`), inspected at `Program.cs:45` and `App.cs:304`/`:238` respectively — whereas `-RegisterForBGTaskServer` has **no constant and no reader anywhere**, sharpening the conclusion that it is not a WhatsApp-parsed token. The argument is therefore consumed by the WinRT background-host infrastructure declared as the BG-task entry point `Microsoft.Windows.ApplicationModel.Background.UniversalBGTask.Task` (`AppxManifest.xml:104`), which dispatches into the registered CLSID `082f08a8…` out of process. None of this corpus's resources can show the actual parse: the bundle, whatsmeow, and Baileys are *web/cross-platform protocol* implementations with zero visibility into the closed Windows App SDK COM background-host; the native WhatsApp DLLs do not contain the string at all. The exact `UniversalBGTask` parsing lives in the closed Windows App Runtime, so the precise dispatch stays PARTIAL — **residual:** resolvable only by disassembling the Windows App SDK BG-task host runtime, which this session's [native-binary] scan confirms is **not in the corpus**: a `strings` sweep of *every* DLL under `x64/` for both `RegisterForBGTaskServer` and `UniversalBGTask` returns **zero hits in any binary** (only `AppxManifest.xml` contains them), and the only `Microsoft.WindowsAppRuntime*` DLLs shipped here are the `Bootstrap`/`Bootstrap.Net` loaders and CsWinRT `*.Projection` stubs — the actual `Microsoft.Windows.ApplicationModel.Background.UniversalBGTask.Task` host implementation DLL is absent. Closing this requires that closed host runtime DLL, outside this RE corpus.
6. **VoIP toast → activation parity.** *Original question:* `VoipToastController` uses the legacy `ToastNotifier`; activation parsing handles `AnswerVoip`/`IgnoreIncomingVoip`/`SettingsIncomingVoip`, but those branches were not traced to their consumers; thought to live in `VoipSession`/`VoipVm`, out of scope.
   **[RESOLVED]** The consumers are in `ViewsController.TryProcessArgActivation` (`ViewsController.cs:247-314`), reached from the toast activation via `ProcessNotificationRequest → TryProcessArgActivation(args.Argument, …)` (`ViewsController.cs:120-122`):
   - `IsAnswerVoipAction` (`:257-271`) → records accept (`activeCall.RecordUserAccept()`, `GoToStateAccepted()`) and `ShowCallWindow(callId, answer:true)`.
   - `IsLaunchVoipAction` (`:272-294`) → if `UwpVoipIncomingCallNotificationVersion > 0` opens the call **lobby** (`ShowCallWindow(..., goToLobby:true)`), else answers plain.
   - `IsSettingsIncomingVoipAction` (`:297-312`) → `GoToStateSettingsClicked()` + `ShowCallWindow(..., goToLobby:true)`.
   `ShowCallWindow` (`:316+`) builds an `IVoipVm` via `VoipVmFactory` and obtains device permissions. **`IgnoreIncomingVoipAction` is intentionally NOT handled here** — it is a *Background*-activation button (`VoipToastController.cs:182-186`), so "decline/ignore" is just dropping the toast from history; there is no foreground window to raise. So parity holds for the active branches; the Settings branch only reaches the lobby when the A/B version is raised (see item 3).
7. **Exact `VisibilityState` enum ordering.** *Original question:* Values `Visible/Minimized/SystemTray/None` are used; the `Math.Max((int)…)` merge (`WebLifecycleController.cs:99`) and `GetMemoryLimit`/`IsThrottleAllowed` switches imply `Visible < Minimized < SystemTray`, but the enum definition was not opened — ordering inferred.
   **[RESOLVED]** The inferred ordering in the earlier draft was **backwards**, and a fifth member was missed. The real enum is `VisibilityState { None=0, SystemTray=1, Minimized=2, Visible=3, Focused=4 }` (`WhatsApp.Bridge/VisibilityState.cs:3-10`). So `NativeState = (VisibilityState)Math.Max((int)main, (int)voip)` (`WebLifecycleController.cs:99`) takes the **more-visible / less-suspendable** of the main and VoIP window states (e.g. a focused VoIP window keeps the app awake even if the main window is in tray). Only `NativeState == SystemTray` (numeric `1`) counts as "minimised to tray" for suspend (`isMinimisedToTray`, `:106`) and is the sole state where `IsThrottleAllowed()` returns true (`:311-318`); `GetMemoryLimit()` returns the 500 MB cap only at `Minimized` (`:320-327`). The body (§3.2) has been corrected accordingly.
