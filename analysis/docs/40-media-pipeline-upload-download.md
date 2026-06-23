# 40. Media Pipeline: Upload, Download & Transcoding

> Target: Meta native **WhatsApp for Windows** (`WhatsApp.Root.exe`, WinUI 3 / Windows App SDK, hybrid WebView2 + native). All `path:LINE` citations are **relative to `decompiled_source/`** and were read directly from the decompiled C# and the CsWinRT native projection. The pre-canned Ghidra *export* of `WhatsAppNative.dll` is empty (`ghidra-output/WhatsAppNative-functions.txt` is 0 bytes), but the native binary itself is **not** unreadable: it is statically analyzable via `strings`/`objdump` (used throughout §4/§6) and via radare2 instruction-level disassembly — doc 96 demonstrates radare2 reading native bodies out of these same binaries (e.g. X25519 constants, the SQLite codec callees). For this doc that disassembly was not run on the transcoder bodies, so any claim about their *internal* encode constants is marked **inferred** until pinned (see §6).

## 1. Purpose & Scope

This document covers the **media pipeline** of the native client: how images/videos/audio/documents are **transcoded** before send, how they are **downloaded** from the `mmg.whatsapp.net` CDN and **saved/cached** on disk, and how **profile pictures** are surfaced. It is deliberately scoped to the *native* responsibilities. §3.7 additionally documents the **MMS-retry (media-retry) protocol** — the receiver-initiated "I couldn't fetch/decrypt this media, please re-upload" flow — and where per-message E2E decryption failures surface; that protocol lives almost entirely in the JS bundle, with only a token-table entry and a *VoIP-only* native `DecryptionFailureEvent` on the C#/native side.

The single most important architectural fact, confirmed below from code: **the native side does NOT do media end-to-end encryption, does NOT compute the `mediaKey`/HKDF media keys, and does NOT itself issue the HTTP upload/download to `mmg.whatsapp.net`.** Those live in the WhatsApp Web JS bundle running inside WebView2. The native client provides four narrowly-scoped media services exposed as WebView2 host objects:

| Bridge (JS host object) | Native class | Responsibility |
| --- | --- | --- |
| `MediaTranscodingBridge` | `MediaTranscodingService` | Video transcode + thumbnail/preview-frame extraction, over a **WebView2 shared-memory buffer** |
| `MediaFilesBridge` | `MediaFilesService` | Intercept WebView2 downloads, route to a `transfers/` folder, **hash-verify**, cache, copy-to-clipboard, bulk/zip save |
| `PicturesBridge` | `PicturesManager` | Profile-picture URL cache + validity check between native contacts DB and JS |
| (implicit) `MediaDownloadManager` | `MediaDownloadManager` | Hooks `CoreWebView2.DownloadStarting` so JS-initiated downloads land where native wants them |

Registration of all four is in `WhatsApp.Root/WhatsApp/AppModel.cs` (see §3.0). The heavy lifting (demux/transcode/remux/codec-detect/frame-grab) is delegated to native WinRT classes in `WhatsAppNative.dll`: `Transcoder`, `Mp4Utils`, `VideoUtilsMp4`/`VideoUtilsGif`, `OpusAudioSource`, `AmrAudioSource`, `Resampler`, `Mp4MediaType`, `Mp4TrackRemover`. There is also a Media-Foundation **UWP** fallback transcoder.

The actual container/stream demux/mux/repair/detection inside `WhatsAppNative.dll` is in turn backed by a Rust library shipped as **`x64/WhatsAppRust.dll`** (`xplat\whatsapp\wamedia\rust\…` per its embedded panic paths) — the **wamedia** stack: `libwamediadetection-rs` (file-type/RIFF detection), `libwamediastreams-rs` (stream *parsers* for H.264/H.265, Opus/AMR/MP3/FLAC/Vorbis/Speex/Theora/QCELP), and `libmp4operations-rs` (`mp4demux`/`mp4extraction`/`mp4muxchunker`/`mp4repairshop`/`mp4forensics`, incl. EDTS/ELST box removal). It is a **parse/demux/mux/repair/detect** library only — it carries **no encoder** and no transcode bitrate/resolution ladder (every `bitrate`/`sample_rate`/`channels` token in it is a header *field name* being parsed out of input, e.g. the Speex/Vorbis/Opus identification-header structs, not an encode constant). [native-binary] Encoding proper stays in `WhatsAppNative.dll` (OpenH264 video, MF Sink Writer AAC + isom mux; §3.1.4, §6 items 1/5).

## 2. Where It Lives

Concrete files / namespaces (relative to `decompiled_source/`):

**Managed orchestration (`WhatsApp.Root`)**
- `decompiled/WhatsApp.Root/WhatsApp.SystemIntegrations/MediaTranscodingService.cs` — `IMediaTranscodingBridgeToNative` impl; shared-buffer transcode + preview frame.
- `decompiled/WhatsApp.Root/WhatsApp.SystemIntegrations/MediaFilesService.cs` — `IMediaFilesBridgeToNative` impl; download intercept target, cache DB, hash verify, clipboard, zip/bulk save.
- `decompiled/WhatsApp.Root/WhatsApp.SystemIntegrations/MediaDownloadManager.cs` — WebView2 `DownloadStarting`/`StateChanged` hook.
- `decompiled/WhatsApp.Root/WhatsApp/MediaTranscoder.cs` — `internal` top-level transcode strategy (UWP-then-native chaining, size gate).
- `decompiled/WhatsApp.Root/WhatsApp/NativeTranscodeWrapper.cs` — `ITranscoder` over native `WhatsAppNative.Transcoder`; demux→audio→video→mux.
- `decompiled/WhatsApp.Root/WhatsAppCommon.Media.Transcode/UwpTranscodeWrapper.cs` — `ITranscoder` via Media Foundation `Windows.Media.Transcoding.MediaTranscoder`.
- `decompiled/WhatsApp.Root/WhatsApp/CodecDetector.cs` — container/codec detection, transcode-support classification, audio magic-byte sniffing.
- `decompiled/WhatsApp.Root/WhatsApp/DemuxResult.cs` — temp-dir AV demux via `Mp4Utils.ExtractAVStreams`.
- `decompiled/WhatsApp.Root/WhatsApp/Mp4UtilsExtensions.cs` — framerate probe, `CheckAndRepair`, exif-strip, stream-metadata helpers.
- `decompiled/WhatsApp.Root/WhatsApp/VideoUtils.cs` — managed `IVideoUtils` dispatching GIF vs MP4 to native.
- `decompiled/WhatsApp.Root/WhatsApp/MediaTranscoder.cs`, `WhatsApp/TranscodeSupportLevel.cs`, `WhatsApp/TranscoderType.cs`, `WhatsAppCommon.Media.Transcode/{TranscodeMediaType,TranscodeReason}.cs` — enums.
- `decompiled/WhatsApp.Root/WhatsApp.Bridge/PicturesManager.cs` — `IPicturesBridgeToNative` impl.

**Bridge interfaces (`WhatsApp.Root/WinRTAdapter`)**
- `IMediaTranscodingBridgeToNative.cs`, `IMediaTranscodingBridgeToWeb.cs`, `IMediaFilesBridgeToNative.cs`, `IPicturesBridgeToNative.cs`, `IPicturesBridgeToWeb.cs` + generated `*Bridge.cs` CCW shims.

**Storage (`WhatsApp.VoIP`)**
- `decompiled/WhatsApp.VoIP/WhatsApp/SqliteMediaFilesStorage.cs` — `mediaDownloads.db` (schema v2, table `CompletedDownloads2`).
- `decompiled/WhatsApp.VoIP/WhatsApp/MediaStorage.cs` — path/URI normalization, IsoStore vs KnownFolder routing.
- `decompiled/WhatsApp.VoIP/WhatsApp/NativeMediaStorage.cs`, `IsoStoreMediaStorage.cs`, `WaMediaPathId.cs` — `IMediaStorage` impls.
- `decompiled/WhatsApp.VoIP/WhatsApp/NativeInterfaces.cs` — lazy native-class factory.

**MMS-retry / decryption-failure (§3.7)**
- `decompiled/WhatsApp.Protobuf/WhatsApp.GProtoBuf/MediaRetryNotification.cs` + `ServerErrorReceipt.cs` + `MmsRetryReflection.cs` (`mms_retry.proto`, package `WhatsApp.ProtoBuf`).
- `decompiled/WhatsApp.Protobuf/WhatsApp.ProtoBuf/MediaRetryNotification.cs` (SilentOrbit mirror).
- `decompiled/WhatsApp.DataModels/WhatsApp.Data/PersistentAction.cs` — `SendMediaRetryServerError` durable job (`:49`).
- `decompiled/WhatsApp.Networking/WhatsApp/WAPDefaultTokenDictionary.cs` — binary-node tokens `mediaretry` (`:96`), `direct_path` (`:27`), `mms4_*_encryption_enabled` (`:59`).
- `decompiled/WhatsAppNativeProjection/WhatsAppNative/DecryptionFailureEvent.cs` (+ `__IDecryptionFailureEventPublicNonVirtuals.cs`) — **VoIP-only** native event (§3.7.5); dispatched in `WhatsApp.VoIP/WhatsApp/VoipCallbacks.cs:487`.
- `waweb-source-bundle/` JS modules: `WAWebHandleMediaRetryNotification`, `WAWebRequestMediaReuploadManager`, `WAWebCryptoMediaRetry` (`xTiXmyjNEd_.js`), `WAWebProtobufsMmsRetry.pb` — the live protocol.

**Native projection (`WhatsAppNativeProjection/WhatsAppNative`)**
- `Transcoder.cs` + `__ITranscoderPublicNonVirtuals.cs` (IID `55C1BC99-…`).
- `Mp4Utils.cs` + `__IMp4UtilsPublicNonVirtuals.cs` (IID `F2261EE6-…`).
- `Mp4MediaType.cs`, `Mp4VideoStreamType.cs`, `Mp4AudioStreamType.cs`, `Mp4AudioSubType.cs`, `MediaContainerType.cs`, `TranscoderContainerType.cs`, `SoundPlaybackCodec.cs`.
- `OpusAudioSource.cs`/`__IOpusAudioSourcePublicNonVirtuals.cs` (IID `1B3F4377-…`), `AmrAudioSource.cs`/`__IAmrAudioSourcePublicNonVirtuals.cs` (IID `C87B4487-…`), `Resampler.cs`/`__IResamplerPublicNonVirtuals.cs` (IID `2918312B-…`), `VideoUtilsMp4.cs`, `Mp4TrackRemover.cs`.

