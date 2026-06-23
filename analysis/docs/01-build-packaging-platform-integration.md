# Build, Packaging & Platform Integration

> Deep reverse-engineering reference for the **native** Meta WhatsApp for Windows client
> (`5319275A.WhatsAppDesktop`, package version `2.2607.106.0`, x64).
> All citations are paths **relative to `decompiled_source/`** plus a `:LINE` when the line was read.
> Claims are marked **[confirmed]** (read in the actual file) or **[inference]** (deduced, not directly visible).

---

## 1. Purpose & Scope

This document covers how the Windows client is **built, packaged, installed, activated, and wired into the OS** — everything *outside* the chat protocol and crypto. Concretely:

- The **MSIX package shape**: identity, framework dependencies, capabilities, resources, block map, code integrity catalog.
- The **process model**: full-trust WinUI 3 / Windows App SDK 1.6 entry point, single-instance redirection, STA bootstrap.
- The **activation surface**: `whatsapp://` protocol, Share Target, Startup Task, toast/notification COM activator, push-notification background-task COM server, jumplist.
- The **WinRT activatable-class registry**: how `WinRTAdapter.dll` (≈40 bridge classes) and `WhatsAppNative.dll` (≈75 native classes) are declared as in-process servers and projected to the WebView2 JS bundle.
- The **WebView2 host environment**: which URL is loaded, what query parameters/headers tell the JS it is "in the native shell", how renderer crashes/updates are handled, and the bundled Chromium browser extensions (Code Verify, Zoom).
- A concrete **Linux/Electron port mapping** for every Windows packaging/activation/integration primitive.

It does **not** cover the Noise handshake, FunXMPP wire format, Signal crypto, VoIP, or SQLite storage — those are separate documents. It references them only where packaging touches them (e.g. native-module activation).

The single source-of-truth artifacts are:

- `x64/AppxManifest.xml` — the generated MSIX manifest (285 lines). **[confirmed]**
- `x64/AppxBlockMap.xml` — per-file SHA-256 block map (1041 `<File>` entries). **[confirmed]**
- `x64/AppxMetadata/CodeIntegrity.cat` — DER PKCS#7 signed code-integrity catalog. **[confirmed]**
- `x64/WhatsApp.Root.runtimeconfig.json` / `x64/WhatsApp.Root.deps.json` — .NET 8 runtime + dependency manifest. **[confirmed]**
- `decompiled/WhatsApp.Root/WhatsApp/Program.cs`, `App.cs` — process bootstrap & activation. **[confirmed]**

---

## 2. Where It Lives

### Package / build artifacts (under `decompiled_source/`)

| File | Role |
|---|---|
| `x64/AppxManifest.xml` | MSIX manifest: identity, dependencies, capabilities, all Extensions and ActivatableClass registries. **[confirmed]** |
| `x64/AppxBlockMap.xml` | Block map; 1041 files, SHA-256 (`xmlenc#sha256`) per 64 KB block, `LfhSize` per file. **[confirmed]** |
| `x64/AppxMetadata/CodeIntegrity.cat` | Signed catalog (`DER Encoded PKCS#7 Signed Data`, 113 KB). **[confirmed]** |
| `x64/AppxSignature.p7x` | Package signature blob (12 KB). **[confirmed]** |
| `x64/[Content_Types].xml` | OPC content-type map for the package. **[confirmed]** |
| `x64/WhatsApp.Root.runtimeconfig.json` | `net8.0`; bundles `Microsoft.NETCore.App` 8.0.15 + `Microsoft.WindowsDesktop.App` 8.0.15; CsWinRT config flags. **[confirmed]** |
| `x64/WhatsApp.Root.deps.json` | Dependency closure: WindowsAppSDK 1.6.241114003, WebView2 1.0.3485.44, CsWinRT 2.1.6, WinUIEx 2.5.1, H.NotifyIcon.WinUI 2.2.0, System.Reactive 6.0.1. **[confirmed]** |
| `x64/*.pri` | Compiled resource indexes: `resources.pri`, `WhatsApp.*.pri`, `WhatsAppNative.pri`, `WhatsAppRust.pri`, `WinRTAdapter.pri`, `WinUIEx.pri`, `WindowsLegacyApi.pri`, `NativeThirdParty.pri`. **[confirmed]** |
| `x64/Assets/` | Tile/logo/splash PNGs referenced by `<uap:VisualElements>`. **[confirmed]** |
| `x64/Extensions/CodeVerify/Chrome/` | Bundled "Code Verify" MV3 browser extension (`manifest.json`, `contentWA.js`, `background.js`). **[confirmed]** |
| `x64/Extensions/Zoom/` | Bundled "Zoom" MV3 extension (`manifest.json`, `background.js`). **[confirmed]** |

### Native / runtime binaries shipped in the package (`x64/`)

- App assembly + launcher: `WhatsApp.Root.exe`, `WhatsApp.Root.dll`, plus `WhatsApp.{Core,Networking,Protobuf,VoIP,DataModels,Models,Design,RichTextFormatting,AbProps,WebView2.LocalizationResources}.dll`. **[confirmed via `ls`]**
- JS↔native bridge: `WinRTAdapter.dll` (4.6 MB), `WhatsAppNativeProjection.dll` (632 KB). **[confirmed]**
- Native core: `WhatsAppNative.dll` (12.5 MB, C++), `WhatsAppRust.dll` (1.1 MB, Rust). **[confirmed]**
- Self-contained .NET 8 runtime: `coreclr.dll`, `clrjit.dll`, `clrgc.dll`, `hostfxr.dll`, `hostpolicy.dll`, `mscordaccore*.dll`, `System.*.dll`, `Microsoft.WinUI.dll` (7.3 MB), `Microsoft.Windows.SDK.NET.dll` (24.9 MB). **[confirmed]**
- WebView2 loader: `WebView2Loader.dll`, `Microsoft.Web.WebView2.Core*.dll`. **[confirmed]**
- 3rd-party native: `msquic.dll`, `PhoneNumbers.dll`, `zxing.dll`, `D3DCompiler_47_cor3.dll`, `wpfgfx_cor3.dll`, `vcruntime140_cor3.dll`. **[confirmed]**
- Tray icon: `H.NotifyIcon.dll`, `H.NotifyIcon.WinUI.dll`. **[confirmed]**

### Source (bootstrap, activation, integration)

| Concern | File(s) |
|---|---|
| Process entry / single-instance | `decompiled/WhatsApp.Root/WhatsApp/Program.cs` **[confirmed]** |
| App lifecycle / activation dispatch / query params | `decompiled/WhatsApp.Root/WhatsApp/App.cs` **[confirmed]** |
| Protocol/share deep-link buffering | `decompiled/WhatsApp.Root/WhatsApp/AppActivationService.cs` **[confirmed]** |
| WebView2 host window | `decompiled/WhatsApp.Root/WhatsApp/MainWindow.cs` **[confirmed]** |
| Target URL / environment | `decompiled/WhatsApp.Root/WhatsApp/WaWebEnvironmentProvider.cs` **[confirmed]** |
| Bridge host-object registration helper | `decompiled/WhatsApp.Root/WhatsApp.Bridge/WinRTAdapterExtensions.cs` **[confirmed]** |
| Model-level bridge registration (~24 bridges) | `decompiled/WhatsApp.Root/WhatsApp/AppModel.cs:209-242` **[confirmed]** |
| Native module activation | `decompiled/WhatsApp.VoIP/WhatsApp/NativeInterfaces.cs:47-61`, `decompiled/WhatsAppNativeProjection/WhatsAppNative/WhatsAppNativeInit.cs` **[confirmed]** |
| Push background-task COM server | `decompiled/WhatsApp.Root/WhatsApp.Background/PushNotificationBackgroundTask.cs`, `ComServer.cs` **[confirmed]** |
| Background-task registration | `decompiled/WhatsApp.Root/WhatsApp.SystemIntegrations/BackgroundTaskHelper.cs` **[confirmed]** |
| WNS channel + token forwarding | `decompiled/WhatsApp.Root/WhatsApp.Notifications/PushRegistration.cs`, `decompiled/WhatsApp.Root/WhatsApp.Bridge/WebLifecycleController.cs` **[confirmed]** |
| Outbound recent-contacts publishing (periodic) | `decompiled/WhatsApp.Root/ContactSyncService.cs`, `decompiled/WhatsApp.Root/WhatsApp.SystemIntegrations/ShareContactManager.cs`, `decompiled/WhatsApp.Root/WhatsApp/JumpListContactManager.cs` **[confirmed]** |

---

## 3. How It Works

### 3.1 Package identity & dependencies

`x64/AppxManifest.xml:10` declares the identity:

```xml
<Identity Name="5319275A.WhatsAppDesktop" Publisher="CN=24803D75-212C-471A-BC57-9EF86AB91435"
          Version="2.2607.106.0" ProcessorArchitecture="x64" />
```

- `mp:PhoneIdentity` (`:11`) carries the Store product/publisher GUIDs.
- `<Properties>` (`:12-16`): `DisplayName=WhatsApp`, `PublisherDisplayName=WhatsApp Inc.`, `Logo=Assets\StoreLogo.png`. **[confirmed]**

**Target device families** (`:17-19`): both `Windows.Universal` and `Windows.Desktop`, `MinVersion=10.0.19041.0` (Windows 10 20H1 / build 19041). **[confirmed]**

**Framework dependencies** (`:20-23`) — this is a *framework-dependent* MSIX, i.e. the runtime pieces are shared OS packages, not bundled into the app payload:

```xml
<win32dependencies:ExternalDependency Name="Microsoft.WebView2" ... MinVersion="1.1.1.1" Optional="true" />
<PackageDependency Name="Microsoft.WindowsAppRuntime.1.6" MinVersion="6000.318.2304.0" .../>
<PackageDependency Name="Microsoft.VCLibs.140.00" MinVersion="14.0.33519.0" .../>
<PackageDependency Name="Microsoft.VCLibs.140.00.UWPDesktop" MinVersion="14.0.33728.0" .../>
```