**Native binaries (`x64/`, not in the C# dump — read via `strings`/`objdump`)**
- `x64/WhatsAppNative.dll` (12.5 MB) — the in-process WinRT media classes (`Transcoder`, `Resampler`, `WaMaxEdgeTransform`, …); statically links **Cisco OpenH264 (Wels)** for video encode and imports **Media Foundation** (MFPlat/MFReadWrite) for AAC encode + isom mux (§6 items 1/5).
- `x64/WhatsAppRust.dll` (1.1 MB) — the **wamedia** Rust library (`xplat\whatsapp\wamedia\rust\…`: `libwamediadetection-rs`/`libwamediastreams-rs`/`libmp4operations-rs`) backing the demux/mux/repair/detect; **parse/mux only, no encoder** (§1).

**Manifest / JS bundle**
- `x64/AppxManifest.xml` — registers `WhatsAppNative.{Transcoder,Mp4Utils,VideoUtilsMp4,OpusAudioSource,AmrAudioSource,Resampler,Mp4MediaType,Mp4TrackRemover}` and `WinRTAdapter.{MediaFilesBridge,MediaTranscodingBridge,PicturesBridge}` as in-process activatable classes (confirmed via grep).
- `waweb-source-bundle/*.js` — holds `mediaKey` (577 occurrences) and the HKDF info strings `WhatsApp Image Keys` / `WhatsApp Video Keys` / `WhatsApp Audio Keys` / `WhatsApp Document Keys`, plus `mmg.whatsapp.net` / `mmg-fallback.whatsapp.net` (confirmed via grep).

## 3. How It Works

### 3.0 Bridge registration (the JS↔native seam)

After login, `AppModel.SetWebView` constructs the transcoding service and registers all media host objects through one shared `DispatchAdapter`:

```csharp
_mediaTranscodingService = new MediaTranscodingService(_webView);
MediaDownloadManager.StartHandlingMediaDownloads(webView);
DispatchAdapter dispatchAdapter = new DispatchAdapter();
...
webView.AddWinRTBridge("PicturesBridge",          new PicturesBridge(_pictures),                    dispatchAdapter);
webView.AddWinRTBridge("MediaFilesBridge",        new MediaFilesBridge(MediaFilesService),          dispatchAdapter);
webView.AddWinRTBridge("MediaTranscodingBridge",  new MediaTranscodingBridge(_mediaTranscodingService), dispatchAdapter);
```
— `WhatsApp.Root/WhatsApp/AppModel.cs:215`, `:226`, `:228`, `:229`. The JS reaches them as `window.chrome.webview.hostObjects.{PicturesBridge,MediaFilesBridge,MediaTranscodingBridge}`. `MediaFilesService` is created earlier and wired to the download manager: `MediaFilesService = new MediaFilesService(_loginSessionManager); ... MediaDownloadManager = new MediaDownloadManager(MediaFilesService);` (`AppModel.cs:151`, `:154`).

All native media classes are bootstrapped lazily through `NativeInterfaces`, which calls `new WhatsAppNativeInit().Setup()` once on first use (`WhatsApp.VoIP/WhatsApp/NativeInterfaces.cs:47-61`). `Mp4Utils` is a process-singleton (`NativeInterfaces.cs:29`); `Transcoder`/`VideoUtils` are created per-job via `NativeInterfaces.CreateInstance<T>()` (`NativeInterfaces.cs:38`).

---

### 3.1 Upload (send) path — transcoding over a shared buffer

The send-side data flow is **zero-copy via a WebView2 shared buffer**. JS owns the raw source bytes; native transcodes in place to a second shared buffer.

#### 3.1.1 Bridge surface

`IMediaTranscodingBridgeToNative` (`WinRTAdapter/IMediaTranscodingBridgeToNative.cs`, IID `E8417FE7-5777-5710-8EC6-18AC9EA21DF3`):

```
void RequestSharedBufferForTranscoding(long requestId, long bufferSize)   // [Obsolete]
IAsyncOperation<bool> TryRequestSharedBufferForTranscodingAsync(long requestId, long bufferSize)
IAsyncOperation<bool> GetVideoPreviewFrameFromSharedBuffer(long sourceBufferId, long resultBufferId)
IAsyncOperation<bool> PerformVideoTranscodingFromSharedBuffer(long sourceBufferId, long resultBufferId, long maxResultSize)
void CancelVideoTranscoding(long sourceBufferId)
void ReleaseSharedBuffer(long bufferId)
void Subscribe(IMediaTranscodingBridgeToWeb web)
```
The only **callback** to web is progress: `IMediaTranscodingBridgeToWeb.OnProgressChanged(ProgressInfo)` (`WinRTAdapter/IMediaTranscodingBridgeToWeb.cs:12`, IID `57B0054B-…`). JS wires this **once at bridge construction**: the `WindowsHybridBridgeMediaTranscoder_v*` wrapper (built with `hostObjects.MediaTranscodingBridge`) runs `this.$1.addEventListener("onProgressChangedEvent", this.$6), this.$1.subscribe(null)` (`U2j2EhR17gV.js`) — a single `subscribe(null)` at init, with the `IMediaTranscodingBridgeToWeb` implicitly supplied by the host-object projection (§6 item 7).

#### 3.1.2 Shared-buffer lifecycle (`MediaTranscodingService.cs`)

1. **Allocate.** JS calls `TryRequestSharedBufferForTranscodingAsync(requestId, bufferSize)`. Native bounds-checks `bufferSize ≤ 2 GB` (`MaxBufferSize = 2147483648L`, `MediaTranscodingService.cs:41`, `:233`), creates a `CoreWebView2SharedBuffer` via `_webView2.Environment.CreateSharedBuffer(bufferSize)` keyed by `requestId` in `_sharedBuffers` (`:322-330`), and posts it back **read-write** to JS via `PostSharedBufferToScript` so JS can fill it with source bytes (`SendSharedBuffer`, `:332-343`). The JSON envelope attached carries `Source="MediaTranscodingService"`, `BufferId`, `Size` (`:338-341`).
2. **Transcode.** JS fills the source buffer then calls `PerformVideoTranscodingFromSharedBuffer(sourceBufferId, resultBufferId, maxResultSize)` (`:249`). Native:
   - dumps the source shared buffer to a temp file under `LocalFolder\transcode\source_<unixMillis>.mp4` (`SaveSharedBufferAsTempFile` → `SaveStreamAsTempFile`, `:352-374`, default ext `.mp4`),
   - runs `MediaTranscoder.StartTranscoding(sourceFilePath, maxResultSize, progressReporter, ct)` (`:271`),
   - on success reads the output file back into a **new** `resultBufferId` shared buffer (`CreatedSharedBufferFromFile`, `:376-393`) and posts it **read-only** to JS (`:280`),
   - deletes both temp files in `finally` (`:288-318`).
   - A per-`sourceBufferId` `CancellationTokenSource` is stored in `_cancellationTokens` (`:261-265`); `CancelVideoTranscoding` cancels and removes it (`:82-88`).
3. **Progress.** `MediaTranscodingProgressReporterAdapter.OnProgress(pct)` forwards `ProgressInfo.Create(sourceBufferId, percentage)` over `_bridgeToWeb.OnProgressChanged` (`:33-39`).
4. **Release.** JS calls `ReleaseSharedBuffer(bufferId)`; native disposes the `CoreWebView2SharedBuffer` (`:90-98`).

The raw shared buffer is read in native as an `UnmanagedMemoryStream` over `IMemoryBufferByteAccess::GetBuffer` (COM IID `5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D`, `:25-31`, `:345-350`).

#### 3.1.3 Transcode strategy (`MediaTranscoder.StartTranscoding`)

`MediaTranscoder` (`WhatsApp.Root/WhatsApp/MediaTranscoder.cs`) is `internal` and holds two `ITranscoder` singletons: `NativeTranscodeWrapper` and `UwpTranscodeWrapper` (`:27-29`). `StartTranscoding` (`:31`):

1. `(level, transcoder) = await CodecDetector.GetTranscodeSupportLevel(sourceFilePath)` (`:37`).
2. `GetTranscodingReason(level, fileSize, maxMediaSize)` computes a `TranscodeReason` flag set: `BadCodec` (NeedsTranscode), `BadContainer` (NeedsRemux), `FileSize` (file > max) (`:73-89`). *(Result is computed but not used as a gate here — transcode runs regardless; the flags are diagnostic.)*
3. **If `TranscoderType.Uwp`** (native can't handle source): run the UWP/Media-Foundation transcoder **first** as a normalizing pass at half-progress weighting (`Coefficient=0.5`, then `Offset=50`), and feed its MP4 output into the native transcoder as the new source (`:42-56`).
4. Always run the **native** transcoder pass: `NativeTranscoder.ProcessTranscodeRequest(sourceFilePath, TranscodeMediaType.Video, progressAdapter, ct)` (`:57`).
5. **Size gate:** if the native output exists and `Length > maxResultSize`, return `TranscodingErrorCode.MediaTooLarge` (`:58-61`).
6. Intermediate UWP files are deleted in `finally` (`:64-70`).

`ProgressOffsetAdapter` linearly remaps child progress: `pct*Coefficient + Offset` (`:15-25`) so the two passes report a single 0–100 stream.

#### 3.1.4 Native transcode wrapper (`NativeTranscodeWrapper.ProcessTranscodeRequest`)

Runs on `Deployment.Current.ThreadPool` (`NativeTranscodeWrapper.cs:52`). Output ext is `mp4` for video/gif, `m4a` for audio (`:59`); output temp path is `LocalFolder\transcode\transcode_native_<unixMillis>_.<ext>` (`:60-63`). Only `Video|Gif|ViewOnceVideo` and `Audio` are accepted (`IsVideoOrGif`, `:168-175`; else `InvalidMedia`, `:53-56`).

**Audio path** (`TranscodeToTempStorage` → `TranscodeAudioTask`, `:95-99`, `:177-215`):
- Open source via `NativeMediaStorage.OpenFile` (`:185-186`).
- `CodecDetector.DetectAudioCodec(stream)` (`:187`).
- **AAC passthrough:** if detected MIME is `audio/aac`, the file is copied verbatim — no re-encode (`:188-191`).
- Otherwise: build an `ISoundSource` for the detected codec (`CodecDetector.CreateSoundSource`), create a native `Transcoder`, `Initialize(video=null, soundSource, TranscoderContainerType_Mp4, destStream)`, and `Transcode(-1, progress)` — i.e. wrap the decoded audio into an MP4/M4A container (`:194-199`). `Transcoder` COM object is released in `finally` (`Marshal.ReleaseComObject`, `:208-212`).

**Video path** (`TranscodeToTempStorage`, `:101-148`):
1. Probe framerate: `Mp4UtilsExtensions.TryGetFramerate(filePath)` (`:105`).
2. **Demux** the source to extract the audio track only for `TranscodeMediaType.Video`: `using DemuxResult demux = await DemuxTask(...)`; if `demux.AudioTrackPath` is non-empty, transcode the audio track to a temp `.audio` file (`:111-122`).
3. **Transcode video** to a temp `.video` file: `TranscodeVideoTask(filePath, newVideoPath, progress, token)` (`:130`).
4. **Mux** audio+video back together if both exist: `NativeInterfaces.Mp4Utils.MuxAVStreams(newAudioPath, newVideoPath, destPath, startTime=0f, duration=-1f, frameRate)` (`:134`); else just copy the video-only output (`:138`).
5. Temp `.audio`/`.video` files erased in `finally` (`:144-147`).

`TranscodeVideoTask` (`:217-254`) is where the **downscale + container** policy is set:
- `transcoder.AddMaxEdgeTransform((uint)num)` where `num = 960` on a "decent memory device", clamped to `min(480, 960)=480` otherwise (`:229-234`, gated on `MachineSpec.Instance.IsDecentMemoryDevice`). So the longest edge is bounded to **960 px** (or **480 px** on low-memory machines). On the native side this is implemented by a discrete `WhatsAppNative::WaMaxEdgeTransform` class (RTTI `WaMaxEdgeTransform::OnMetadata`/`::Transform` in `WhatsAppNative.dll`); the binary holds **no literal 960/480 constant** — the edge bound is the runtime `(uint)num` argument passed from this C# call, so 960/480 is set in managed code, not baked into native. [native-binary] **This is the *only* native `Transcoder` transform the managed layer ever calls** — exhaustive grep finds no managed caller of `AddRotateTransform` or `AddClipRectangleTransform` anywhere in `decompiled/WhatsApp.Root/`, so exif-orientation/rotation is handled inside the native encoder (reading the source rotation matrix) or upstream in JS, never from C# (§6 item 6).
- Output container is always `TranscoderContainerType_Mp4` (`:235`; the enum has exactly one member, `TranscodeContainerType_Mp4`, `WhatsAppNative/TranscoderContainerType.cs`).
- `videoUtils = new VideoUtils(videoStream, rgb:false)` — managed wrapper that sniffs the first 3 bytes for the GIF magic `47 49 46` ("GIF") and routes to native `VideoUtilsGif` vs `VideoUtilsMp4` (`WhatsApp/VideoUtils.cs:70-85`, `:15-27`).
- `transcoder.Initialize(videoUtils, audio=null, Mp4, destStream); transcoder.Transcode(-1, progress)` (`:237-238`).

`CropAndMux` (`:157-166`) and `Mp4UtilsExtensions.RemoveExifData` (`Mp4UtilsExtensions.cs:82-87`) both implement metadata stripping by muxing a file onto itself via `MuxAVStreams(file, file, newFile, 0, -1, fps)`.

#### 3.1.5 UWP fallback transcoder (`UwpTranscodeWrapper`)

Media-Foundation path used only when native reports `Unsupported` (see §3.3). Fixed profile `MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Vga)` (`UwpTranscodeWrapper.cs:18`). `CanTranscode` does a dry `PrepareFileTranscodeAsync` against a throwaway temp file and reports `PrepareTranscodeResult.CanTranscode` (`:66-81`). Output: `LocalFolder\transcode\transcode_uwp_<unixMillis>.mp4` (`:126-133`). **Video only** — audio returns `InvalidMedia` (`:22-25`).

---

### 3.2 Download path — intercept, route, verify, cache

The native client does **not** fetch from `mmg`. JS performs the (encrypted) download/decrypt and then triggers a browser download of the **decrypted** bytes; native intercepts that download to control destination + verify integrity + cache it. **The JS trigger is a blob-URL anchor click** (confirmed in `TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js`): `window.URL.createObjectURL(blob)` → `document.createElement("a")` with `l.download = name`, `l.style.display="none"`, `appendChild`, then `l.click()`. That synthetic click is what `CoreWebView2.DownloadStarting` (§3.2.2) catches — after JS has pre-armed the destination via `prepareForMediaFileSaving(url, name, hash)`.

#### 3.2.1 Pre-arming a download (`MediaFilesService`)

`IMediaFilesBridgeToNative` (`WinRTAdapter/IMediaFilesBridgeToNative.cs`, IID `7A207F7F-…`) surface:

```
IsCachedMediaFileExist(hash, suggestedFileName)            -> bool
TryOpenCachedMediaFileFile(hash, suggestedFileName)        -> bool  (verifies hash, then Launcher.LaunchFileAsync)
PrepareForMediaFileSaving(url, suggestedFileName, hash)    -> void
WaitTillMediaDownloadCompletes(url, suggestedFileName, hash)
SelectFolderForBulkMediaSaving()                           -> string?
PrepareForZipArchiveSavingAndUnarchiveToFolder(url, targetFolder, archiveName, hash)
RequestFileSystemDirectoryHandle(directoryType)
TryCopyCachedMediaFile(hash) / TryCopyCachedMediaFiles(hash[])  -> bool  (clipboard)
```

Before triggering a download, JS calls `PrepareForMediaFileSaving(url, suggestedFileName, mediaFileHash)`. Native records two maps keyed by URL on a serial `ConcurrentQueueDispatcher` (`MediaFilesService.cs:262-275`):
- `_expectedDownloads[url] = (fileName, hashCode, targetFolder?)`
- `_downloadsInProgress[url] = (targetFolder?, TaskCompletionSource)`

For zip/bulk save, `PrepareForZipArchiveSavingAndUnarchiveToFolder` is the same call with a non-null `targetFolder` (`:122-125`).

#### 3.2.2 Intercepting the WebView2 download (`MediaDownloadManager`)

`StartHandlingMediaDownloads` subscribes to `CoreWebView2.DownloadStarting` and `IsDefaultDownloadDialogOpenChanged` (`MediaDownloadManager.cs:27-31`). On `OnDownloadStarting` (`:33-78`):
1. Open then suppress the default download dialog (`OpenDefaultDownloadDialog` then `IsDefaultDownloadDialogOpenChanged` → `CloseDefaultDownloadDialog`, `:36`, `:80-86`) — i.e. the native UI hides Chromium's download chrome.
2. `args.Handled = true` and ask `MediaFilesService.IsMediaFileDownloadExpected(uri)` (`:41-42`).
   - **Expected** (WhatsApp media): set `args.ResultFilePath` to the native-chosen path, record the hash in `_downloadsInProgress`, subscribe `OnAutomaticDownloadStateChanged` (`:43-51`).
   - **Unexpected** (e.g. user "save as"): pop a `FileSavePicker` (`SelectSaveFilePathAsync`, `:88-102`), cancel if user backs out, else subscribe `OnManualDownloadOperationStateChanged` (`:52-64`).
3. A 2 s safety net re-checks `IsPotentiallyCompleted` in case the `StateChanged` event was missed (`:66-77`). `IsPotentiallyCompleted` = state `Completed`, or `BytesReceived == TotalBytesToReceive`, or on-disk file length matches (`:131-150`).

`IsMediaFileDownloadExpected` pops `_expectedDownloads[url]`, derives the destination via `GetSuggestedFilePath`, and returns `(suggestedFilePath, hashCode)` (`MediaFilesService.cs:142-154`).

#### 3.2.3 Destination foldering (`MediaFilesService.GetSuggestedFilePath`)

- Root: per-session `transfers/` dir, posted to JS as a directory handle via `webView2.PostWebMessageWithDirectory(dir, "transfers")` (`:92-95`, also on-demand `RequestFileSystemDirectoryHandle`, `:277-293`).
- **Weekly bucket:** files go into `transfers\<year>-<weekOfYear>` where `weekOfYear = DayOfYear/7 + 1` zero-padded to 2 digits (`GetTransfersFolder`, `:402-420`).
- **Filename collision handling:** `GetSuggestedFileNames` yields the coerced name, then ` (1)`…` (1000)`, then a timestamped fallback `name_yyyyMMdd_HHmmss.ext` (`:371-387`); the first non-existent path wins (`:355-369`).
- **Filename sanitization:** `CoerceValidFileName` replaces `Path.GetInvalidFileNameChars()` with `_`, and rewrites Windows reserved device names (`CON,PRN,AUX,NUL,COM0-9,LPT0-9,CLOCK$`, incl. superscript variants `COM¹/²/³`, `LPT¹/²/³`) to `_reservedWord_` (`:28-34`, `:389-400`).

#### 3.2.4 Completion, hash verification, Mark-of-the-Web

`OnAutomaticDownloadStateChanged` → `MediaFilesService.RecordMediaDownloadCompleted(url, resultFilePath, mediaFileHash)` (`MediaDownloadManager.cs:104-119`, `MediaFilesService.cs:156-208`):
- **Simple media** (no targetFolder): add **Mark-of-the-Web** (`filePath:Zone.Identifier` ADS containing `[ZoneTransfer]\r\nZoneId=3\r\n`, `:561-574`) and record the completed download in `mediaDownloads.db` via `_downloadsDb.AddCompletedDownload(hash, path)` (`:164-173`).
- **Zip/bulk** (targetFolder set, `.zip` result): `ExtractZipToDirectory` with **zip-slip protection** (each entry's full path must start with the target folder prefix, else skipped, `:534-559`), Mark-of-the-Web on each file, delete the zip, fire `BulkSavingCompleted(targetFolder, count)` (`:175-200`, `:441-453`).
- Always completes the `TaskCompletionSource` so `WaitTillMediaDownloadCompletes` unblocks (`:202`, `:295-304`).

**Hash verification** (`VerifyFileHashAsync`, `:306-353`): SHA-256 of the file (`Utils.ComputeSha256Hash`) compared to `Convert.FromBase64String(mediaHash)`. **On mismatch the file is deleted and the DB record removed** — i.e. corrupt/poisoned downloads are not cached (`:316-339`). `IsCachedMediaFileExist`, `TryOpenCachedMediaFileFile`, and `TryCopyCachedMediaFile` all gate on this verification (`:215-260`, `:455-490`).

#### 3.2.5 Clipboard copy

`TryCopyCachedMediaFileInternal` (`:455-517`) verifies each cached file, builds a `DataPackage` with `SetStorageItems` (Copy op). For a **single image**, it additionally decodes the bitmap (`BitmapDecoder`) and registers a JPEG `StandardDataFormats.Bitmap` data provider (`:474-512`, `GetRandomAccessStreamReferenceFromSoftwareBitmap` re-encodes JPEG via `BitmapEncoder.JpegEncoderId`, `:519-526`). Image extensions recognized: `.jpg .jpeg .png .bmp .gif` (`:26`).

#### 3.2.6 Download cache DB (`SqliteMediaFilesStorage` → `mediaDownloads.db`)

- File: `sessionData.GetSessionLocalPath("mediaDownloads.db")`, encryption key = `_settings.Read(SettingsKey.LegacyDbSecret)` (per-session secret) (`MediaFilesService.cs:85-87`).
- Schema **v2** (`LatestSchemaVersion => 2`). Table `CompletedDownloads2(FileHash TEXT, FilePath TEXT, Extension TEXT, PRIMARY KEY(FileHash, Extension))` + index `idx_CompletedDownloads2_FileHash` (`SqliteMediaFilesStorage.cs:20-34`).
- **Migration v1→v2:** old `CompletedDownloads` rows are copied into `CompletedDownloads2`, computing `Extension` from the stored path, then the old table is dropped (`:45-73`).
- Lookup is **(hash, extension)**-keyed — `Extension` is lower-cased, dot-trimmed (`ExtractExtension`, `:176-188`). So the same media hash can be cached under multiple extensions. Insert is `INSERT OR REPLACE` (`AddCompletedDownload`, `:90-107`).

#### 3.2.7 Thumbnails / preview frames

`GetVideoPreviewFrameFromSharedBuffer(sourceBufferId, resultBufferId)` (`MediaTranscodingService.cs:105-184`):
- Dump source shared buffer to temp file, then `TryGetFrameFromVideoFile` (`:122`).
- Save the resulting `WriteableBitmap` as **JPEG quality 100** at full pixel dims into the result shared buffer, attaching `Width`/`Height` metadata, post read-only to JS (`:128-145`).

`TryGetFrameFromVideoFile` is a **3-tier fallback** (`:186-227`):
1. Native `VideoFrameGrabber(sourceFilePath, 0).ReadFrame(...)` (preferred).
2. `CompositionVideoFrameGrabber.GetVideoFrame(...)` with a 5 s timeout.
3. `MediaPlayerVideoFrameGrabber.GetVideoFrame(...)` (UWP `MediaPlayer`) with a 5 s timeout.

Framerate probing (`Mp4UtilsExtensions.TryGetFramerate`, `Mp4UtilsExtensions.cs:197-232`) similarly tries the native `VideoFrameGrabber.FrameInfo` first (`FrameRate/FrameRatePeriod`), then falls back to `Mp4Utils.GetStreamMetadataForPath(...).Video.Fps`.

---

### 3.3 Codec detection & transcode-support classification (`CodecDetector`)

`DetectMp4Codecs(path)` delegates to native `NativeInterfaces.Mp4Utils.ExtractStreamInformation(path)`, returning an `Mp4MediaType{ Container, VideoStreamType, AudioStreamType, AudioSubtype, FormatProblemsFound }` (`CodecDetector.cs:116-139`). On native throw it returns an all-`NotFound`/`Undefined` struct and uploads a *throttled* failure report once (`:124-138`).

`GetTranscodeSupportLevelForNativeTranscoder` (`:71-114`) normalizes then classifies:
- Video types `4..5` (`HEVC`, `AV1` per `Mp4VideoStreamType`) → forced to `Unknown` (native encoder can't emit them) (`:74-78`).
- Audio types `6..7` (`DolbyEac3`, `MultipleAudioTracks` per `Mp4AudioStreamType`) → forced to `Unknown` (`:79-83`).
- `AudioAppearsValid` cross-checks the **sample rate** against the codec: AAC `8k–96k`, MP3 `8k–48k`, Opus `8k–48k`, default `≤96k`; rate 0 is invalid (`:141-186`). Failing → audio `Unknown`.
- Result mapping (`:88-113`): unknown container/video/audio ⇒ `Unsupported`; `IsoMp4`/`Iso3gp` containers ⇒ `SupportedCodec`; **anything else (incl. `QuickTime`) ⇒ `NeedsRemux`**; both streams `NotFound` ⇒ `Unsupported`.

`GetTranscodeSupportLevel` (`:59-69`) wraps this: if native = `Unsupported` **and** `UwpTranscodeWrapper.CanTranscode(path)` returns true, it upgrades to `(NeedsTranscode, TranscoderType.Uwp)`; otherwise `(level, Native)`.

**Audio codec sniffing** (`DetectAudioCodec`, `:188-273`) is magic-byte based, returning `SoundPlaybackCodec[]` + MIME:
- `OggS`…`OpusHead` (page-aware offset `buffer[26]+27`) ⇒ `OpusFile`, `audio/ogg; codecs=opus` (`:198-224`).
- `#!AMR` ⇒ `[MediaFoundation, Amr]`, `audio/amr` (`:225-246`).
- Fallback ⇒ `MediaFoundation` with `GuessAudioMimeType` (frame-sync `FF Ex` → `audio/aac`|`audio/mpeg`; `ftypM4A` → `audio/mp4`; `ID3` skip then re-sniff MP3) (`:247-273`, `:304-346`).

`CreateSoundSource` (`:275-295`) tries each candidate codec in order, returning the first that constructs: `MFAudioSource` (Media Foundation), `AmrAudioSource` (native), or `OpusAudioSource` (native).

`GetVideoMimeType` maps `MediaContainerType` → `video/mp4|video/3gpp|video/quicktime|video/ogg` (`:47-57`).

---

### 3.4 Demux (`DemuxResult`)

`TryPerformDemux(filePath)` (`DemuxResult.cs:32-65`):
1. Build a temp IsoStore dir `tmp\remux-<threadId>-<ticks>` (`:25-26`), purge any stale copy (`NativeInterfaces.Misc.RemoveDirectoryRecursive`, `:38`), create it (`:43-52`).
2. Copy the input file into the dir, then `NativeInterfaces.Mp4Utils.ExtractAVStreams(file, dir)` — native splits container into elementary-stream files (`:53-59`).
3. `AudioTrackPath` is lazily resolved: the lexicographically-first file with extension in `{aac, mp3, amr, qcp}` (`:27-29`, `:78-90`).
4. `Dispose()` recursively deletes the temp dir (`:67-76`).

---

### 3.5 Profile pictures (`PicturesManager`)

`PicturesManager` is both `IPicturesBridgeToNative` and an `ICache<ConvoJid, Uri?>` over the contacts DB (`PicturesManager.cs:17`). It does **not** download avatars — it caches their URLs and keeps native/JS in sync.

- `SetProfilePictures(jsonArray)` — JS pushes `[{id, eurl}]`; native maps `id` (`c.us`→`s.whatsapp.net`), upserts `ChatPicture.LocalPhotoId = eurl` and marks it validated, persists via `ContactsContext` (`:38-65`). (`eurl` = the encrypted/CDN avatar URL stored as `LocalPhotoId`.)
- `Check(entity)` — when a cached `LocalPhotoId` differs from the last validated/requested id, native asks JS to re-verify via `_web.VerifyPicture(json[{eurl,id}])` (`id` mapped back `s.whatsapp.net`→`c.us`) (`:85-102`).
- `Subscribe(web)` flushes any pending verify requests (`:128-134`). `WhenChanged` exposes `ChatPicture.WhenChanged` for the UI (`:36`).

`IPicturesBridgeToNative` (`WinRTAdapter/IPicturesBridgeToNative.cs`, IID `0EE03816-…`) is just `SetProfilePictures(string)` + `Subscribe(IPicturesBridgeToWeb)`.

---

### 3.6 Path & storage model (`MediaStorage` / `NativeMediaStorage`)

- URIs use a `file:` prefix; `RemoveFilePrefix`/`MakeUri` normalize (`MediaStorage.cs:235-249`, `:79-86`).
- `GetAbsolutePath` resolves relative paths against `Constants.IsoStorePath` (= `ApplicationData.Current.LocalFolder.Path`) unless already absolute (`:106-122`).
- `WaMediaPathId` classifies a path into a `WaFolderIds` root (IsoStore, CameraRoll, PicturesLibrary, SavedPictures, Temp, etc.). `MediaStorage.Create` returns `IsoStoreMediaStorage` for IsoStore roots, else `NativeMediaStorage` (`:51-60`).
- `NativeMediaStorage.OpenFile` routes IsoStore paths to raw `FileInfo.Open`, and KnownFolder paths through `StorageFile`/`StorageFolder` WinRT APIs (sync-over-async via `TaskRiskyExtensions`) (`NativeMediaStorage.cs:61-120`).
- `GetStorageFolderAsync(WaFolderIds)` maps folder ids to `KnownFolders.CameraRoll`, `StorageLibrary Pictures.SaveFolder`, `KnownFolders.SavedPictures`, `LocalFolder`, `TemporaryFolder` (`MediaStorage.cs:371-398`).

---

### 3.7 MMS-retry (media-retry) protocol & decryption-failure-driven resend

This is the recovery path for when a **received** media message can't be turned into bytes: the receiver couldn't download the encrypted blob from `mmg`, or downloaded it but the AES-CBC+HMAC media decrypt failed (hash/MAC mismatch, expired `directPath`, etc.). The receiver asks the **sender** to re-upload the same plaintext under a fresh `directPath`, and the sender answers with a small encrypted notification carrying the new path. **Note the asymmetry:** this is *media-blob* retry keyed by `mediaKey`, and is entirely distinct from the **message-level retry-receipt** path (Signal/libsignal session re-keying — `PersistentAction.Types.SendRetryReceipt`/`SendIndividualRetry`, `PersistentAction.cs:26`, `:28`) and from the **VoIP** `DecryptionFailureEvent` (§3.7.5). All three are "decryption failed → resend", but operate at different layers.

#### 3.7.0 Where the protocol actually lives

The MMS-retry protocol is implemented **in the WebView2 JS bundle**, not in native C#. Confirmed: the only `mediaretry` reference under `decompiled/WhatsApp.Root/` or `WhatsApp.Networking/` is the **binary-node token** `"mediaretry"` in the token dictionary (`WhatsApp.Networking/WhatsApp/WAPDefaultTokenDictionary.cs:96`); the companion token `"direct_path"` is at `:27`. There is **no** native handler that parses a `mediaretry` notification. The C# `MediaRetryNotification`/`ServerErrorReceipt` protobuf classes exist (see §3.7.2) but are confirmed **dead/parity code**: an exhaustive grep over the entire `decompiled/` tree shows **all 7 files** referencing them sit inside the `WhatsApp.Protobuf` assembly only — the generated message bodies (`GProtoBuf`/`ProtoBuf` mirrors + `MmsRetryReflection`) plus `Message.cs`, which merely reuses the `MediaRetryNotification.Types.ResultType` enum (`Message.cs:12850,12876,13166`). **Zero** runtime assembly (`WhatsApp.Root`/`Networking`/`VoIP`/`DataModels`) calls their `Parser`/`Serialize`; the live encode/decode runs in JS (§6 item 11).

JS modules (filenames are content-hashed in `waweb-source-bundle/`; module names are stable):
- `WAWebHandleMediaRetryNotification` — receives an inbound `mediaretry` notification (sender side of the conversation: I am the one who sent the media and am being asked to re-upload). In `waweb-source-bundle/UBSny1JW6Io85ynQwXGjQ1TOnYQlP5ZCknzXPJQ3ewhf_mePFoOFDhzAn9ZgK0M4M-p1qa3zEQyM6Ctep3itrkQmIsiLoFw_JTk.js`.
- `WAWebRequestMediaReuploadManager` — sends the retry **request** (`rmr` IQ) when a download/decrypt fails (receiver side). Dependency of the handler above.
- `WAWebCryptoMediaRetry` — the GCM encrypt/decrypt + HKDF wrapper. In `waweb-source-bundle/xTiXmyjNEd_.js`.
- `WAWebProtobufsMmsRetry.pb` — JS protobuf spec (`MediaRetryNotificationSpec`, `ServerErrorReceiptSpec`).

#### 3.7.1 Stanza flow

**(a) Request — receiver asks for re-upload (`rmr` IQ).** When a media download/decrypt fails, `WAWebRequestMediaReuploadManager` builds an IQ whose child is an `rmr` ("request media retry") node and waits for ack (`xTiXmyjNEd_.js`, `deprecatedSendStanzaAndWaitForAck(...)`):

```
wap("rmr", { jid: <chat jid>,
             from_me: <"true"/"false" — getIsSentByMe(msg)>,
             participant: <group sender, or DROP_ATTR> )
```

alongside an `enc_iv` node (`wap("enc_iv", null, <iv>)`) — i.e. the request carries the AES-GCM IV that the *responder* must use to encrypt its reply. Each outstanding request is tracked by a media-fault entry keyed on `directPath`/type with a `debugHint:"rmr"` and a `markWhetherOnServer(...)` flag (`xTiXmyjNEd_.js`).

**(b) Response — sender re-uploads and notifies (`mediaretry` notification).** The sender's `WAWebHandleMediaRetryNotification` parses an inbound `<notification type="mediaretry">`, decrypts the embedded `MediaRetryNotification` (§3.7.3), and **acks** it with a custom `ack` stanza:

```
wap("ack", { id: <stanza id>,
             class: "notification",
             type: "mediaretry",
             to: <participant USER_JID or me>,
             participant: <f or DROP_ATTR> )
```

The handler guards that the notification came **from self-primary** (logs `"handleMediaRetryNotification: received from not self-primary"` / `media-retry-notification-not-from-self-primary` otherwise) — i.e. only the user's own primary device is allowed to drive a re-upload on multi-device.

#### 3.7.2 Protobuf shapes (`mms_retry.proto`)

The shared proto is `mms_retry.proto`, package `WhatsApp.ProtoBuf` (confirmed by the embedded `FileDescriptor` base64 in `WhatsApp.Protobuf/WhatsApp.GProtoBuf/MmsRetryReflection.cs:14`). Two messages:

`MediaRetryNotification` — the re-upload result:
| field | # | wire | type | meaning |
| --- | --- | --- | --- | --- |
| `StanzaId` | 1 | `string` | tag `0x0A` | id of the original media message |
| `DirectPath` | 2 | `string` | tag `0x12` | **new** CDN `directPath` to re-download from |
| `Result` | 3 | `enum ResultType` | tag `0x18` | outcome of the re-upload attempt |

`ResultType` = `GENERAL_ERROR(0)`, `SUCCESS(1)`, `NOT_FOUND(2)`, `DECRYPTION_ERROR(3)` (`WhatsApp.GProtoBuf/MediaRetryNotification.cs:13-23`; field tags/numbers `:32-48`, `:213-235`; mirrored in the SilentOrbit variant `WhatsApp.ProtoBuf/MediaRetryNotification.cs:9-21`, `:156-175`). So `NOT_FOUND` = sender no longer has the plaintext to re-upload; `DECRYPTION_ERROR` = sender itself couldn't decrypt (rare, key desync).

`ServerErrorReceipt` — `StanzaId` (1, `string`) only (`WhatsApp.GProtoBuf/ServerErrorReceipt.cs:14-43`); it is `MmsRetryReflection.Descriptor.MessageTypes[1]` and `MediaRetryNotification` is `MessageTypes[0]` (`MediaRetryNotification.cs:54`, `ServerErrorReceipt.cs:24`). This is the **server-side** error receipt path (the server, not a peer, reporting it failed to fetch the encrypted blob).

**JS has a 4th field the C# protobuf omits.** The live JS spec is `MediaRetryNotificationSpec = { stanzaId:[1,STRING], directPath:[2,STRING], result:[3,ENUM], messageSecret:[4,BYTES] }` (`SjCAw3j6BfscMiCaVlE8ws3ouPY_oSLXNFbdc6aC1yv_NiDGbhIdl5zyHAaImr0WiG.js`). The decompiled C# `MediaRetryNotification` stops at field 3 (no `messageSecret`) — either the C# copy is older, or the unknown field is simply tolerated by `UnknownFieldSet` (`MediaRetryNotification.cs:289-291`). **Treat `messageSecret` as the authoritative wire shape** for a port; the C# is a stale mirror.

#### 3.7.3 Notification encryption (`WAWebCryptoMediaRetry`)

The `MediaRetryNotification`/`ServerErrorReceipt` payloads are **not sent in clear** when the `mms4_*_encryption_enabled` ab-props are on (the binary-node tokens `mms4_media_retry_notification_encryption_enabled` and `mms4_server_error_receipt_encryption_enabled` are both in the token dictionary — `WAPDefaultTokenDictionary.cs:59`). The crypto (confirmed in `waweb-source-bundle/xTiXmyjNEd_.js`):

- **Key derivation:** `f(mediaKey) = HKDF.extractAndExpand(mediaKey, "WhatsApp Media Retry Notification", 32)` → a **32-byte** key. So the retry-notification key is derived from the *same* `mediaKey` as the media blob itself (info string `"WhatsApp Media Retry Notification"`, distinct from the §4 `WhatsApp {Image,Video,Audio,Document} Keys`).
- **Cipher:** AES-GCM (`WACryptoAesGcm.gcmEncrypt/gcmDecrypt`).
- **IV:** **12 bytes** (`ENC_IV_SIZE = p = 12`). The encrypt path is `a = (n==null ? g() : n.slice())` where `g() = crypto.getRandomValues(new Uint8Array(12))` — i.e. the responder **reuses the requester's IV when one is supplied (the request's `enc_iv` node), otherwise generates a fresh random 12-byte IV** (`xTiXmyjNEd_.js`). (Resolves the prior "reuse vs fresh" open question, §6 item 8.)
- **AAD:** `i = s({ stanzaId })`, and `s()` is `encodeProtobuf(ServerErrorReceiptSpec, {stanzaId})` (`xTiXmyjNEd_.js`, module `WAWebCryptoMediaRetry`). So the GCM additional-data is the **protobuf-encoded `ServerErrorReceipt` message** — concretely the bytes `0x0A <len> <stanzaId-UTF8>` (field 1, string). Byte-layout now **confirmed**, not inferred.
- **API:** `encryptServerErrorReceipt(mediaKey, ...)` and `decryptMediaRetryNotification(mediaKey, ciphertext, iv, aad)` are the exported entry points (`l.encryptServerErrorReceipt`, `l.decryptMediaRetryNotification`, `l.ENC_IV_SIZE`).

So on the wire: the GCM **ciphertext** + IV ride in an `<encrypt><enc_p>{ciphertext}</enc_p><enc_iv>{iv}</enc_iv></encrypt>` subtree (`wap("encrypt", null, wap("enc_p",null,ciphertext), wap("enc_iv",null,iv))`, `xTiXmyjNEd_.js`). The receiver re-derives the key from the message's `mediaKey`, decrypts, reads the new `directPath`, and re-downloads. The encrypted-blob download/decrypt itself is the same JS media path described in §4 (not native).

#### 3.7.4 Capability + housekeeping flags

- **Client advertises support** via `ClientPayload …WebdPayload.SupportsMediaRetry` (field present, `[Obsolete]`, `WhatsApp.ProtoBuf/ClientPayload.cs:700`, ser/de `:775`, `:831`, `:889`, `:947-950`) — legacy handshake capability bit.
- **Persistent action** `PersistentAction.Types.SendMediaRetryServerError` (`PersistentAction.cs:49`) is the durable/queued job that emits a `ServerErrorReceipt` (survives restart, retried by the persistent-action runner). Related media-resend jobs in the same enum: `ReuploadMedia` (`:24`), `SendReuploadMediaNotification` (`:43`), `Mms4HostSelection` (`:44`). **The `ServerErrorReceipt` is peer-directed, not server-directed:** JS sends it as `wap("receipt", {type:"server-error", to: USER_JID(peer), id: stanzaId, category:"peer"}, <encrypt …>)` (`xTiXmyjNEd_.js`) — `to:USER_JID` + `category:"peer"` route it to the **peer device**, GCM-encrypted under the same `mediaKey`-HKDF key. "server-error" names the *cause* (the mms host couldn't serve the blob), not the destination (§6 item 10).
- **WAM telemetry** records the retry: `MediaUploadResultType`/`UploadType.MediaRetry` ("media_retry") and `UploadType.WebReupload` ("web_reupload") in `Wam.cs:15362-15365`; the `MessageSecretErrorType` enum (`Wam.cs:16188-16198`) enumerates `missing_message_secret`, `wrong_length`, `encryption_error`, `decryption_error` — the failure causes that drive/accompany a retry; and `ReportingFunnel.IsMessageMediaRetry` (`Wam.cs:70209`, field 10 `:70251`) flags a funnel event as belonging to a media-retry. The `Message.cs` `PeerDataOperationResult.MediaUploadResult` field even **reuses** `MediaRetryNotification.Types.ResultType` (`WhatsApp.GProtoBuf/Message.cs:12848-12876`, parse `:13166`) — i.e. the same result enum is surfaced through the peer-data-operation channel too.

#### 3.7.5 Native `DecryptionFailureEvent` is VoIP-only — *not* the messaging/media path

The native `WhatsAppNative.DecryptionFailureEvent` projection (`WhatsAppNativeProjection/WhatsAppNative/DecryptionFailureEvent.cs`) is **not** the per-message E2E media decryption-failure surface — despite the name. Its fields are call-shaped: `RetryCount`, `Registration`, `PeerDeviceJid` (a `VoipBridgeJid`), `CallId` (`__IDecryptionFailureEventPublicNonVirtuals.cs:12-18`; concrete getters/setters `DecryptionFailureEvent.cs:67-113`; IID `29E21D36-D5F3-3EFF-B846-B97C95AE901F`, `:8`). It is consumed **only** in the VoIP signaling callback dispatcher for `VoipEvent.RejectedDecryptionFailure` (`= 83`, `WhatsAppNativeProjection/WhatsAppNative/VoipEvent.cs:92`), where it is JSON-serialized and forwarded to `VoipSignaling.HandleCallEvent` (`WhatsApp.VoIP/WhatsApp/VoipCallbacks.cs:487-493`). That is: a *call* signaling packet (SRTP/Signal-session) failed to decrypt and was rejected, with a retry counter — the VoIP analogue of a retry-receipt, documented in the VoIP doc. **The message/media E2E decryption-failure that drives an MMS retry-receipt or a `rmr` request is detected and acted on in the JS Signal/media layer, with no native `DecryptionFailureEvent` involvement.** (Cross-ref: WAM message-level `DecryptionFailed` codes — `Wam.cs:14593`, `:14743-14747` — are populated by that JS/Signal layer, not by this native event.)

---

## 4. Native Dependencies

All heavy media operations cross into `WhatsAppNative.dll` via CsWinRT (`WhatsAppNativeProjection`). The pre-canned Ghidra export is empty, but the binary is statically readable via `strings`/`objdump` (and radare2 disassembly, per doc 96); the transcoder *bodies* were not disassembled here, so their internal encode constants are **inferred**, while the **ABI surface is confirmed** from the projection interfaces and `AppxManifest.xml`.

**Confirmed (projection signatures + manifest registration):**
- `WhatsAppNative.Transcoder` (IID `55C1BC99-FDEE-37C8-A902-C9E6FACD7F4D`, activatable). Members: `Initialize(IVideoUtils, ISoundSource, TranscoderContainerType, IRandomAccessStream output)`, `AddMaxEdgeTransform(uint)`, `AddClipRectangleTransform(x,y,w,h)`, `AddRotateTransform(exifOrientation)`, `Seek(millis)`, `SetEncoderScheduler(IWAScheduler)`, `Transcode(durationMillisOrNegative, ITranscoderProgress)`, `Cancel()`, plus `ISampleSink.OnSampleAvailable` and `Test*` hooks (`__ITranscoderPublicNonVirtuals.cs`, `Transcoder.cs`). Output container enum has the single value `TranscoderContainerType_Mp4`.
- `WhatsAppNative.Mp4Utils` (IID `F2261EE6-46EC-36F1-926F-95E3BCB4F6CF`, process-singleton). Members include `ExtractStreamInformation(path)→Mp4MediaType`, `ExtractAVStreams(in, outDir)`, `ExtractAVStreamsForStreaming(...)`, `MuxAVStreams(audio, video, out, startTime, duration, targetFps)`, `CheckAndRepair(in, out, downloadScenario, onPreliminaryCheckCompleted)→bool`, `GetStreamMetadata(...)`, `IsWaAnimGif`/`TagWaAnimatedGif`, `OpenTrackRemover(in)→Mp4TrackRemover`, `Map/UnmapStream`, `IsRecoverableError(hr)` (`__IMp4UtilsPublicNonVirtuals.cs`, `Mp4Utils.cs`).
- `WhatsAppNative.VideoUtilsMp4` / `VideoUtilsGif` — frame source feeding `Transcoder` (`IVideoUtils`: `GetFrame(ISampleSink)`, `GetFrameAttributes`, `GetStride`, `GetDuration`, `Seek`).
- `WhatsAppNative.OpusAudioSource` (IID `1B3F4377-…`), `AmrAudioSource` (IID `C87B4487-…`), `Resampler` (IID `2918312B-…`) — `ISoundSource` producers (Opus/AMR decode; PCM resample). The `__I*PublicNonVirtuals` bodies are empty in the projection (members exposed only via base `ISoundSource`/factory).
- `WhatsAppNative.Mp4MediaType`, `Mp4TrackRemover` — activatable result/utility types.

**Confirmed via native `strings` + `objdump` import table (encoder provenance):** [native-binary]
- **Video encoder = Cisco OpenH264 (Wels)**, statically linked in `WhatsAppNative.dll`: `strings` shows `CWelsH264SVCEncoder@WelsEnc`, `CVAACalculation@WelsVP`, the error-message string `OpenH264 Encoder: WelsCreateSVCEncoder failed` (the `WelsCreateSVCEncoder` symbol is the load-bearing substring), `failed to open openh264 encoder`, plus a distinct `h264 encoder (WebRTC mode)` path (shared with VoIP).
- **Container mux + audio (AAC) encode = Windows Media Foundation Sink Writer.** The native `Transcoder` exposes (RTTI symbols, confirmed this pass) `WhatsAppNative::Transcoder::{Initialize,CreateSinkWriter,CreateVideoType,CreateAudioType,OnAudioFrame,OnVideoFrame,OnSampleAvailable,WriteSample,TransformVideoMetadata,FlushScheduler,ReportProgress,Transcode}`. The `objdump -p` import table corroborates the MF path directly: from **MFPlat.DLL** it imports `MFCreateMediaType`, `MFCreateWaveFormatExFromMFMediaType`, `MFCreateAttributes`, `MFCreateSample`, `MFCreateMediaBufferWrapper`, `MFCreateMFByteStreamOnStreamEx`; from **MFReadWrite.dll** `MFCreateSinkWriterFromURL` (the SinkWriter) and `MFCreateSourceReaderFromByteStream`; plus `MFTEnumEx` (codec-MFT enumeration). So the H.264 (from OpenH264) + AAC streams are muxed into the MP4 (`isom`) by the MF Sink Writer, not a bundled muxer. `AddMaxEdgeTransform(960|480)` + `TranscoderContainerType_Mp4` remain the only knobs the managed layer sets. (Evidence: `strings -n6 x64/WhatsAppNative.dll`; `objdump -p x64/WhatsAppNative.dll`.)
- Opus/AMR are **decode-only** native media sources (`OpusAudioSource`/`AmrAudioSource`); the media-send AAC encode goes through the MF `CreateAudioType` Sink-Writer path. **Note:** the binary *does* contain a native Opus **encoder** (`opus_codec_encode`, `opus_codec_encode_with_secondary`, `opus_encode error`, `Opus bitrate corrected %u -> %u`), but these strings sit in the **WebRTC/VoIP UAQC** audio-quality-controller cluster (`uaqc_*_opus_vad_threshold`, `opus_non_speech_bitrate`, `opus_max_complexity`, `configure_sampling_rates`) — i.e. that Opus encoder is the **call** encoder, not the media-send/PTT path. The media-send audio profile is set at runtime inside `Transcoder::CreateAudioType` via `MFCreateMediaType`/`MFCreateWaveFormatExFromMFMediaType` (no readable literal). [native-binary]
- **Cross-reference — the transcode bitrate/resolution is a per-job runtime value carried *on the wire*, not a fixed client ladder.** [protocol-cross-ref] The transcoded-video descriptor is the protobuf message `ProcessedVideo = {directPath:1, fileSHA256:2, height:3, width:4, fileLength:5, bitrate:6, quality:7 (UNDEFINED/LOW/MID/HIGH), capabilities:8 (repeated string)}` (`whatsmeow/proto/waE2E/WAWebProtobufsE2E.pb.go:10255-10360`; mirrored in the bundle modules `xTiXmyjNEd_.js`/`SjCAw…WiG.js`). The achieved `bitrate`/`width`/`height`/`quality` are reported **in-band per message**, and the WhatsApp-Web `VideoTranscoder` WAM event likewise records them as runtime telemetry — `targetWidth:[17]`, `targetHeight:[18]`, `targetBitrateBps`, `sourceVideoBitRate`/`targetVideoBitRate`, `transcoderIsPassthrough:[4]`, `transcoderAlgorithm` (`Baileys/src/WAM/constants.ts:2144-2196`; bundle `waweb-unmin/*.js` `targetWidth: e.target_w…`, `targetBitrateBps: e.targe…`). The server-side caps are *ab-prop names* with literal token values — `video_max_bitrate`, `video_max_edge`, `image_max_edge`, `hq_image_max_edge`, `image_max_kbytes`, `video_transcode_downgrade_enable`, `video_remux_after_repair_enabled`, and the literal `"960"` token (`whatsmeow/binary/token/token.go:12`; `Baileys/src/WABinary/constants.ts:287,370,394`). So there is **provably no static client-side bitrate ladder** to recover from any open impl — the encoder is *seeded* per job from these server ab-props and the result is transmitted in `ProcessedVideo`. The only residual is the literal default the native `CreateVideoType` falls back to (native-binary-only).

**Inferred (behavior of native code, not in dump):**
- The exact **bitrate ladder / encoder profile default** and whether `Resampler` targets a fixed PCM rate are still opaque (no readable transcode literals; every `*bitrate*` string in the binary is WebRTC/VoIP rate-control — `sender_bwe_*`, `uaqc_*_target_bitrate`, `min/max_target_bitrate`, `target video enc bitrate: %4d kbps` — and the only resampler strings are the VoIP `snd_port_resample_*` / `configure_sampling_rates` device path, never a transcode-fixed rate). Max-edge downscale, rotate, and the MP4 muxer details are implemented inside `WhatsAppNative.dll`; confirmed by names and the encoder-provenance strings above. Because the protocol carries the achieved bitrate/resolution per job in `ProcessedVideo` (see the cross-reference bullet above), this residual is purely the *native default seed* — there is no static ladder to recover from the open impls. [native-binary]
- `Mp4Utils.CheckAndRepair` (used by `Mp4UtilsExtensions.CheckAndRepair`, `Mp4UtilsExtensions.cs:89-174`) performs container validation/repair on **download** (`downloadScenario=true`) and exif-strip on send; `IsRecoverableError(hr)` distinguishes retryable failures.
- `MFAudioSource` / `VideoFrameGrabber` / `CompositionVideoFrameGrabber` / `MediaPlayerVideoFrameGrabber` rely on Windows **Media Foundation** / **Win2D composition** / UWP `MediaPlayer`.

**Not native at all (lives in WebView2 JS bundle — confirmed by grep on `waweb-source-bundle/`):**
- Media **E2E encryption/decryption** (`mediaKey`, 577 hits). Full scheme now read out of the bundle: `mediaKey` → `HKDF.extractAndExpand` to **112 bytes**, sliced `{iv:[0,16], encKey:[16,48], macKey:[48,80], refKey:[80,112]}` (`SjCAw…WiG.js`), info string per media type (`WhatsApp {Image,Video,Audio,Document} Keys`); **cipher = AES-CBC**, **MAC = HMAC-SHA-256 truncated to 10 bytes** (`mEvs85pxZT4.js`: `IV_LENGTH=16`, `HMAC_LENGTH=10`, `CBC_BLOCK_SIZE=16`, helpers `encryptAndHmac`/`hmacCiphertext`/`hmacAndDecrypt`). See §6 item 2.
- The actual **HTTP upload/download** to `mmg.whatsapp.net` / `mmg-fallback.whatsapp.net`. Upload hosts + auth come from the `<iq xmlns="w:m" type="set"><media_conn/></iq>` IQ, parsed by `mediaConnParser` into `{hosts, authToken (auth), authTokenExpiryTs (auth_ttl), routesExpiryTs}` (`SjCAw…WiG.js`, module `WAMediaConnParser`). See §6 item 4.
- `sidecar`/streaming-integrity (10-byte truncated HMAC per **64 KB** chunk: `a=Math.ceil((r-16)/65536); new Uint8Array(10*a)`, `mEvs85pxZT4.js`), progressive download, and the media message protobufs.

## 5. Linux/Electron Port Mapping

The hybrid split is a gift: if you reuse the waweb JS bundle, **media crypto, mmg up/download, and the media protocol are already done in JS** — you only need to replace the four native services. Map each piece:

| Windows native piece | Linux/Electron equivalent | Notes / risk |
| --- | --- | --- |
| `MediaTranscodingService` shared-buffer transcode | **ffmpeg** (`fluent-ffmpeg` / `@ffmpeg-installer/ffmpeg`, or `ffmpeg.wasm` for sandbox) in the **main process** or a `utilityProcess` | Electron has no `CoreWebView2SharedBuffer`. Replace with `MessagePort`/`ArrayBuffer` transfer or a temp-file handoff. The "source buffer → temp file → transcode → result buffer" pattern (§3.1.2) maps cleanly to temp files + IPC. |
| Native `Transcoder.AddMaxEdgeTransform(960/480)` + MP4 mux | `ffmpeg -vf "scale='min(960,iw)':'min(960,ih)':force_original_aspect_ratio=decrease" -c:v libx264 -c:a aac -movflags +faststart` | Reproduce the **960 px (480 px low-mem)** longest-edge cap and **AAC passthrough** rule. WhatsApp servers expect H.264/AAC in MP4; keep that. |
| `UwpTranscodeWrapper` (Media Foundation VGA fallback) | Not needed — ffmpeg handles all inputs | The whole Native-vs-UWP dual-path collapses into one ffmpeg invocation. |
| `CodecDetector` (`ExtractStreamInformation`, sample-rate gates) | `ffprobe -show_streams -print_format json` | Re-implement the classification table (§3.3): force-transcode HEVC/AV1/E-AC3/multi-track; AAC/MP3/Opus sample-rate bounds. |
| `DemuxResult` / `ExtractAVStreams` | `ffmpeg -i in -map 0:a -c copy out.aac` etc. | ffmpeg demux/remux replaces the temp-dir extract. |
| Thumbnail `VideoFrameGrabber` (3-tier) | `ffmpeg -ss 0 -i in -frames:v 1 -q:v 2 out.jpg` (or `mediainfo` for fps) | Single path; export JPEG. |
| `MediaDownloadManager` (`CoreWebView2.DownloadStarting`) | Electron **`session.on('will-download')`** + `DownloadItem.setSavePath()` | Direct analog. Suppress the default save dialog, route to the `transfers/` tree, watch `'done'` state. |
| `MediaFilesService` destination/foldering, sanitize, MotW | Node `fs` + `path`; weekly bucket `transfers/<year>-<week>`; reserved-name sanitize | **Drop Mark-of-the-Web** (Windows-only ADS); Linux has no Zone.Identifier. Optionally set restrictive perms. |
| Hash verify (SHA-256 vs base64 hash) | Node `crypto.createHash('sha256')` | Keep — it's the integrity backstop. |
| `mediaDownloads.db` (`CompletedDownloads2`) | **better-sqlite3** (optionally SQLCipher) | Trivial. Keep the `(FileHash, Extension)` PK. |
| Clipboard copy (`DataPackage`, JPEG bitmap) | Electron `clipboard.writeImage()` / `clipboard.write({ ... })` | Electron clipboard can't set file lists on Linux easily; image copy works. |
| `PicturesManager` avatar-URL cache | Plain in-process cache + better-sqlite3 contacts table | No native dependency; pure bookkeeping. |
| `MediaStorage`/`WaFolderIds` (CameraRoll/Pictures/SavedPictures) | XDG dirs (`~/Pictures`, `~/Downloads`) via Electron `app.getPath('pictures'|'downloads')` | Map KnownFolders → XDG. |
| Media **encryption + mmg HTTP** | **Reuse from waweb JS bundle** | Biggest win: the 577 `mediaKey` references and `WhatsApp * Keys` HKDF live in JS and run unchanged inside Electron's `BrowserWindow`/`webContents`. |
| **MMS-retry protocol** (`rmr` IQ, `mediaretry` notification, `MediaRetryNotification` GCM crypto) | **Reuse from waweb JS bundle** | Also entirely JS (`WAWebHandleMediaRetryNotification` / `WAWebRequestMediaReuploadManager` / `WAWebCryptoMediaRetry`). Nothing to reimplement natively — just don't strip these modules from the bundle. The `"WhatsApp Media Retry Notification"` HKDF + 12-byte-IV AES-GCM and the `messageSecret` 4th proto field are the wire details to preserve. |

**Gaps / risks:**
- **Shared buffer semantics.** WebView2's `PostSharedBufferToScript` is zero-copy; Electron has no equivalent for arbitrary binary to renderer. Use `MessageChannelMain`/`postMessage` with transferable `ArrayBuffer`, or keep media bytes in main and pass only file paths/handles to the renderer (simpler, matches the temp-file pattern already used internally).
- **`faststart`/atom layout.** WhatsApp expects streamable MP4 (moov atom front). The native `Transcoder` does this implicitly; with ffmpeg you must add `-movflags +faststart` and possibly replicate `CheckAndRepair`'s container fixups.
- **GIF handling.** Native treats animated GIF specially (`VideoUtilsGif`) and tags "WA animated gif" (`Mp4Utils.TagWaAnimatedGif`/`IsWaAnimGif`). WhatsApp sends GIFs as MP4 with a marker; replicate with ffmpeg GIF→MP4 + the WA gif moov tag (verify exact tag in JS/protocol).
- **Sample-rate / size constraints.** The `maxResultSize` gate (`MediaTooLarge`) and the codec sample-rate windows are server-driven; pull the real limits from the JS bundle / ab-props rather than hardcoding.

## 6. Open Questions / Unverified

Every item below was **re-investigated this pass** against the JS bundle (`waweb-source-bundle/`), the decompiled C# (`decompiled/`), and the native binaries (`x64/WhatsAppNative.dll` via `strings`/`objdump`). Each is now prefixed with a verdict tag (**[RESOLVED]** / **[PARTIAL]** / **[CANNOT RESOLVE STATICALLY]**) and a concrete finding + citation. Original question text is preserved.

1. **[PARTIAL] Native encoder internals.** *Was: all `WhatsAppNative.dll` media code opaque; exact encoder, bitrate ladder, fixed PCM resampler rate inferred from names only.* **Encoder identity RESOLVED; only the native default bitrate/profile *seed* remains native-binary-only — and it is provably not a recoverable static ladder.** The **video encoder is Cisco OpenH264 (Wels)** statically linked into `WhatsAppNative.dll` — `strings` reveals `CWelsH264SVCEncoder@WelsEnc`, `CVAACalculation@WelsVP`, the full error string `OpenH264 Encoder: WelsCreateSVCEncoder failed`, `failed to open openh264 encoder`, and a distinct `h264 encoder (WebRTC mode)` path. [native-binary] The **container mux + audio (AAC) encode use Windows Media Foundation**: the native `Transcoder` exposes (RTTI) `WhatsAppNative::Transcoder::{Initialize,CreateSinkWriter,CreateVideoType,CreateAudioType,OnAudioFrame,OnVideoFrame,OnSampleAvailable,WriteSample,TransformVideoMetadata,FlushScheduler,Transcode}`, and this pass the **`objdump -p` import table directly confirms the MF path** — MFPlat (`MFCreateMediaType`, `MFCreateWaveFormatExFromMFMediaType`, `MFCreateAttributes`, `MFCreateSample`, `MFCreateMediaBufferWrapper`, `MFCreateMFByteStreamOnStreamEx`) + MFReadWrite (`MFCreateSinkWriterFromURL`, `MFCreateSourceReaderFromByteStream`) + `MFTEnumEx` (so AAC encode + MP4 isom mux go through the MF Sink Writer, not a bundled muxer). [native-binary] **Still CANNOT statically:** the native **default bitrate/profile seed** inside `Transcoder::CreateVideoType` (every `*bitrate*`/`*target_bitrate*` string in the binary is WebRTC/VoIP rate-control — `sender_bwe_*`, `uaqc_*_target_bitrate`, `min/max_target_bitrate`, `target video enc bitrate: %4d kbps` — not the transcode ladder) and whether `Resampler` targets a **fixed** PCM rate (only the VoIP `snd_port_resample_*` / `configure_sampling_rates` device-rate path and dynamic `"%d Hz -> %d Hz"` strings exist; rate is runtime). **This pass strengthens *why* the residual is native-binary-only and narrows it to a single default constant.** The transcode bitrate/resolution is **carried on the wire per job**, not fixed in the client: the descriptor `ProcessedVideo = {directPath:1, fileSHA256:2, height:3, width:4, fileLength:5, bitrate:6, quality:7(UNDEFINED/LOW/MID/HIGH), capabilities:8}` (`whatsmeow/proto/waE2E/WAWebProtobufsE2E.pb.go:10255-10360`; bundle `xTiXmyjNEd_.js`/`SjCAw…WiG.js`) transmits the achieved values, and the WA-Web `VideoTranscoder` WAM event records them as runtime telemetry (`targetWidth:[17]`, `targetHeight:[18]`, `targetBitrateBps`, `sourceVideoBitRate`/`targetVideoBitRate`, `transcoderIsPassthrough:[4]` — `Baileys/src/WAM/constants.ts:2144-2196`; bundle `targetBitrateBps: e.targe…`). [protocol-cross-ref] The caps are *server ab-props* whose literal token values are visible in the cross-ref (`video_max_bitrate`, `video_max_edge`, `image_max_edge`, `hq_image_max_edge`, `image_max_kbytes`, `video_transcode_downgrade_enable`, the `"960"` token — `whatsmeow/binary/token/token.go:12`; `Baileys/src/WABinary/constants.ts:287,370,394`). So the encoder is **seeded per job from server ab-props** and the result is reported in-band; **no static client ladder exists to recover** from the JS bundle or open WA-protocol impls (which never run the native MF/OpenH264 transcode at all). **This pass adds three corroborations narrowing the residual further:** (i) the native max-edge downscale is a discrete `WhatsAppNative::WaMaxEdgeTransform` class (RTTI `::OnMetadata`/`::Transform`) that holds **no embedded 960/480 literal** — the bound is the runtime `(uint)num` arg from `NativeTranscodeWrapper.cs:234`, so the *resolution* cap is provably managed-side, not native [native-binary]; (ii) the managed `transcoder.Initialize(videoUtils, null, TranscoderContainerType_Mp4, destStream)` passes **no** width/height/bitrate/profile argument (`NativeTranscodeWrapper.cs:237`), so the *only* remaining native-decided knob is the bitrate/profile seed inside `CreateVideoType` [decompiled-C#]; (iii) the sibling `x64/WhatsAppRust.dll` (wamedia) is a **parse/demux/mux/repair/detect** library with **no encoder and no ladder** — its `bitrate`/`sample_rate` strings are all input-header *field names* (Speex/Vorbis/Opus identification structs), so the encode constant is not there either [native-binary]. The residual is therefore pinned to a single native default inside `Transcoder::CreateVideoType` in `WhatsAppNative.dll`; **instruction-level disassembly of `Transcoder::CreateVideoType` (radare2 — the method doc 96 already used to read native bodies out of these binaries — or PyGhidra) is the remaining artifact that would pin the native *default* bitrate/profile constant** (the live-appdata/IndexedDB forensics in docs 94/95 are storage-only and do not touch the encode path). (Evidence: `strings -n6 x64/WhatsAppNative.dll`; `objdump -p x64/WhatsAppNative.dll`; `strings x64/WhatsAppRust.dll`; `rg` over `NativeTranscodeWrapper.cs`; cross-reference grep of `whatsmeow/`, `Baileys/src/`, `waweb-unmin/`.)
2. **[RESOLVED] `mediaKey`/HKDF exact construction.** *Was: info strings confirmed present but AES-CBC + HMAC-SHA256 + sidecar not traced byte-for-byte.* The full scheme is now read out of the bundle. `mediaKey` → `HKDF.extractAndExpand` → **112 bytes**, sliced `{iv:[0,16], encKey:[16,48], macKey:[48,80], refKey:[80,112]}` (`SjCAw…WiG.js`: `return{iv:l.slice(0,16),encKey:l.slice(16,48),macKey:l.slice(48,80),refKey:l.slice(80,112)}`). Per-type info string chosen by `WhatsApp {Image,Video,Audio,Document} Keys` (`mEvs85pxZT4.js`, `SjCAw…WiG.js`). **Cipher = AES-CBC** (`{name:"AES-CBC",iv:r}` via `subtle.importKey`, `SjCAw…WiG.js`); **MAC = HMAC-SHA-256 truncated to 10 bytes** (`mEvs85pxZT4.js`: `IV_LENGTH=16` (`b=16`), `HMAC_LENGTH=10` (`v=10`), `CBC_BLOCK_SIZE=16`; helpers `encryptAndHmac`/`hmacCiphertext`/`hmacAndDecrypt`). **Streaming `sidecar`** = a 10-byte truncated HMAC per **64 KB** chunk: `s=16,u=10,c=64*1024; a=Math.ceil((r-16)/65536); new Uint8Array(10*a)` (`mEvs85pxZT4.js`, `WAWebCryptoCalculateStreamingSidecar`). This is the canonical WhatsApp media encryption scheme, now confirmed in-bundle (not merely "matches the known scheme").
3. **[RESOLVED] Who triggers the WebView2 download.** *Was: native intercepts `DownloadStarting`, JS calls `PrepareForMediaFileSaving` first, but the JS trigger mechanism (blob URL? `<a download>`?) not traced.* It is a **blob-URL anchor click**: the save module builds `window.URL.createObjectURL(blob)`, creates `document.createElement("a")`, sets `l.download = ""+a+i` (the suggested filename) and `l.style.display="none"`, `document.body.appendChild(l)`, then `l.click()` (`TSxMupG87E6yhaXTKXVWxylR5scLn8mP5Q8FLVfPji6ktJK5K_l9ltH6eZrB7IEM3rKWoz10txLN7VSn.js`; also `createDataLink` checks `isBlob`/`isData`). That synthetic anchor click is exactly what `CoreWebView2.DownloadStarting` (§3.2.2) intercepts. The bridge wrapper that pre-arms via `prepareForMediaFileSaving(url, name, hash)` is the host-object shim in the same file (`this.$1.prepareForMediaFileSaving(t,n,r)`).
4. **[RESOLVED] `media conn` / upload token IQ.** *Was: upload-side handshake (mmg hosts/auth) assumed in JS, not located.* Located in the bundle. JS sends `<iq to="s.whatsapp.net" xmlns="w:m" type="set"><media_conn/></iq>` (`SjCAw…WiG.js`: `wap("iq",{to:S_WHATSAPP_NET,xmlns:"w:m",type:"set",id:…}, wap("media_conn",null))`) and parses the reply with `mediaConnParser`, which reads `media_conn` into `{hosts, authToken: attrString("auth"), authTokenExpiryTs: attrFutureTime("auth_ttl"), routesExpiryTs}` (`SjCAw…WiG.js`, module `WAMediaConnParser`). So the upload/download host list + `auth` token + `auth_ttl` come from this `w:m` IQ, entirely in JS — no native C# involvement (consistent with §3.0).
5. **[PARTIAL] PTT/PTV/audio-message specifics.** *Was: `CheckAndRepair` treats PTT specially (`IsoMp4` only); Opus PTT encode params (mono, 16 kHz?) decided in native/JS, not confirmed.* The **container gate is confirmed in C#** [decompiled-C#]: `Mp4UtilsExtensions.IsEligibleToCheck` returns "eligible" for `Audio`/`Ptt` only when `containerType == MediaContainerType.IsoMp4`, while `Video`/`Gif`/`Ptv` accept any defined/known container (`Mp4UtilsExtensions.cs:147-164`). The **PTT/voice-note Opus encode parameters are RESOLVED for the WhatsApp Web / Electron path** — they are an explicit bundle constant, **re-confirmed verbatim this pass** in `mEvs85pxZT4.js` (`WAPttComposerOpusRecorder` / `WAOpusRecorderWorkerClient`): `encoderApplication: 2048`, `encoderSampleRate: 16e3`, `numberOfChannels: 1`, `bitRate: 16e3`, `encoderFrameSize: 20` (alongside `bufferLength:4096, maxBuffersPerPage:40` and `streamOptions:{...googEchoCancellation:!1,googAutoGainControl:!1,googNoiseSuppression:!1,googHighpassFilter:!1...}`). So the PTT encoder is **mono** (`numberOfChannels:1`), **16 kHz** (`encoderSampleRate:16e3`), **16 kbps** (`bitRate:16e3`), **`OPUS_APPLICATION_VOIP`** (`encoderApplication:2048`), **20 ms frames** (`encoderFrameSize:20`). [bundle] (An earlier grep for `16000` missed these only because the values are written in exponential form `16e3`.) **Still CANNOT statically (residue only):** the *Windows native* audio-message encode profile on the MF Sink Writer path — `Transcoder::CreateAudioType` — still has no readable rate/channel/bitrate literal; this pass the `objdump -p` import table confirms it builds the type via `MFCreateMediaType` / `MFCreateWaveFormatExFromMFMediaType` (MFPlat) and writes through `MFCreateSinkWriterFromURL` (MFReadWrite), but the actual sample-rate/channel/bitrate attributes are set at runtime in native code, not as a string. [native-binary] `OpusAudioSource`/`AmrAudioSource` are **decode-only** media sources; the native binary's only Opus *encoder* (`opus_codec_encode`, `Opus bitrate corrected %u -> %u`) sits in the **VoIP/UAQC call** cluster (`uaqc_*_opus_vad_threshold`, `opus_non_speech_bitrate`, `opus_max_complexity`), not the media-send path — so it cannot stand in for the native PTT/audio-message profile. **The open WA-protocol impls (whatsmeow/Baileys) and the JS bundle never run the native MF encode path** — they upload caller-supplied media as-is or use the JS `WAPttComposerOpusRecorder` config above — so there is no cross-reference for the native MF audio profile. **This pass adds two corroborations:** (i) the managed call `transcoder.Initialize(null, soundSource, TranscoderContainerType_Mp4, destStream)` passes **no** sample-rate/channel/bitrate argument (`NativeTranscodeWrapper.cs:197`), confirming the audio encode attributes are set entirely runtime-side in native `CreateAudioType`, not from C# [decompiled-C#]; (ii) the sibling wamedia library `x64/WhatsAppRust.dll` is **decode/parse-only** (`libwamediastreams_rs` Opus/AMR/AAC *parsers*) with no encoder, so the AAC encode profile is not there either — it is exclusively in the `WhatsAppNative.dll` MF Sink Writer path [native-binary]. (The `Resampler` symbols in `WhatsAppNative.dll` — `Created … resampler: %d Hz -> %d Hz`, `WebRTC resampler created: rate_in=%u, rate_out=%u`, `Successfully Created 16kHz resamplers` — are all the WebRTC/AEC `common_audio\resampler\push_sinc_resampler.cc` VoIP cluster with *runtime* rates, not a fixed media-send PCM rate; this re-confirms item 1's resampler residual too.) Instruction-level disassembly of `Transcoder::CreateAudioType` (radare2 per doc 96, or PyGhidra) or a live native-path PTT capture remains the only artifact that would pin *that* path (docs 94/95 forensics are storage-only and do not touch it). But that native profile is distinct from — and not needed for — the readable JS PTT encoder config above, which is what the Web/Electron port (§5) actually reuses.
6. **[RESOLVED] `AddRotateTransform`/exif orientation.** *Was: exposed by native `Transcoder` but no managed caller passing a non-default orientation found.* Confirmed by exhaustive grep over `decompiled/WhatsApp.Root/`: the **only** transform the managed layer ever calls is `transcoder.AddMaxEdgeTransform((uint)num)` (`NativeTranscodeWrapper.cs:234`). There is **no managed caller of `AddRotateTransform` or `AddClipRectangleTransform`** anywhere in the decompiled C#. So exif-orientation/rotation is handled either inside the native encoder (which reads the source rotation matrix itself) or upstream in JS — never driven from the C# transcode wrapper. (The transform is part of the projected ABI for completeness but is dead from the managed side.)
7. **[RESOLVED] `MediaTranscodingBridge.Subscribe` callers.** *Was: whether JS subscribes once at init was inferred from the bridge pattern, not traced.* Confirmed in the bundle: the JS transcoder-bridge wrapper constructor (`WindowsHybridBridgeMediaTranscoder_v*`, instantiated as `new …(e, hostObjects.MediaTranscodingBridge)` in `U2j2EhR17gV.js`) runs `this.$1.addEventListener("onProgressChangedEvent", this.$6), this.$1.subscribe(null)` — i.e. JS registers the `onProgressChangedEvent` listener and calls **`subscribe(null)` exactly once at bridge construction** (the implicit `IMediaTranscodingBridgeToWeb` is supplied by the host-object projection, hence the `null` arg). Progress is then logged as `[onProgressChanged] sourceBufferId=…, percentage=…`. This matches the native `OnProgressChanged`→`ProgressInfo` single-callback design (§3.1.1/§3.1.2).
8. **[RESOLVED] MMS-retry AAD byte-layout (§3.7.3).** *Was: AAD built from `stanzaId` via `s({stanzaId})` but encoder aliased ambiguously; enc_iv reuse-vs-fresh and ciphertext placement unverified.* All three sub-questions resolved from `WAWebCryptoMediaRetry` (`xTiXmyjNEd_.js`): (a) **AAD byte layout** — `s({stanzaId})` is literally `encodeProtobuf(ServerErrorReceiptSpec, {stanzaId})` → the AAD is the **protobuf-encoded `ServerErrorReceipt` message**, i.e. bytes `0x0A <len> <stanzaId-UTF8>` (field 1, string). (b) **enc_iv reuse** — the encrypt path is `a = (n==null ? g() : n.slice())` where `g()` is a fresh 12-byte random IV: so the responder **reuses the requester-supplied IV when one is passed, otherwise generates a fresh 12-byte IV** (`p=12`). (c) **Ciphertext placement** — the encrypted payload rides as a `<encrypt><enc_p>{ciphertext}</enc_p><enc_iv>{iv}</enc_iv></encrypt>` subtree; the request also carries `enc_p`/`enc_iv` (`wap("enc_p",null,l),wap("enc_iv",null,s)`). Key = `HKDF.extractAndExpand(mediaKey,"WhatsApp Media Retry Notification",32)`; cipher = `WACryptoAesGcm.gcmEncrypt(key,iv,aad,plaintext)`.
9. **[RESOLVED] `messageSecret` (proto field 4) usage (§3.7.2).** *Was: present in JS spec, absent from C#; unclear if alternate key source vs `mediaKey`-HKDF.* The field is confirmed: `MediaRetryNotificationSpec = {stanzaId:[1,STRING], directPath:[2,STRING], result:[3,ENUM], messageSecret:[4,BYTES]}` (`SjCAw…WiG.js`). **It is NOT the key source for the retry-notification crypto** — `decryptMediaRetryNotification(mediaKey, …)` and `encryptServerErrorReceipt(mediaKey, …)` both key exclusively off `mediaKey` via the `"WhatsApp Media Retry Notification"` HKDF (`xTiXmyjNEd_.js`, see item 8). So `messageSecret` here is the standard per-message `messageContextInfo.messageSecret` (the same 32-byte secret used for poll/reaction/bot/edit message-secret encryption elsewhere in the bundle), carried so the re-uploaded message's own secret-keyed content can be re-derived — **not** an alternative notification key. **The downstream consumer is now traced (cross-reference: open WA-protocol impls + bundle):** (a) the retry-notification AES-GCM decrypt provably never reads field 4 — `whatsmeow/mediaretry.go:24-41,121-137` (`getMediaRetryKey(mediaKey)=HKDF-SHA256(mediaKey,"WhatsApp Media Retry Notification",32)`; `encryptMediaRetryReceipt`/`DecryptMediaRetryNotification` key only off `mediaKey`, AAD = the raw `stanzaId`/messageID bytes), and `whatsmeow`'s `MediaRetryNotification` proto carries `optional bytes messageSecret = 4` (`whatsmeow/proto/waMmsRetry/WAMmsRetry.proto:16`) as a pure carry-through field its retry path ignores; (b) `messageSecret` is the per-message secret of the **reporting-token / message-secret-keyed-content family**: the bundle nulls-throws it for poll creation (`waweb-unmin/tkDChMdGJWh.js:24355` `WANullthrows(t.messageSecret, "Poll creation missing message secret")`), generates it gated on `isReportingTokenSendingEnabled()` (`waweb-unmin/Ymf7dLpgIe9.js:40877`), and feeds it to the reporting-token validator (`waweb-unmin/xYtQRkl-g7z.js:18188` `WAWebGroupHistoryReportingTokenValidator.prepareValidationContext(…C.messageSecret…)`); Baileys gates the reporting-token attach on exactly `reportingMessage.messageContextInfo.messageSecret && shouldIncludeReportingToken(...)` (`Baileys/src/Socket/messages-send.ts:1036`). So field 4 is the standard `messageContextInfo.messageSecret` used to re-derive the re-uploaded message's own secret-keyed content / reporting token — **independent of** the `mediaKey`-derived notification key — and a port preserves it verbatim as BYTES, copying it from `messageContextInfo` rather than deriving it. (Label: cross-reference — whatsmeow `mediaretry.go` + `proto/waMmsRetry/WAMmsRetry.proto`, Baileys `messages-send.ts`, bundle `waweb-unmin/*.js`; not read from the native Windows binary, which has no live retry code per item 11.)
10. **[RESOLVED] Server-vs-peer `ServerErrorReceipt` path.** *Was: unclear whether the receipt goes to the mms server or is the durable form of the peer `rmr` request.* It is **peer-directed**, not server-directed. JS emits it as `wap("receipt", {type:"server-error", to: USER_JID(peer), id: stanzaId, category:"peer"}, wap("encrypt", null, wap("enc_p",null,ciphertext), wap("enc_iv",null,iv)))` (`xTiXmyjNEd_.js`) — `to:USER_JID` + `category:"peer"` route it to the **peer device**, encrypted with the same `mediaKey`-HKDF AES-GCM as the notification. So "server-error" names the *cause* (the mms host couldn't serve/return the blob), while the *receipt itself travels peer-to-peer* alongside the `rmr`/`mediaretry` exchange. `SendMediaRetryServerError` (`PersistentAction.cs:49`) is just the durable/queued C# job that surfaces this same JS-encoded receipt across restarts.
11. **[RESOLVED] Native `MediaRetryNotification`/`ServerErrorReceipt` C# usage.** *Was: protobuf classes exist but no native caller found; assumed dead/parity code, not exhaustively proven.* Now exhaustively proven: a grep over the entire `decompiled/` C# tree shows **all 7 files** referencing `MediaRetryNotification`/`ServerErrorReceipt` live inside the **`WhatsApp.Protobuf` assembly only** — the generated message bodies (`GProtoBuf`/`ProtoBuf` mirrors + `MmsRetryReflection`) plus `Message.cs`, which merely **reuses the `MediaRetryNotification.Types.ResultType` enum** for its `PeerDataOperationResult.MediaUploadResult` field (`Message.cs:12850,12876,13166`). There is **zero** reference in any runtime assembly (`WhatsApp.Root`, `WhatsApp.Networking`, `WhatsApp.VoIP`, `WhatsApp.DataModels`). So the C# protobuf classes are confirmed parity/dead code; the live encode/decode is entirely in JS (`WAWebCryptoMediaRetry` + `WAWebProtobufsMmsRetry.pb`).