Key facts:
- **WebView2 is an *optional external* dependency** — the Evergreen WebView2 Runtime is expected to be installed system-wide; if absent, `MainWindow.OnContainerLoaded` detects it (`CoreWebView2Environment.GetAvailableBrowserVersionString()` empty/throws) and shows `WebView2InstallDialogView` (`MainWindow.cs:766-794`). **[confirmed]**
- **Windows App Runtime 1.6** (`Microsoft.WindowsAppRuntime.1.6`) supplies WinUI 3 + the App SDK projections; it is a *framework package dependency* (`AppxManifest.xml:21`), so the OS loader resolves it at launch and **no** `MddBootstrap.Initialize`/`Bootstrap.TryInitialize` call is made. An exhaustive grep over the whole decompiled tree for `MddBootstrap` / `Bootstrap.(Try)Initialize` / `DynamicDependency` runtime calls finds **none** (the only `[DynamicDependency]` hits are AOT-trimming *attributes* on `WinRT/RcwFallbackInitializer.cs`, unrelated to runtime bootstrap). The `Microsoft.WindowsAppRuntime.Bootstrap.dll` / `…Bootstrap.Net.dll` are shipped (they exist for *unpackaged* apps), but their `Initialize` is never invoked from `Program.Main` because this MSIX is packaged and declares the framework `<PackageDependency>`. **[confirmed — packaged MSIX auto-resolves framework deps; bootstrap init absent from the entire C# dump].**

The .NET runtime itself is **self-contained inside the package** (it is *not* a framework dependency): `runtimeconfig.json:4-13` pins `tfm: net8.0` with `includedFrameworks` `Microsoft.NETCore.App` 8.0.15 and `Microsoft.WindowsDesktop.App` 8.0.15, and `coreclr.dll`/`hostfxr.dll`/etc. are present in `x64/`. CsWinRT behavior is tuned via `configProperties` (`:14-23`), e.g. `CSWINRT_ENABLE_DYNAMIC_OBJECTS_SUPPORT=true`, `CSWINRT_USE_WINDOWS_UI_XAML_PROJECTIONS=false`. **[confirmed]**

**Resources** (`:25-85`): 59 `<Resource Language="…">` entries (AF…ZH-TW) — these match the `.pri`-indexed localized strings consumed by `WhatsApp.WebView2.LocalizationResources`. **[confirmed]**

**Capabilities** (`:277-281`): the package is deliberately minimal:

```xml
<Capability Name="internetClient" />
<rescap:Capability Name="runFullTrust" />   <!-- restricted capability -->
<uap:Capability Name="contacts" />
```

`runFullTrust` is what makes this a *desktop bridge / full-trust* app rather than a sandboxed UWP — combined with `EntryPoint="Windows.FullTrustApplication"` it runs with normal Win32 privileges. `contacts` backs `ShareOperation.Contacts` / `Windows.ApplicationModel.Contacts` used in share-target handling (`App.cs:674`). **[confirmed]**

`build:Metadata` (`:282-285`): built with `Microsoft.UI.Xaml.Markup.Compiler.dll` 3.0.0.2411 and `makepri.exe` 10.0.22621.3233. The XAML-compiler stamp `" 3.0.0.2411"` recurs on every `[GeneratedCode]` member across the source (e.g. `App.cs:77`, `MainWindow.cs:40`). **[confirmed]**

### 3.2 Block map & code integrity

`AppxBlockMap.xml:1` is a standard MSIX block map: `HashMethod="…xmlenc#sha256"`, one `<File Name=… Size=… LfhSize=…>` per payload file with child `<Block Hash="…">` elements. There are **1041 files** (`grep -o '<File '`). This is the manifest the OS uses to verify each block on install/stream and to enable differential updates. `AppxMetadata/CodeIntegrity.cat` is the corresponding signed catalog (PKCS#7); `AppxSignature.p7x` signs the whole package. **[confirmed]**

> Port relevance: nothing in the WhatsApp business logic depends on the block map — it is pure MSIX delivery plumbing. On Electron the analog is the auto-updater's block/blockmap (`*.nsis.7z` + `latest.yml` SHA-512) and code-signing, not anything app code reads.

### 3.3 Process entry & single-instance (`Program.cs`)

`Program.Main` (`Program.cs:19-32`) **[confirmed]**:

```csharp
[STAThread]
private static void Main(string[] args) {
    XamlCheckProcessRequirements();            // P/Invoke into Microsoft.ui.xaml.dll
    ComWrappersSupport.InitializeComWrappers();// CsWinRT COM marshalling
    if (!DecideRedirection(args).Result)
        Application.Start(() => {
            SynchronizationContext.SetSynchronizationContext(
                new DispatcherQueueSynchronizationContext(DispatcherQueue.GetForCurrentThread()));
            new App();
        });
}
```

- `XamlCheckProcessRequirements()` is `[DllImport("Microsoft.ui.xaml.dll")]` with `DefaultDllImportSearchPaths(SafeDirectories)` (`:15-17`) — verifies WinUI prerequisites before any XAML loads.
- `ComWrappersSupport.InitializeComWrappers()` sets up CsWinRT's COM-wrapper infrastructure (required because every native bridge is a WinRT object).

**Single-instance** via `DecideRedirection` (`:34-52`):

```csharp
AppInstance appInstance = AppInstance.FindOrRegisterForKey("61E9B470-92E6-482B-AFD8-38C1FB464FB5");
if (appInstance.IsCurrent) appInstance.Activated += OnActivated;   // primary: subscribe to redirected activations
else {
    isRedirect = true;
    if (!commandLineArgs.Contains("/pushnotification"))
        await appInstance.RedirectActivationToAsync(AppInstance.GetCurrent().GetActivatedEventArgs());
}
```

So a second launch **forwards its activation to the primary instance** and exits — *except* a `/pushnotification` launch, which is the background-task COM-server activation and must be allowed to run its own process. `OnActivated` (`:54-57`) routes redirected activations to `App.Instance.OnActivated`. **[confirmed]**

### 3.4 App construction & startup pipeline (`App.cs`)

`App` is the WinUI `Application` subclass and also implements `IXamlMetadataProvider` and three integration provider interfaces (`NotificationsManager.IWindowOperationsProvider`, `SystemIntegrationsManager.IAppStateProvider`, `TrayIconManager.IApplicationOperationsProvider`) (`App.cs:47-49`). **[confirmed]**

Constructor (`:111-152`) order **[confirmed]**:
1. `Instance = this`; init dispatcher; record launch metrics.
2. `InitializeCultureInfo()` — sets every culture slot from `ApplicationLanguages.PrimaryLanguageOverride` (`:160-165`).
3. `InitializeComponent()` loads `ms-appx:///App.xaml`.
4. `ExceptionsHandler` with `SwallowUnhandledExceptions = true`.
5. **`PushNotificationBackgroundTask.Register(out _pushNotificationBackgroundRegistrationToken)`** — registers the COM class factory (see §3.7).
6. `StartModel(_sadRecords)` — async native-storage init.
7. Subscribes `WhenAppInSystemTrayChanged` to drive `WebLifecycleController.ApplyAppState` (tray ⇒ suspend web) (`:130-134`).
8. Registers `SystemEvents.SessionSwitch` so `SessionUnlock` calls `_webLifecycle.ForceResume()` (`:143-173`).

`StartModel` (`:175-213`) hops to a `ConcurrentQueueDispatcher`, constructs `AppModel`, `await model.Initialize()`. On a **fatal SQLite error** (`IsFatalSqliteError` checks `Sqlite.HRForError` for codes 8,11,13,14,18,19,20,21,23,26) it logs out and `Restart(ControlledRestartTypes.CorruptNonDbSettings, …)`. Then `_modelSource.TrySetResult(model)`, `model.Warmup()`, `_webLifecycle.Warmup()`. **[confirmed]**

`OnLaunched` (`:235-257`) and `OnActivated` (`:544-578`) both gate on **not** `/pushnotification`, then `EnsureMainWindowInitialized()` and dispatch by `ExtendedActivationKind`:
- `AppNotification` ⇒ `_views.Notifications.HandleNotificationActivation`.
- `ShareTarget` ⇒ `HandleShareTargetAsync`.
- `Protocol` (`IProtocolActivatedEventArgs`) ⇒ `HandleProtocolActivatedEvent` ⇒ `AppActivationService.HandleAppActivationViaUrlProtocol`.
- Jumplist `LaunchActivatedEventArgs` ⇒ `HandleJumplistActivatedEvent`. **[confirmed]**

### 3.5 MainWindow init & WebView2 environment (`App.cs` + `MainWindow.cs`)

`EnsureMainWindowInitialized` (`App.cs:259-341`) is the **heart of startup**. **[confirmed]**

1. Creates `MainWindow` (a `WinUIEx.WindowEx`), sets RTL window style from `CultureInfo.CurrentUICulture.TextInfo.IsRightToLeft` (`:268-275`), installs Win32 event handlers (`QueryEndSession`, `PowerResume`), sets `Assets/logo.ico`, restores window position via `MainWindowPositionManager`.
2. Determines `shouldStartInTray = activatedArgs.Kind == StartupTask || cmdline contains "/nowindow"` (`:304`).
3. `CoreWebView2 webView = await MainWindow.GetWebViewCore(shouldStartInTray)`.
4. If never logged in, `ClearBrowsingData("no login session")`.
5. Builds `BuildQueryParameters()` and `WebContentUpdateManager`.
6. **Registers the 4 pre-login bridges** directly on the WebView (`:315-318`):
   `ConnectionBridge=LifecycleBridge`, `TouchpadFix=TouchpadFixBridge`, `NativeAppStateBridge`, `WebUpdateBridge`.
7. `model.SetWebView(webView, …)` registers the **~24 model bridges** (§3.8).
8. `MainWindow.Start(concurrentDictionary)` navigates.
9. Shows or hides the window per `shouldStartInTray`.

**WebView2 environment** — `MainWindow.GetWebViewCore` (`MainWindow.cs:462-514`) **[confirmed]**:
- `CoreWebView2EnvironmentOptions { AreBrowserExtensionsEnabled = true, Language = CultureInfo.CurrentCulture.Name }`.
- `DisableDataReportingToMS()`; `StartBackgrounded()` if starting in tray; `StartGpuDisabled()` if `AbProps.Props.Webview2DisableGpuAcceleration`.
- On low-memory devices, appends Chromium flags driven by `MemoryOptimizationFlags` (`:482-501`): `--disable-features=msSmartScreenProtection,msWebView2EnableTrackingPrevention`, `--js-flags=--scavenger_max_new_space_capacity_mb=8`, `--msWebView2SimulateMemoryPressureWhenInactive=1`.
- `CreateWithOptionsAsync(null, ApplicationData.Current.LocalCacheFolder.Path, options)` — user-data folder = the package's `LocalCache`.

**Settings lockdown** in `OnCoreWebView2Initialized` (`:534-570`): `AreBrowserAcceleratorKeysEnabled=false` (`:538`), `IsStatusBarEnabled=false` (`:540`), `IsReputationCheckingRequired=false` (`:541`), `IsBuiltInErrorPageEnabled=false` (`:542`), `IsSwipeNavigationEnabled=false` (`:543`), `AreDefaultScriptDialogsEnabled=false` (`:544`), `IsZoomControlEnabled=false` (`:545`), `IsPinchZoomEnabled=false` (`:546`). Two settings notably go the *other* way: `AreDefaultContextMenusEnabled=true` (`:539`) and `AreDevToolsEnabled = IsDevEnvironment()` (`:547`). It wires `ProcessFailed`, `NewWindowRequested`, `PermissionRequested`, `ScriptDialogOpening`, `NavigationStarting`, `ContextMenuRequested`, `DOMContentLoaded`. **[confirmed]**

- **DevTools are effectively always enabled**: `IsDevEnvironment()` (`:669-672`) is a hard `return true`, so `AreDevToolsEnabled` is always `true` even in the shipped Production build — a security-relevant detail (the WebView2 dev tools / F12 inspector are never disabled). **[confirmed]**
- `OnPermissionRequested` (`:723-735`) **auto-allows every permission** (`State = Allow`). **[confirmed]**
- `OnScriptDialogOpening` (`:737-748`) **unconditionally calls `args.Accept()`** — it auto-accepts every `alert`/`confirm`/`prompt`/`beforeunload` script dialog (parallel to the auto-allow-permissions behavior above). **[confirmed]**
- `OnNewWindowRequested` (`:674-693`) opens external URLs in the OS browser via `Launcher.LaunchUriAsync` and cancels the in-app popup. **[confirmed]**
- `OnCoreWebView2ProcessFailed` (`:585-621`): `BrowserProcessExited` ⇒ ping web, restart-to-tray on close if dead; render-process failures ⇒ `WebView.Reload()`. **[confirmed]**
- `OnNewBrowserVersionAvailable` ⇒ prompt then `RestartApp(WebView2Update,…)` (`:654-667`). **[confirmed]**

**Navigation** — `MainWindow.Start` (`:516-532`): adds header `X-WA-WebView2-Version: <PackageInfo.Version.ToStringHybrid()>`, enables web-resource interception for the sharesheet, optionally creates an offline `CacheManager`, then `coreWebView.Navigate(url, args)` where `url` comes from `WaWebEnvironmentProvider`. **[confirmed]**

### 3.6 Target environment & native-context query string

`WaWebEnvironmentProvider.GetUrl()` (`WaWebEnvironmentProvider.cs:42-51`) resolves the current environment type and delegates the type→URL mapping to `GetUrlForEnvironment()` (`:78-88`) **[confirmed]**:
- Default `Production = https://web.whatsapp.com/`.
- `Development = https://dev-web.whatsapp.com/`, `OnDemand = https://dev-web.my-od.whatsapp.com/`.
- `Custom` = env var **`WA_WEB_URL`** (`:114-117`).
- A `LocalSettings["OverridenEnvironmentType"]` int overrides everything (`:19-40`); changing it (via `OverrideCurrentEnvironmentType`, `:103-112`) calls `App.Restart(EnvironmentChanged,…)`.

`App.BuildQueryParameters()` (`App.cs:378-403`) builds the query string the JS bundle reads to know it is inside the native Windows shell **[confirmed]**:

```text
windows=1
windowsBuild=<PackageInfo.Version.ToStringHybrid()>
windowsBuildType=<BuildDetails.GetBuildOrChannel()>
bridgeError=1
launchContext=<metrics launch context | "unknown">
osBuild=<OsVersion.Build>
windows_offline=1     // only when AbProps.Webview2EnableOfflineSupport && !IsDataConnected
```

These are passed to `Navigate(url, args)` and re-applied on every document request via `AlwaysUseArgumentsForDocumentRequested` (`App.cs:325`). **[confirmed]**

### 3.7 Push background-task COM server (`/pushnotification`)

This is the most intricate packaging mechanism. The manifest declares **three** related extensions (`AppxManifest.xml:103-124`) **[confirmed]**:

```xml
<Extension Category="windows.backgroundTasks" EntryPoint="…UniversalBGTask.Task">
  <BackgroundTasks><Task Type="general" /></BackgroundTasks>
</Extension>
<com:Extension Category="windows.comServer">
  <com:ComServer>
    <com:ExeServer Executable="WhatsApp.Root.exe"
        Arguments="-RegisterForBGTaskServer /nowindow /pushnotification" DisplayName="PushTask"
        LaunchAndActivationPermission="O:PSG:BUD:(A;;11;;;IU)(A;;11;;;S-1-15-2-1)S:(ML;;NX;;;LW)">
      <com:Class Id="082f08a8-6f51-4fa3-9a14-7563c83d7c49" DisplayName="BackgroundTask" />
    </com:ExeServer>
  </com:ComServer>
</com:Extension>
```

The CLSID `082f08a8-6f51-4fa3-9a14-7563c83d7c49` **exactly matches** the `[Guid(...)]` on `PushNotificationBackgroundTask` (`PushNotificationBackgroundTask.cs:11`). **[confirmed]**

Flow **[confirmed]**:
- `PushNotificationBackgroundTask.Register` (`PushNotificationBackgroundTask.cs:19-31`) calls `ComServer.CoRegisterClassObject(ref classId, new PushNotificationBackgroundTaskClassFactory(), CLSCTX_LOCAL_SERVER=4, REGCLS_MULTIPLEUSE=1, out token)`. `CoRegisterClassObject`/`CoRevokeObject` are `[LibraryImport("ole32.dll")]` (`ComServer.cs:71-112`).
- The class factory's `CreateInstance` (`ComServer.cs:30-44`) returns `MarshalInterface<IBackgroundTask>.FromManaged(new PushNotificationBackgroundTask())`.
- `Run(IBackgroundTaskInstance)` (`PushNotificationBackgroundTask.cs:33-37`) just `PushReceivedChannel.Writer.TryWrite(Unit.Default)` into an **unbounded channel**. It is intentionally minimal — the heavy work happens in the main app.
- `App.SubscribeToPushNotificationFromBackgroundTask` (`App.cs:215-233`) consumes `WhenPushNotificationReceived`; when the web client is **not** active, calls `MayHaveMessagesNotificationManager.HandlePushNotification()` to show a throttled "you may have new messages" toast.
- **Teardown / revoke**: the registration is undone in the `App` finalizer `~App()` (`App.cs:154-158`), which calls `ComServer.CoRevokeObject(out var registrationToken)` (a `[LibraryImport("ole32.dll")]` over `CoRevokeObject`, `ComServer.cs:98-112`) to revoke the push COM class factory registered at construction, and writes the result back into `_pushNotificationBackgroundRegistrationToken`. **[confirmed]**

The OS launches the COM server with `Arguments="… /pushnotification"`; `Program.DecideRedirection` lets that process bypass single-instance redirection (`Program.cs:45`), and `App.OnLaunched`/`OnActivated` skip window init when `/pushnotification` is present (`App.cs:238`, `App.cs:543`+ via the guard). **[confirmed]**

**`LaunchAndActivationPermission` SDDL decoded** (`AppxManifest.xml:112`, `O:PSG:BUD:(A;;11;;;IU)(A;;11;;;S-1-15-2-1)S:(ML;;NX;;;LW)`): owner `PS` = the running principal (`NT AUTHORITY\SELF`), primary group `BU` = `BUILTIN\Users`. The DACL grants two ACEs with access mask `0x11` = `COM_RIGHTS_EXECUTE (0x1) | COM_RIGHTS_ACTIVATE_LOCAL (0x10)` to **`IU` (Interactive Users)** and to **`S-1-15-2-1` (`ALL APPLICATION PACKAGES` — every AppContainer)**. The SACL is a mandatory-integrity label `(ML;;NX;;;LW)` = **Low** integrity with `NO_EXECUTE_UP`. Net effect: an interactive logged-on user *and* any packaged/AppContainer process (e.g. the WebView2 renderer) may launch and locally activate the push COM server, and the server is reachable down to Low integrity — i.e. the server is deliberately broadly launchable so the OS push infrastructure and the sandboxed WebView2 side can both reach it. **[confirmed — SDDL decoded]**

**Trigger registration** — `BackgroundTaskHelper.UpdatePushTask` (`BackgroundTaskHelper.cs:17-35`): `await BackgroundExecutionManager.RequestAccessAsync()`, and on success `RegisterPushTask` (`:37-65`) builds a `BackgroundTaskBuilder { Name = "WhatsApp Push Notification" }`, `SetTaskEntryPointClsid(typeof(PushNotificationBackgroundTask).GUID)`, `SetTrigger(new PushNotificationTrigger())`, `Register()`. Gated behind a `StateSwitcher<bool>` (the notification-banner setting). **[confirmed]**

A *separate*, in-process server backing the WinRT background-task host plumbing is declared at `AppxManifest.xml:147-152` (`Microsoft.Windows.ApplicationModel.Background.UniversalBGTask.dll`, with the `windows.backgroundTasks` `EntryPoint` at `:104`). That DLL is **not** part of this package's payload — it is absent from `x64/` and is resolved from the `Microsoft.WindowsAppRuntime.1.6` framework package at runtime. It is distinct from the push `<com:ExeServer>` above: the `-RegisterForBGTaskServer /nowindow /pushnotification` launch (`:112`) is served by **`WhatsApp.Root.exe` itself** via `ComServer.CoRegisterClassObject` (`App.cs:123` → `PushNotificationBackgroundTask.cs:24`), not by `UniversalBGTask.dll`; only the literal `-RegisterForBGTaskServer` token is never branched on by name in C# (the COM registration is unconditional). **[confirmed — see §6.4]**

### 3.8 WNS channel & token forwarding to JS

- `PushRegistration.GetChannelAsync` (`PushRegistration.cs:35-38`) calls `PushNotificationChannelManager.CreatePushNotificationChannelForApplicationAsync()`; `UriObservable` projects `channel.Uri`. `RequestNewUri()` closes and re-creates to rotate. `OnPushRegistered` sets `Settings.Instance.WnsRegistered`. **[confirmed]**
- `WebLifecycleController` forwards the channel URI to the JS client as a `WnsToken` with channel name **`"uwp_public"`** (`WebLifecycleController.cs:18`, `:192`, `:297`): `_webClient?.UpdateNotificationsToken(WnsToken.Create(_wnsToken, "uwp_public"))`. The controller only treats the token as acknowledged when `_acknowledgedChannel == "uwp_public"` (`:306`), and only suspends the web client when the acked token matches — so the server can still WNS-wake the app while backgrounded. **[confirmed]**

### 3.9 Activation: protocol, share target, startup task, jumplist

**`whatsapp://` protocol** (`AppxManifest.xml:128-132`):
```xml
<uap:Extension Category="windows.protocol"><uap:Protocol Name="whatsapp">…</uap:Protocol></uap:Extension>
```
`AppActivationService` (`AppActivationService.cs`) **buffers** deep links until the JS web bridge subscribes: `HandleAppActivationViaUrlProtocol` either calls `_web.HandleAppActivationViaProtocol(uri)` immediately or queues it in `_urlActivations`; `Subscribe` (`:14-26`) replays the queue once `IAppActivationBridgeToWeb` is set (the JS side connects via the `AppActivationBridge` host object registered in `AppModel.cs:231`). **[confirmed]**

**Share Target** (`AppxManifest.xml:133-141`): `SupportsAnyFileType`, data formats `URI` and `Text`. `App.HandleShareTargetAsync` + `CreateShareDeeplinkAsync` (`App.cs:618-692`) convert the `ShareOperation` into a `whatsapp://send?jid=…&text=…&attachment_uris=…&source=sharesheet` deep link; files are registered through `MainWindow.RegisterFilesForSharesheet`, and contact targets come from `shareOperation.Contacts.FirstOrDefault()` (uses the `contacts` capability). **[confirmed]**

**Startup Task** (`AppxManifest.xml:125-127`): `<uap5:StartupTask TaskId="2defd21c-…" Enabled="true">`. When the activation kind is `StartupTask` (or cmdline `/nowindow`), `EnsureMainWindowInitialized` sets `shouldStartInTray=true` and `HideMainWindow()` (`App.cs:304`, `:328-331`). **[confirmed]**

**Jumplist**: `MainWindow.RegisterJumplist` (`MainWindow.cs:577-583`) gated on `AbProps.Props.EnableWindowsJumplistHybrid` via `JumpListController`. Jumplist launches arrive as `LaunchActivatedEventArgs` and are translated to `whatsapp://newchat`, `whatsapp://newcall`, or `whatsapp://newchat?jid=…` in `HandleJumplistActivatedEvent` (`App.cs:585-616`). **[confirmed]**

### 3.10 Toast / notification COM activator

`AppxManifest.xml:99-102` + `:117-124`:
```xml
<desktop:Extension Category="windows.toastNotificationActivation">
  <desktop:ToastNotificationActivation ToastActivatorCLSID="bebd6a5e-1b14-4a57-a195-c772d28b6d15" />
</desktop:Extension>
…
<com:ExeServer Executable="WhatsApp.Root.exe" DisplayName="WhatsApp Toast Activator"
               Arguments="----AppNotificationActivated:">
  <com:Class Id="bebd6a5e-1b14-4a57-a195-c772d28b6d15" />
</com:ExeServer>
```
The same CLSID is the toast activator and its out-of-proc COM server; activations arrive as `ExtendedActivationKind.AppNotification`. **Cold start** (app not running): the toast server launches `WhatsApp.Root.exe` with `Arguments="----AppNotificationActivated:"` (no `/pushnotification`), that process becomes the primary `AppInstance` (`DecideRedirection` returns `false`), boots WinUI, and `OnLaunched` reads `AppInstance.GetCurrent().GetActivatedEventArgs()`, sees `AppNotification`, and calls `HandleNotificationActivation` (`App.cs:241-244`). **Already-running**: the toast-launched second process redirects its activation to the primary via `RedirectActivationToAsync` (`Program.cs:48`), and the primary's `OnActivated` handler dispatches the same `AppNotification` kind (`App.cs:544`, `:561-565`). **[confirmed both paths traced]**

Message toasts use the Windows App SDK `AppNotificationManager` (`NotificationsManager.cs:48-50`: `AppNotificationManager.Default` + `.Register()`). VoIP incoming-call toasts use the **legacy** `ToastNotificationManager` (`VoipToastController.cs:37`, `:166`) with `Scenario = ToastScenario.IncomingCall` and a **looping ringtone** `Audio.Src = ms-appx:///Sounds/whatsapp_windows_ringtone_02.m4a`, `Loop = true`, `Silent` driven by the call-notifications/ringtone mute preferences (`VoipToastController.cs:214-225`). **[confirmed — source re-read]**

### 3.11 WinRT activatable-class registry (in-process servers)

`AppxManifest.xml:145-276` declares every in-process WinRT server. Three `<InProcessServer>` blocks **[confirmed]**:

1. `Microsoft.Windows.ApplicationModel.Background.UniversalBGTask.dll` — one class (the background-task host). (`:147-152`)
2. **`WinRTAdapter.dll`** — ~40 `ActivatableClass` entries (`:153-196`), the JS↔native bridge surface, e.g. `WinRTAdapter.SQLiteBridge`, `ClientKeyBridge`, `ServerEncKeySaltBridge`, `VoipBridge`, `VoipSignalingBridge`, `LifecycleBridge`, `MediaFilesBridge`, `ContactsBridge`, `WamBridge`, `AdvBridge`, `SeamlessMigrationBridge`, `TcTokenBridge`, `LinksPreviewBridge`, `PicturesBridge`, `WnsToken`, `DispatchAdapter`, plus event/arg POCOs (`VoipCallEventArgs`, `ProgressInfo`, …).
3. **`WhatsAppNative.dll`** — ~75 `ActivatableClass` entries (`:197-274`), the native C++/Rust core: `WhatsAppNative.Curve25519`, `Sqlite`, `Transcoder`, `Mp4Utils`, `VoipFactory`, `WhatsAppNativeInit`, `Logger`, `NativeCrashWatchDog`, all the `Call*`/`Voip*`/`Xml*`/audio-source classes.

**How a bridge reaches JS** — `WinRTAdapterExtensions` (`WinRTAdapterExtensions.cs:13-21`):
```csharp
public static void AddWinRTBridge(this CoreWebView2 webView2, string name, object bridge, DispatchAdapter dispatchAdapter)
{
    webView2.AddHostObjectToScript(name, dispatchAdapter.WrapObject(bridge));
}
```
(An overload at `:18-21` constructs a fresh `new DispatchAdapter()` when no adapter is supplied.)
`DispatchAdapter.WrapObject` (the CsWinRT projection shim) marshals the C# adaptee across the WinRT ABI so it is vended as `window.chrome.webview.hostObjects.<name>` to the WhatsApp Web JS. `App.cs:315-318` registers the 4 pre-login bridges; `AppModel.SetWebView` (`AppModel.cs:217-242`) registers the rest, **all sharing one `DispatchAdapter`** (note `ContactsBridge` is exposed as `PopulatedContactsBridge` when already synced, `:238`). **[confirmed]**

**Where the wrapping actually happens.** The managed `WinRTAdapter.DispatchAdapter` (`WinRTAdapter/DispatchAdapter.cs`) is itself a **CsWinRT-projected runtime class**, not the real implementation: its native object is obtained via `ActivationFactory.Get("WinRTAdapter.DispatchAdapter")` and activated through `IActivationFactoryMethods.ActivateInstanceUnsafe` (`DispatchAdapter.cs:61`, `:81`). `WrapObject(object, ICoreWebView2DispatchAdapter)` (`:146-149`) is a thin forwarder to `ICoreWebView2DispatchAdapterMethods.WrapObject` over the `ICoreWebView2DispatchAdapter` interface (IID begins `90 E6 E8 5E 26 BC 76 51 …`, `ABI.WinRTAdapter/IDispatchAdapterMethods.cs:14-18`) — so the actual ABI marshalling that turns the C# adaptee into a JS-callable host object lives **inside the native `WinRTAdapter.dll`**, with the C# layer only projecting the call across. **[confirmed at projection level]**

**The native marshalling body (disassembled this session).** `WinRTAdapter.dll` is a **native C++/WinRT PE32+** (`rabin2 -I`: `bintype pe`, `class PE32+`, `lang msvc`) exporting only the two WinRT entry points `DllGetActivationFactory` + `DllCanUnloadNow` (`objdump -p`); `DllGetActivationFactory` (`0x180183b44`) is the usual class-index-dispatch factory router (`cmp edx, 1` → per-class factory). Its embedded **PDB path `D:\full-fbsource\whatsapp\windows\Samples\WinUI\WebView2\WinRTAdapter\x64\Release\WinRTAdapter\WinRTAdapter.pdb`** shows it is generated by **Microsoft's WebView2 WinUI `wv2winrt` host-object adapter tool**, not hand-written. The demangled C++/WinRT type symbols expose the whole engine in the `wv2winrt_impl` namespace **[native-binary]**:
- `WinRTAdapter::implementation::DispatchAdapter` `implements ICoreWebView2DispatchAdapter` (the same interface the C# projection targets) — this is the object the C# `DispatchAdapter` projects.
- `wv2winrt_impl::DispatchBase` — the per-wrapped-object proxy — `implements IDispatch + IInspectable + ICoreWebView2PrivateDispatchContainer{,2,3,4}`. So `WrapObject` turns each WinRT adaptee into a classic **OLE-Automation `IDispatch`** object surfaced through WebView2's *private* dispatch-container ABI; that `IDispatch` host object is exactly what `AddHostObjectToScript` vends as `window.chrome.webview.hostObjects.<name>`, and JS method calls reach the WinRT vtable back through `ICoreWebView2PrivateDispatchContainer`.
- `wv2winrt_impl::DispatchAsyncResult` `implements ICoreWebView2PrivateDispatchAsyncResult{,2}` + `…AsyncInfo` + `…AsyncFinishedHandler`, so async bridge methods surface to JS as promises.

So the end-to-end path is **C# `WrapObject` → native `ICoreWebView2DispatchAdapter::WrapObject` → construct a `wv2winrt_impl::DispatchBase` `IDispatch` proxy → WebView2 `AddHostObjectToScript` → `chrome.webview.hostObjects.<name>`**: i.e. *IDispatch-over-WinRT*, machine-generated by `wv2winrt`. **[confirmed — native types disassembled from `WinRTAdapter.dll`]**

**Native module bring-up** — `NativeInterfaces.Initialize` (`NativeInterfaces.cs:47-61`) does `new WhatsAppNativeInit().Setup()` once, double-checked-lock guarded. `WhatsAppNativeInit` (`WhatsAppNativeInit.cs`) is a CsWinRT-projected runtime class whose factory comes from `ActivationFactory.Get("WhatsAppNative.WhatsAppNativeInit")` (`:55`); `Setup()` (`:129-132`) calls the native `Setup` ABI method, bootstrapping the C++/Rust component. **[confirmed]**

### 3.12 Legacy string-IPC fallback

`AppModel.SetWebView` also keeps `CoreWebView2.WebMessageReceived += OnWebMessageReceived` (`AppModel.cs:212`) as an `[Obsolete("Use WinRT bridge instead")]` path; `GetAvailableIpcsCallableFromJs` (`:244-247`) reflects the registered bridge instance methods into a `name→argCount` map so the JS can fall back to comma-delimited string IPC if a WinRT host object fails (the `bridgeError=1` query flag advertises this capability). **[confirmed]**

### 3.13 Bundled Chromium browser extensions

Because `AreBrowserExtensionsEnabled = true` and the app ships MV3 extensions in `x64/Extensions/`:

- **Code Verify** (`Extensions/CodeVerify/Chrome/manifest.json`): MV3, name "Code Verify" v4.0.0, content script `contentWA.js` injected at `document_start` into `*://*.whatsapp.com/*` (all frames, `match_about_blank`), `permissions:["webRequest"]`, `host_permissions` include `privacy-auditability.cloudflare.com`, `static.xx.fbcdn.net`, `static.cdninstagram.com`, `static.whatsapp.net`. This is the client-side **binary-transparency / sub-resource integrity** verifier. **[confirmed]**
- **Zoom** (`Extensions/Zoom/manifest.json` + `background.js`): MV3 service worker that exposes a fixed zoom-factor ladder `[0.8,0.9,1,1.1,1.25,1.35,1.5]` over `chrome.tabs.setZoom`, persisted in `chrome.storage.local["current-zoom-factor"]`, `externally_connectable` to `*://*.whatsapp.com/*`. It is driven natively by `ZoomBrowserExtension` (`MainWindow.cs:447-448`, `537`). **[confirmed]**

Both are loaded via `_zoomBrowserExtension.Bootstrap()` / `AddBrowserExtensionToWV()` in `MainWindow` and `BrowserExtensionsManager`. **[confirmed]**

### 3.14 Restart, language change, suspend/exit

- `App.Restart(type, ctx, restartToTray)` (`App.cs:487-491`) records the controlled-restart reason then `AppInstance.Restart(restartToTray ? "/nowindow" : "")`. **[confirmed]**
- Language change: `OnUserLanguageOverrideChanged` (`:353-369`) sets `ApplicationLanguages.PrimaryLanguageOverride` and restarts (`ChangeLanguage`) so RTL window styles + `.pri` resources reload. **[confirmed]**
- Clean exit: `RequestApplicationExit` (`:510-528`) races `SuspendCalling()` (ends active VoIP call, `VoipManaged.Deinitialize()`) against a 2 s timeout, stops contact sync, unhooks `SessionSwitch`, closes window. **[confirmed]**
- Close-to-tray: `OnWindowClosed` (`:718-726`) hides instead of exiting when tray is enabled and a session exists. **[confirmed]**

### 3.15 Outbound recent-contacts publishing to the Windows shell (`ContactSyncService`)

§3.9 and docs 30/31 cover the **inbound** side of jumplist/share-target — how the OS *activates* the app when the user picks a jumplist contact or shares into WhatsApp. This section covers the complementary **outbound** path: a background service that periodically *publishes* the user's recent/frequent WhatsApp contacts into two Windows shell surfaces — the **People/Contacts store** (which backs the Share sheet's "recent recipients") and the **taskbar jumplist** ("Top contacts" group). There is no JS-bridge involvement here; it is pure native C#-to-WinRT shell glue, driven on a timer.

**The driver — `ContactSyncService`** (`ContactSyncService.cs`) is a tiny `System.Threading.Timer` wrapper. `StartPeriodicSync` (`:11-20`) lazily creates one timer that first fires **10 minutes** after start and then **every hour** (`new Timer(…, TimeSpan.FromMinutes(10.0), TimeSpan.FromHours(1.0))`); each tick `await`s `SyncContacts()`. `StopPeriodicSync` (`:37-40`) just `Dispose()`s the timer. **[confirmed]**

`SyncContacts()` (`:22-35`) is `static`, wrapped in a swallow-all `try/catch`, and does two things in order **[confirmed]**:
```csharp
await ShareContactManager.Instance.ShareRecentContactsAsync();
if (AbProps.Props.EnableWindowsJumplistHybrid)
    JumpListContactManager.Instance.ShareContactsAsync();
```
So the share-sheet/People-store publish always runs; the jumplist publish is gated on the same `EnableWindowsJumplistHybrid` AB flag (`AbPropsValues.cs:2020`) that gates inbound jumplist registration (`MainWindow.RegisterJumplist`, §3.9). The ordering matters: `ShareRecentContactsAsync` is what *computes* `JumpListContacts`, which the jumplist step then consumes (see below). **[confirmed]**

**Lifecycle.** The service is owned by `AppModel`: field `_contactsSyncService` (`AppModel.cs:51`), exposed as `ContactSyncService` (`AppModel.cs:95`), constructed in the model ctor (`AppModel.cs:139`), and started inside `AppModel.Initialize()` at `AppModel.cs:173` — right after `_contactsManager.Initialize(sessionData)`, i.e. once the contacts subsystem is live. It is stopped in `App.RequestApplicationExit` (`App.cs:513`: `(await _modelSource.Task).ContactSyncService.StopPeriodicSync()`), alongside the VoIP-suspend race and `SessionSwitch` unhook described in §3.14. **[confirmed]**

**`ShareContactManager` — publishing into the Windows People/Contacts store** (`ShareContactManager.cs`). A process-wide singleton (`Instance`, `:17`) serialized by a `SemaphoreSlim(1,1)` (`:19`). One-time `Initialize()` (`:53-107`) is heavily gated and returns `false` (no-op) unless **all** of these hold **[confirmed]**:
- OS build **≥ 10.0.22621.4602** (`MachineSpec.Instance.OsVersion`, `:59`) — a fairly recent Win11 23H2 servicing build.
- AB flag `Enable3PContactsShareHybrid` is on (`:63`, `AbPropsValues.cs:1513`).
- A UI dispatcher, the `AppModel`, and an avatar VMs pool are all available (`:68-82`).

On the happy path `Initialize` provisions a dedicated Windows contacts account and list **[confirmed]**:
- `UserDataAccountManager.RequestStoreAsync(AppAccountsReadWrite)` then `CreateAccountAsync(store, "com.microsoft.peoplecontract")` (`:83-88`). `CreateAccountAsync` (`:249-255`) adds `ExplictReadAccessPackageFamilyNames.Add("com.microsoft.windows.system")` so the Windows shell (People app / Share sheet) may read the account, then `SaveAsync`. **[confirmed]**
- `ContactManager.RequestStoreAsync(AppContactsReadWrite)` → `CreateContactListAsync(store, "WhatsApp", account.Id)` (`:89-94`). `CreateContactListAsync` (`:257-262`) sets `OtherAppReadAccess = ContactListOtherAppReadAccess.None` (so *other* third-party apps cannot read the list; the system-account read grant above is the only exception). **[confirmed]**
- A `ContactAnnotationStore` + `ContactAnnotationList` (`:99-104`, `:264-267`) — annotations are how the list participates in share/ranking.

`MaxNumberOfFrequentlyUsedContactsSharedWithDevice` is computed as the **sum** of two AB props, `MaxNumberOfFrequentlyUsedContactsSharedWithDevice + MaxNumberOfRecentContactsSharedWithDevice` (`:67`, AB getters at `AbPropsValues.cs:2527` and `:2540`). **[confirmed]**

`ShareRecentContactsAsync` (`:109-133`) is the public entry called by `SyncContacts`. Under the semaphore, after `Initialize()` **[confirmed]**:
- `_jumpListContacts = await GenerateFrequentContacts(5)` — a fixed top-**5** list reserved for the jumplist (`:116`).
- The People-store list is either *all* contacts (`GenerateAllContacts()`) or the top-N frequent (`GenerateFrequentContacts()`), selected by AB flag `ShareAllContactsToWindows` (`:117`, `AbPropsValues.cs:3047`).
- If non-empty, `UpdateSharedContactsAsync(list)` (`:121`).

Contact generation pulls from the model's `ContactsManager` via `ContactsSource.CreateFrequentContacts(…)` / `CreateContacts(…)` with `voipCallableOnly: true` / `callableOnly: true` — i.e. **only call-capable contacts** are published (`:148-178`). Each `UserRecipientItemVm` is mapped to a WinRT `Windows.ApplicationModel.Contacts.Contact` in `ConvertUserVmToContactAsync` (`:195-217`) where `FirstName = user.Title`, **`RemoteId = user.UserJid.ToVoipString()`** (the JID is the stable remote key), and `SourceDisplayPicture` = the avatar as a `RandomAccessStreamReference`. `CreateContactListWithSelf` (`:180-193`) also prepends the self-contact (keyed by `MyJidManagerLegacySingleton.Instance.MyUserJid`) when absent. **[confirmed]**

`UpdateSharedContactsAsync` (`:269-300`) upserts each contact by `RemoteId` (`GetContactFromRemoteIdAsync` → `SaveContactAsync` if missing) and attaches a `ContactAnnotation` with `SupportedOperations = ContactAnnotationOperations.Share` and a `ProviderProperties["Rank"]` integer that **increments per contact** (`rank++`, `:293`) — this rank is what orders them in the Share sheet's recent-recipients row. Finally `_windowsContactList.SaveAsync()`. There is also `ClearSharedContactsAsync` (`:302-308`) which deletes the whole list (its only in-repo caller is teardown/disable, not the periodic path). **[confirmed]**

**`JumpListContactManager` — publishing the "Top contacts" jumplist group** (`JumpListContactManager.cs`). Also a singleton (`Instance`, `:17`) with its own `SemaphoreSlim(1,1)`. `ShareContactsAsync` (`:25-40`, `async void`) → `UpdateTopContacts` (`:42-59`) which reads **`ShareContactManager.Instance.JumpListContacts`** (the top-5 computed in the previous step — note the cross-singleton data dependency, `:47`) and, if non-empty: `JumpList.LoadCurrentAsync()` → `CleanAsync` → `AddContactsAsync`. **[confirmed]**

- `CleanAsync` (`:66-80`) removes every existing item whose `GroupName == Strings.WaStrings.JumplistTopContacts` (so it only rewrites WhatsApp's own group, leaving the system-managed `whatsapp://newchat`/`newcall` tasks from §3.9 intact), then wipes the `ContactPictures` cache folder. **[confirmed]**
- Each contact becomes a `JumpListItem.CreateWithArguments("jid=" + contact.RemoteId, contact.FirstName)` (`:120-126`) — so activating it launches the app with argument `jid=<jid>`, which §3.9's `HandleJumplistActivatedEvent` translates to `whatsapp://newchat?jid=…`. Its `Logo` is a **circular-cropped** PNG written under `ms-appdata:///local/ContactPictures/contact_<guid>.png` via `CircularImageHelper.CreateCircularImageAsync` (`SaveContactPictureAsync`, `:95-118`), falling back to `ms-appx:///Assets/AppList.png` when there is no avatar or on error. `GroupName` is set to the localized "Top contacts" string. **[confirmed]**
- `AddContactsAsync` (`:128-143`) appends the items and `jumpList.SaveAsync()`. **[confirmed]**

> Net effect: every hour (after a 10-minute warmup), call-capable recent/frequent contacts are pushed into a private Windows contact list (visible to the Share sheet, ranked) and the top 5 are mirrored into the taskbar jumplist's "Top contacts" group with circular avatars — both keyed by JID so inbound activation round-trips back through the `whatsapp://` deep-link handlers in §3.9. This is the **publishing** counterpart to the **activation** handling already documented. **[confirmed]**

---

## 4. Native Dependencies

| Component | Shipped as | Confirmed? |
|---|---|---|
| **WhatsAppNative.dll** (C++ core: VoIP engine, Curve25519, native SQLite with a **custom AES+HMAC page codec** (not stock SQLCipher — no `cipher_version`/`kdf_iter`/PRAGMA-key markers; 4096-byte pages + 16-byte per-DB salt + raw 32-byte key; see docs 32/94/96), media transcode, WAM) | In-proc WinRT server, ~75 activatable classes (`AppxManifest.xml:197-274`); bootstrapped by `WhatsAppNativeInit.Setup()` (`WhatsAppNativeInit.cs:129`, called from `NativeInterfaces.cs:57`). The native crypto (Curve25519 = X25519 ECDH + XEdDSA, AES/HMAC/SHA/KDF) is **statically linked**, byte-confirmed via radare2 (doc 96): only `BCryptGenRandom`/Open/CloseAlgorithmProvider (RNG) are imported from `bcrypt.dll`. | **[confirmed registry + bootstrap; native crypto byte-confirmed via doc 96]** |
| **WhatsAppRust.dll** (1.1 MB Rust — Meta **wamedia** media-stream parsing & MP4 operations engine) | Present in `x64/`; has its own `WhatsAppRust.pri`. **Confirmed a load-time import of `WhatsAppNative.dll`**: `objdump -p WhatsAppNative.dll` lists `DLL Name: WhatsAppRust.dll` and imports 24 named C-ABI functions from it (`openMp4Repair`, `doRepairMp4File`, `muxAVStreams`, `demultiplexSelectedStreams`, `extractAVStreams`, `examineMediaFile`, `applyWAanimatedGIFtag`, `createForensicEvidence`, `removeMp4Tracks`, `mp4ErrorCodeToString`, …). It exports a flat C FFI surface (no WinRT `ActivatableClass`), which is why it is absent from the manifest registry. | **[confirmed via objdump import table]** |
| **WinRTAdapter.dll** (4.6 MB) | In-proc WinRT server, ~40 bridge classes (`AppxManifest.xml:153-196`); each `*Bridge` wraps a C# controller and is `WrapObject`'d through `DispatchAdapter`. | **[confirmed]** |
| **WhatsAppNativeProjection.dll** (632 KB) | The CsWinRT-generated C# projection over `WhatsAppNative.dll` (e.g. `WhatsAppNativeInit`, `Curve25519`, `Sqlite`, `VoipFactory`). | **[confirmed]** |
| **WebView2 Runtime** | *Optional external* package dependency (`AppxManifest.xml:20`); Evergreen, system-installed; `WebView2Loader.dll` + `Microsoft.Web.WebView2.Core*.dll` shipped. | **[confirmed]** |
| **Microsoft.WindowsAppRuntime.1.6** | Framework package dependency (`:21`); provides WinUI 3 + App SDK projections (AppNotifications, PushNotifications, AppLifecycle). | **[confirmed]** |
| **Microsoft.VCLibs.140.00(.UWPDesktop)** | Framework package dependencies (`:22-23`). | **[confirmed]** |
| **.NET 8 runtime** | **Self-contained** in package (`coreclr.dll`, `hostfxr.dll`, `System.*.dll`); `runtimeconfig.json` pins 8.0.15. | **[confirmed]** |
| **msquic.dll** | Shipped; a genuine **Microsoft Corporation code-signed** MsQuic QUIC redistributable, **fileVersion 2.4.8.0** (`deps.json`), exporting exactly **two** symbols, `MsQuicClose` (ordinal 1) and `MsQuicOpenVersion` (ordinal 2) (`objdump -p` / `rabin2 -E`; see §6.3 and doc 92); strings carry `MsQuicLib.*` perf counters + `System\CurrentControlSet\Services\MsQuic\Parameters\`. **Not imported (static *or* delay-load) by any shipped WhatsApp/WebView2 DLL** — `objdump -p` *and* `rabin2 -i` over `WhatsAppNative.dll`, `WhatsAppRust.dll`, `WhatsApp.Networking.dll`, `WebView2Loader.dll`, `Microsoft.Web.WebView2.Core.dll` show 0 `msquic` imports; a scan of every `x64/*.dll`/`*.exe` finds no consumer. The native chat socket is plain TCP HTTP/1.1-chunked (`ChunkedHttpSocket.cs:214`, `POST /chat … Transfer-Encoding: chunked`), not QUIC. **Consumer identified: the WebView2/Edge Chromium HTTP/3 layer, used by the JS bundle's `WebTransport` VoIP relay** (`WAWebVoipWebTransportConnectionManager`, `waweb-unmin/a5gdgRhdCri.js:4095`, `self.WebTransport` → `https://<relay>:<port>/webtransport`, QUIC datagrams). | **[confirmed shipped + zero native consumers; consumer = WebView2/Chromium WebTransport, bundle-confirmed]** |
| **PhoneNumbers.dll** (libphonenumber), **zxing.dll** (QR) | Shipped managed deps; **[inference]** consumed by contacts/pairing UI. | partial |
| **H.NotifyIcon(.WinUI).dll** | Tray-icon library (`TrayIconManager`). | **[confirmed via deps.json + ls]** |

> The Ghidra native dumps are **both unusable**: `ghidra-output/WhatsAppNative-functions.txt` is **0 bytes** (empty), and `ghidra-output/WhatsAppRust-functions.txt` is **242 bytes** containing only the PyGhidra error text (`"ERROR REPORT SCRIPT ERROR: … Ghidra was not started with PyGhidra. Python is not available"`) — no function bodies. The packaging/activation claims in *this* doc rest on the WinRT registry + managed bootstrap callers and do not need native bodies. The empty-Ghidra gap has since been **superseded by radare2** (doc 96): `WhatsAppNative.dll` was statically disassembled, byte-confirming the native crypto (X25519 ladder constant a24=121665, SHA-512 K[0], `Curve25519::{Derive,Sign,Verify,GenKeyPair}`, `Sqlite::Open` → custom page codec) — so native crypto is **not** "unread", contrary to the older round-1 framing. **[confirmed via `ls -l` + reading both Ghidra files; native bodies now read via radare2, doc 96]**

---

## 5. Linux/Electron Port Mapping

The target port is `whatsapp-desktop/` (Electron Forge + Vite + TS). The good news: **most UI/business logic lives in the same WhatsApp Web JS bundle** the native shell loads from `https://web.whatsapp.com/`; the shell's job is packaging + activation + the native bridges. Mapping each Windows primitive:

| Windows mechanism | Source anchor | Electron/Linux equivalent | Risk / notes |
|---|---|---|---|
| MSIX package + framework deps | `AppxManifest.xml:17-23` | Electron Forge makers: `.deb`/`.rpm`/`AppImage`/`Flatpak`/`Snap`. Electron bundles Chromium + Node, so no external "WebView2"/"WindowsAppRuntime" dep. | Low. Choose Flatpak/Snap if you want sandbox parity with MSIX. |
| Block map + code-integrity catalog | `AppxBlockMap.xml`, `CodeIntegrity.cat`, `AppxSignature.p7x` | `electron-updater` blockmap (`latest-linux.yml` + SHA-512) and GPG/`debsign` signing. | Low — purely delivery. |
| Self-contained .NET 8 runtime | `runtimeconfig.json` | Electron's bundled V8/Node; native logic → native Node addons (N-API) or sidecar. | n/a |
| Full-trust WinUI host + WebView2 | `MainWindow.cs:462-532` | `BrowserWindow` + `webContents` loading `https://web.whatsapp.com/`, or a `<webview>`/`BrowserView`. Set `X-WA-WebView2-Version`-equiv header via `session.webRequest.onBeforeSendHeaders`. | **Medium.** Web bundle sniffs `windows=1`/native bridges; you must emulate enough query params + host objects (see below) or the JS falls back to plain web. |
| Native-context query string | `App.cs:378-403` | Append your own `?windows=1&windowsBuild=…&launchContext=…` (or a Linux flavor) on `loadURL`. The bundle keys native behavior off these. | **High value, low effort** — likely required to unlock native paths. |
| `AddHostObjectToScript` WinRT bridges | `WinRTAdapterExtensions.cs:13`, `AppModel.cs:217-242` | `contextBridge.exposeInMainWorld` from a typed preload, backed by `ipcRenderer.invoke` → `ipcMain.handle` in main. One exposed object per bridge name (`SQLiteBridge`, `ClientKeyBridge`, `VoipBridge`, …). | **High.** This is the core porting surface. The JS bundle calls `window.chrome.webview.hostObjects.<Name>` — you must either shim that exact namespace or patch the bundle. Reuse the *method signatures* from the `I*BridgeToNative` interfaces (documented in other RE docs). |
| `WhatsAppNative` (Curve25519 = X25519 ECDH + XEdDSA, SQLite custom AES+HMAC codec, transcode, VoIP) | `AppxManifest.xml:197-274`, `WhatsAppNativeInit.cs` | `@signalapp/libsignal-client` (bit-compatible X25519/XEdDSA, per doc 96) or `@noble/curves`; `better-sqlite3` with a matching custom AES+HMAC page codec (the at-rest DB is **not** stock SQLCipher — see docs 32/94/96); `ffmpeg`/`fluent-ffmpeg` + Opus; `pion`/`libwebrtc` (or `@roamhq/wrtc`) for VoIP. | **High.** Biggest re-implementation. See docs 20/32/41/96. |
| `whatsapp://` protocol | `AppxManifest.xml:128-132`, `AppActivationService.cs` | `app.setAsDefaultProtocolClient('whatsapp')` + `open-url` (mac) / `second-instance` argv parse (Linux/Win); register a `.desktop` `MimeType=x-scheme-handler/whatsapp`. Mirror the buffer-then-replay pattern. | Low. |
| Share Target | `AppxManifest.xml:133-141`, `App.cs:618-692` | Linux has no first-class share target; approximate via `.desktop` file associations / `xdg-mime` and a "Send to WhatsApp" Nautilus action, or accept files as CLI args → build `whatsapp://send?...`. | **Medium** (feature gap on Linux). |
| Startup Task / start-in-tray | `AppxManifest.xml:125-127`, `App.cs:304,328` | `app.setLoginItemSettings({ openAtLogin, args:['--hidden'] })` or an XDG autostart `.desktop` with `--hidden`; honor `--hidden`/`/nowindow`-equiv to start to tray. | Low. |
| Jumplist | `MainWindow.cs:577`, `App.cs:585-616` | `app.setUserTasks` / `setJumpList` (Win); on Linux use Unity launcher quicklists or a custom tray menu (newchat/newcall). | Low (Win parity; Linux partial). |
| Outbound recent-contacts publishing (10 min + hourly timer) | `ContactSyncService.cs:11-35`, `ShareContactManager.cs`, `JumpListContactManager.cs` | A `setInterval` in main computing top frequent/recent (call-capable) contacts; **no Windows People-store / Share-sheet-recipient equivalent on Linux** (drop `ShareContactManager`). Jumplist top-contacts → `app.setJumpList` `JumpListCategory` with per-contact `args:'jid=<jid>'` (Win); on Linux, dynamic Unity quicklists or tray submenu. Reuse the JID-keyed `whatsapp://newchat?jid=…` round-trip. | Medium — share-sheet ranking is Windows-only; jumplist achievable on Win, partial on Linux. |
| Toast activator COM server | `AppxManifest.xml:99-124`, `App.cs:242` | Electron `Notification` + `click`/`reply` events; on Linux `libnotify`/D-Bus `org.freedesktop.Notifications` (action buttons supported by most DEs). | Medium — quick-reply action support varies by DE. |
| Push background-task COM server + WNS | `PushNotificationBackgroundTask.cs`, `BackgroundTaskHelper.cs`, `WebLifecycleController.cs:192` (`uwp_public`) | **No WNS on Linux.** Options: keep the websocket alive in the main process (Electron has no aggressive app-suspend, so a backgrounded `BrowserWindow` can hold the connection); or implement your own native push if you ever suspend. Drop the `WnsToken`/`uwp_public` handshake; supply a stub token or signal "always-connected". | **Medium.** Simpler than Windows because Electron doesn't suspend the renderer the way WebView2 does — but you lose OS-driven wake. |
| Single-instance + redirection | `Program.cs:34-52` | `app.requestSingleInstanceLock()` + `second-instance` event to forward argv (deep links). | Low. |
| Tray (H.NotifyIcon) | `App.cs:293`, `TrayIconManager` | Electron `Tray` + `Menu`; on Linux requires an `AppIndicator`/`StatusNotifierItem` (libappindicator) — GNOME needs an extension. | Medium (GNOME tray caveat). |
| Auto-allow WebView2 permissions | `MainWindow.cs:723-735` | `session.setPermissionRequestHandler((wc, perm, cb) => cb(true))` (scope to mic/camera/notifications). | Low. |
| Open external links in OS browser | `MainWindow.cs:674-693` | `webContents.setWindowOpenHandler(() => ({action:'deny'}))` + `shell.openExternal(url)`. | Low. |
| Renderer-crash recovery / update | `MainWindow.cs:585-667` | `webContents.on('render-process-gone')` → `reload()`; `electron-updater` for app updates; the *web* bundle self-updates server-side. | Low. |
| Code Verify / Zoom MV3 extensions | `Extensions/*/manifest.json` | Electron `session.loadExtension(path)` (MV2/MV3 partial support). Code Verify guards binary transparency — likely **omit** for a port (it expects WA's CSP/SRI pipeline); reimplement zoom with `webContents.setZoomFactor`. | Medium — Electron extension support is limited; prefer native zoom + skip Code Verify. |
| `WA_WEB_URL` env override | `WaWebEnvironmentProvider.cs:114` | Keep an identical env var to point at staging during dev. | Free. |

**What can be reused directly from the waweb bundle:** all chat/UI/business logic, the Signal protocol orchestration, presence/receipts/notifications classes — exactly as in the native client (the native side only handles `iq`/`success`/`failure` and delegates everything else to JS, per the networking doc). The Electron port's real work is (1) emulating the `chrome.webview.hostObjects.*` bridge namespace with the same method names, and (2) re-implementing the `WhatsAppNative` primitives (crypto/SQLite/media/VoIP) as Node native modules.

**Primary risks/gaps:**
1. The bundle gates native features on `window.chrome.webview.hostObjects.*` existing — Electron's `contextBridge` exposes a *different* global, so you must either shim that exact path in a preload or fork/patch the bundle.
2. The `ClientKeyBridge`/`ServerEncKeySaltBridge` carry the account master key across the boundary; you must reproduce the at-rest crypto (DPAPI→libsecret/`safeStorage`) — a security-critical mapping (see storage/crypto docs).
3. Code Verify binary transparency cannot be honored 1:1 on Electron and should be dropped.
4. Push-driven wake (WNS) has no Linux equivalent; rely on a persistent connection instead.

---

## 6. Open Questions / Unverified

Each item below was **re-investigated this session** against the C# dump, the MSIX manifest, and the shipped native binaries (`objdump -p` import tables + `strings` on `x64/WhatsAppNative.dll` / `WhatsAppRust.dll` / `msquic.dll`); every item is now prefixed with its verdict and the concrete evidence, with the original question preserved.

1. **[RESOLVED] WindowsAppRuntime bootstrap.** *Original question: no explicit `MddBootstrap.Initialize`/`Bootstrap.TryInitialize` call was found in `Program.Main`; `Microsoft.WindowsAppRuntime.Bootstrap(.Net).dll` is shipped, but its invocation (if any) was not located.* An exhaustive grep across the entire decompiled tree for `MddBootstrap` / `Bootstrap.(Try)Initialize` / runtime `DynamicDependency` finds **no runtime bootstrap call at all**: the only `[DynamicDependency]` hits are AOT-trimming *attributes* on `WhatsApp.Root/WinRT/RcwFallbackInitializer.cs:18-47` (Win2D `Canvas*` effect types), and the only `TryInitialize` symbol is an unrelated `Dispatcher` extension method (`WhatsApp.Tools/DispatcherExtensions.cs:8`, called at `App.cs:114,:237,:548`). Because this is a **packaged** MSIX that declares `Microsoft.WindowsAppRuntime.1.6` as a framework `<PackageDependency>` (`AppxManifest.xml:21`), the OS loader resolves the framework at launch and the `Bootstrap*.dll` (shipped only for the *unpackaged* path) is never invoked from `Program.Main`. Folded into §3.1.
2. **[RESOLVED] WhatsAppRust.dll surface.** *Original question: it ships with its own `.pri` but has no `ActivatableClass` entry, so its load path is unconfirmed.* `objdump -p x64/WhatsAppNative.dll` lists `DLL Name: WhatsAppRust.dll` and statically imports **24 named C-ABI functions** from it (`openMp4TrackRemover`, `openMp4Repair`, `doRepairMp4File`, `muxAVStreams`, `demultiplexSelectedStreams`, `extractAVStreams`, `examineMediaFile`, `applyWAanimatedGIFtag`, `createForensicEvidence`, `removeMp4Tracks`, `mp4ErrorCodeToString`, `setFileHandlingCallback`, …) [native-binary] — so it is a **load-time import of `WhatsAppNative.dll`**, not a standalone WinRT server. `strings -n 8 x64/WhatsAppRust.dll` leaks Meta **wamedia** Rust source paths [native-binary] (`xplat\whatsapp\wamedia\rust\libwamediastreams-rs\src\h2645\h264\...`, `...\mp4operations\libmp4operations-rs\src\mp4repairshop.rs`), confirming it is the media stream-parsing / MP4-operations engine. It exposes a flat C FFI surface (no WinRT `ActivatableClass`), which is exactly why it is absent from the manifest registry. Folded into §3.11 / §4.
3. **[RESOLVED] `msquic.dll` consumer.** *Original question: present but not referenced by packaging/activation code; whether it backs the chat socket, WebView2, or media is unconfirmed.* The QUIC consumer is the **Chromium/WebView2 (HTTP/3) layer**, used by the JS bundle's **WebTransport-based VoIP relay**, not by any native WhatsApp DLL. Evidence chain:
   - **No shipped WhatsApp/WebView2 binary imports it [native-binary].** `objdump -p` *and* `rabin2 -i` (delay-load) over `WhatsAppNative.dll`, `WhatsAppRust.dll`, `WhatsApp.Networking.dll`, `WebView2Loader.dll`, and `Microsoft.Web.WebView2.Core.dll` show **0 `msquic` imports** (static or delay-load) in every one; a full scan of all `x64/*.dll`/`*.exe` finds the only binary naming `msquic` is `msquic.dll` itself (a self-reference). `rabin2 -l WhatsAppNative.dll` / `WhatsApp.Networking.dll` show no msquic library link.
   - **`msquic.dll` exports exactly two symbols, `MsQuicClose` (ordinal 1) and `MsQuicOpenVersion` (ordinal 2) [native-binary]** (`objdump -p` and `rabin2 -E` — only the MsQuic C-ABI entry points), is a genuine **Microsoft Corporation code-signed** standalone MsQuic redistributable **fileVersion 2.4.8.0** (`WhatsApp.Root.deps.json` → `"msquic.dll": {"fileVersion":"2.4.8.0"}`; signer chain `Microsoft Code Signing PCA 2011` in `strings`), and carries only MsQuic-internal strings (`MsQuicLib.Loaded`, `MsQuicLib.OpenRefCount == 0`, `System\CurrentControlSet\Services\MsQuic\Parameters\`). It pulls in `secur32/sspicli/iphlpapi/ws2_32/crypt32` — a normal QUIC stack, with no WhatsApp linkage.
   - **The native chat socket is plain TCP, not QUIC [decompiled-C#].** `WhatsApp.Networking/WhatsApp/ChunkedHttpSocket.cs:214` sends `POST /chat HTTP/1.1\r\nHost: c.whatsapp.net … Transfer-Encoding: chunked` over a TCP `ISocket` — HTTP/1.1 chunked, no QUIC. The only C# `http3` token in the whole dump is a **WAM telemetry enum** value `HttpProtocolVersionType.Http3` (`WhatsApp.Core/WhatsApp/Wam.cs:11364-11372`), i.e. an analytics label, not a transport.
   - **The actual QUIC user is the bundle's WebTransport relay [bundle].** `research/waweb-unmin/a5gdgRhdCri.js:4095` defines `WAWebVoipWebTransportConnectionManager`, which uses the browser-native **`self.WebTransport`** API (`:4101`) to connect to `https://<relay>:<port>/webtransport` (`:4130`) and read/write QUIC **datagrams** (`:4204`, `i.datagrams.writable.getWriter()`). `WebTransport` is implemented inside Chromium and runs over **HTTP/3 (QUIC)** — that Chromium/Edge runtime is precisely what links MsQuic.
   - **Cross-ref rules out QUIC in the signalling/chat path [protocol-cross-ref].** Neither `whatsmeow/socket/` nor `Baileys/src/Socket/` contains any QUIC/HTTP3/WebTransport in the chat-socket layer (the only "quic" hit is `QuickReply`); the protocol's chat transport is Noise-over-TCP/WebSocket. So MsQuic cannot be the chat socket.
   The "quic" hits inside `WhatsAppNative` remain `quickhd` / `pli_quic` (a video-quality feature), unrelated. **Conclusion:** `msquic.dll` is shipped as a dependency of the WebView2/Edge Chromium runtime, consumed only when the JS VoIP layer opens a `WebTransport` (HTTP/3) relay connection — confirmed by the bundle's WebTransport manager plus the negative native import scan. Folded into §3.6 and §4.
4. **[RESOLVED] `-RegisterForBGTaskServer` argument.** *Original question: the push COM ExeServer passes `-RegisterForBGTaskServer /nowindow /pushnotification`; the `-RegisterForBGTaskServer` branch handler was not located.* The premise that "no readable managed code" backs this launch is wrong — the COM/background-task server that this ExeServer registration exists to host **is fully implemented in readable C#**, and the launch maps directly onto it. The manifest (`AppxManifest.xml:112-113`) declares the ExeServer `Executable="WhatsApp.Root.exe" Arguments="-RegisterForBGTaskServer /nowindow /pushnotification"` whose `<com:Class Id="082f08a8-6f51-4fa3-9a14-7563c83d7c49">` is **exactly** `PushNotificationBackgroundTask`'s `[Guid("082f08a8-6f51-4fa3-9a14-7563c83d7c49")]` (`WhatsApp.Background/PushNotificationBackgroundTask.cs:11`) — the manifest comment at `:109` even states "CLSID must match PushNotificationBackgroundTask.cs". The chain:
   - At startup `App()` unconditionally calls `PushNotificationBackgroundTask.Register(out _pushNotificationBackgroundRegistrationToken)` (`App.cs:123`).
   - `Register` (`PushNotificationBackgroundTask.cs:19-31`) calls `ComServer.CoRegisterClassObject(ref classId, new ComServer.PushNotificationBackgroundTaskClassFactory(), CLSCTX_LOCAL_SERVER=4, REGCLS_MULTIPLEUSE=1, out token)` (`ComServer.cs:74`), making this `WhatsApp.Root.exe` process the **out-of-process COM server** for that exact CLSID.
   - The class factory's `CreateInstance` (`ComServer.cs:30-44`) returns `MarshalInterface<IBackgroundTask>.FromManaged(new PushNotificationBackgroundTask())`; the task's `Run()` (`PushNotificationBackgroundTask.cs:33-37`) writes to the unbounded `PushReceivedChannel`, consumed by `SubscribeToPushNotificationFromBackgroundTask` → `HandlePushNotification()` (`App.cs:215-225`).
   - `~App()` calls `ComServer.CoRevokeObject(out var registrationToken)` to tear the registration down (`App.cs:156`).
   - `BackgroundTaskHelper.RegisterPushTask` registers the `PushNotificationTrigger` against the same CLSID via `SetTaskEntryPointClsid(typeof(PushNotificationBackgroundTask).GUID)` (`BackgroundTaskHelper.cs:54`).
   So the OS launches `WhatsApp.Root.exe -RegisterForBGTaskServer /nowindow /pushnotification` to spin up the push COM server, and the server it activates is `PushNotificationBackgroundTask`, all in readable managed code. The **only** part not matched in C# is the **literal token string** `-RegisterForBGTaskServer`: `Program.cs` parses command-line args only for `/pushnotification` (`Program.cs:45`), and `App.OnLaunched`/`OnActivated` test only `/pushnotification` / `/nowindow` — the `-RegisterForBGTaskServer` token is not branched on by name (it is effectively a descriptive marker for this ExeServer launch; the COM registration is unconditional at `App.cs:123` regardless of the token). The separate, in-process `Microsoft.Windows.ApplicationModel.Background.UniversalBGTask.dll` (declared at `AppxManifest.xml:104`,`:149-150`, and not shipped in `x64/`) is the WinRT background-task host plumbing — a red herring for *this* argument, which is served by `WhatsApp.Root.exe` itself. Folded into §3.7.
5. **[RESOLVED] `LaunchAndActivationPermission` SDDL.** *Original question: the SDDL `O:PSG:BUD:(A;;11;;;IU)(A;;11;;;S-1-15-2-1)S:(ML;;NX;;;LW)` (verbatim from `AppxManifest.xml:112`) was read but not decoded against actual launch behavior.* Fully decoded in §3.7 (`AppxManifest.xml:112`): owner `PS` = running principal, group `BU` = `BUILTIN\Users`; the DACL grants mask `0x11` = `COM_RIGHTS_EXECUTE | COM_RIGHTS_ACTIVATE_LOCAL` to **`IU` (Interactive Users)** and to **`S-1-15-2-1` (`ALL APPLICATION PACKAGES`)**; the SACL `(ML;;NX;;;LW)` is a **Low** mandatory-integrity label with `NO_EXECUTE_UP`. Net behavior: the interactive user and any AppContainer (the sandboxed WebView2 renderer) may launch/locally-activate the push COM server, reachable down to Low integrity — deliberately broad so OS push infra and the renderer can both reach it. See §3.7.
6. **[RESOLVED] `ToastActivatorCLSID` vs. WinUI single-instance.** *Original question: how a toast COM activation (`bebd6a5e-…`) coexists with `AppInstance` redirection, especially the cold-start case.* Both paths are now traced in §3.10. **Cold start:** the toast server launches `WhatsApp.Root.exe` with `Arguments="----AppNotificationActivated:"` (no `/pushnotification`), so `DecideRedirection` returns `false` (`Program.cs:40-52`), the process becomes the primary `AppInstance`, and `OnLaunched` reads `AppNotification` via `GetActivatedEventArgs()` → `HandleNotificationActivation` (`App.cs:241-244`). **Already-running:** the second process redirects via `RedirectActivationToAsync` (`Program.cs:48`) and the primary's `OnActivated` dispatches the same `AppNotification` kind (`App.cs:544,:561-565`). See §3.10.
7. **[RESOLVED] VoIP/message toast scenario specifics.** *Original question: looping ringtone and `ToastScenario.IncomingCall` came from the inventory; the toast-builder source was not re-read.* `WhatsApp.Notifications/VoipToastController.cs` was re-read this session: it uses the **legacy** `ToastNotificationManager.CreateToastNotifier()` (`:37`) and builds the incoming-call toast with `Scenario = ToastScenario.IncomingCall` (`:219`), `Audio.Src = new Uri("ms-appx:///Sounds/whatsapp_windows_ringtone_02.m4a")` (`:222`), `Loop = true` (`:223`), with history dismissal by `VoipToastIncomingTag`/`VoipToastGroup` (`:166`). Message toasts instead use the App SDK `AppNotificationManager.Default` (`NotificationsManager.cs:48-50`). See §3.10.
8. **[RESOLVED] CsWinRT projection internals of `DispatchAdapter.WrapObject`.** *Original question: how exactly the C# object becomes a JS-callable host object — taken at the interface level; the ABI marshalling in `ABI.WinRTAdapter/` was not line-traced.* The managed side was already confirmed: `WinRTAdapter.DispatchAdapter` is a CsWinRT-projected runtime class whose native instance is activated via `IActivationFactoryMethods.ActivateInstanceUnsafe(…, IDispatchAdapterMethods.IID)` (`DispatchAdapter.cs:81`), implements `Microsoft.Web.WebView2.Core.ICoreWebView2DispatchAdapter` (`:19`, native objref via `NativeObject.As<IUnknownVftbl>(ICoreWebView2DispatchAdapterMethods.IID)`, `:75`), and `WrapObject(object, ICoreWebView2DispatchAdapter)` (`:146-149`) plus `WrapNamedObject(string, …)` (`:141-143`) are thin forwarders to `ICoreWebView2DispatchAdapterMethods.WrapObject/WrapNamedObject` over that interface. **This session the native body in `WinRTAdapter.dll` was disassembled [native-binary]**, closing the gap:
   - `WinRTAdapter.dll` is a **native C++/WinRT PE32+** (`rabin2 -I`: `bintype pe`, `class PE32+`, `lang msvc`), exporting only the two WinRT C-ABI entry points `DllGetActivationFactory` (export-table RVA `0x180001b30`) + `DllCanUnloadNow` (export-table RVA `0x180001a60`) (`objdump -p` / `rabin2 -E`) [native-binary]. From its `DllGetActivationFactory` export the activation path runs through an internal factory-dispatch body (distinct from the `0x180001b30` export-table entry) that selects by class index into the per-class factory table — standard C++/WinRT factory wiring. (The exact internal-body RVA and the dispatch opcode are not corroborated by the cheap export-table/strings evidence and would require full disassembly to pin down.)
   - Its embedded **PDB path is `D:\full-fbsource\whatsapp\windows\Samples\WinUI\WebView2\WinRTAdapter\x64\Release\WinRTAdapter\WinRTAdapter.pdb`** — i.e. WinRTAdapter is generated by **Microsoft's WebView2 WinUI `wv2winrt` sample/tool**, not hand-written. This is the canonical "host-object dispatch adapter" generator.
   - The marshalling engine is the **`wv2winrt_impl` namespace** (demangled C++/WinRT type symbols in the binary). The real implementation class `WinRTAdapter::implementation::DispatchAdapter` `implements UICoreWebView2DispatchAdapter` (the same interface the C# projection targets). The per-object wrapper is **`wv2winrt_impl::DispatchBase`, which `implements IDispatch + IInspectable + ICoreWebView2PrivateDispatchContainer{,2,3,4}`** — so `WrapObject` turns each C# adaptee into a classic OLE-Automation **`IDispatch`** object exposed through WebView2's *private* dispatch-container ABI (`ICoreWebView2PrivateDispatchContainer*`), which is exactly the protocol behind `window.chrome.webview.hostObjects.<name>`. Async results are carried by **`wv2winrt_impl::DispatchAsyncResult`**, which `implements ICoreWebView2PrivateDispatchAsyncResult{,2}` + `…AsyncInfo` + `…AsyncFinishedHandler` (so async bridge methods surface as JS promises).
   So the full path is: C# `WrapObject` → native `ICoreWebView2DispatchAdapter::WrapObject` (in `WinRTAdapter.dll`) → constructs a `wv2winrt_impl::DispatchBase` `IDispatch` proxy over the WinRT object → handed to WebView2's `AddHostObjectToScript`, which vends it as an `IDispatch` host object under `chrome.webview.hostObjects.<name>`; method calls cross back through `ICoreWebView2PrivateDispatchContainer` to the WinRT vtable. The mechanism is **IDispatch-over-WinRT generated by `wv2winrt`** — no remaining unknowns at the architecture level. Folded into §3.11.
