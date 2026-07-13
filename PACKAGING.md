# Packaging & publishing WhatsWine for Linux

One `npm run make:linux` produces four artifacts under `out/make/`; the `packaging/`
directory holds ready-to-adapt skeletons for the three store channels that need their
own build tooling. Coverage:

| Artifact | Built by | Covers | Publish channel |
|---|---|---|---|
| `.deb` | `make:linux` | Debian, Ubuntu, Mint, Pop!_OS | GitHub Releases (optional: own apt repo / PPA) |
| `.rpm` | `make:linux` (needs `rpmbuild`) | Fedora, RHEL/Alma/Rocky, openSUSE | GitHub Releases (optional: Fedora COPR, openSUSE OBS) |
| `.zip` | `make:linux` | any distro, manual install | GitHub Releases; input for flatpak/snap repacks |
| `.AppImage` | `make:linux` | any distro, single file | GitHub Releases (+ listing on AppImageHub) |
| `PKGBUILD` | `packaging/aur/` | Arch, Manjaro, EndeavourOS | AUR (`whatswine-bin`) |
| flatpak manifest | `packaging/flatpak/` | everything with Flatpak | Flathub |
| `snapcraft.yaml` | `packaging/snap/` | Ubuntu ecosystem | Snap Store |

## Build

```bash
npm run make:linux:portable  # RELEASE build → out/make-portable/ (use this for publishing)
npm run make:linux           # dev build on the host → out/make/
npm run make -- --platform=linux --arch=arm64   # arm64 variants (build on an arm64 host
                                                # or under qemu; native modules must compile)
```

**Publish only portable builds.** Native modules (better-sqlite3, libsignal) link the
build machine's glibc; a rolling-release host silently raises the floor — a host build
demanded glibc 2.38 and broke Debian 12 / Ubuntu 22.04 (verified in containers: Electron
booted, the SQLite bridge failed). `make:linux:portable` runs the whole make inside an
ubuntu:22.04 builder image (`packaging/builder/`), pinning the floor at glibc 2.35 —
covers Ubuntu 22.04+, Debian 12+, Fedora 36+, openSUSE 15.4+.

Host requirements: `dpkg`/`fakeroot` (deb), `rpmbuild` (rpm — `apt install rpm` on
Debian-based hosts), `mksquashfs` (AppImage — `apt install squashfs-tools`; the maker is
skipped with a warning when it's missing, so `make:linux` still yields deb/rpm/zip). zip
needs nothing extra.

## Release flow (recommended)

1. Bump the version everywhere it is pinned: `package.json` `version`,
   `packaging/aur/PKGBUILD` `pkgver`, the `<release>` entry in
   `packaging/flatpak/*.metainfo.xml`, `packaging/snap/snapcraft.yaml` `version`, and the
   hardcoded `WhatsWine-linux-x64-<ver>.zip` filenames in the flatpak manifest and
   snapcraft part source.
2. `npm run make:linux:portable`, smoke the artifacts from `out/make-portable/`
   (`HYBRID_SMOKE=1` on the packaged binary, or install the deb in a container and launch
   — see the docker test scripts pattern: install → `xvfb-run … --no-sandbox` → grep
   "registered 29 host-object bridges" / "SMOKE PASS").
3. Cut the release from CI (on-demand only — nothing runs automatically):
   `gh workflow run release` (or Actions tab → release → Run workflow, or push a
   `v<version>` tag). The workflow (`.github/workflows/release.yml`) builds
   deb/rpm/zip/AppImage (portable builder), the snap, and a `.flatpak` bundle, then
   publishes them all + `SHA256SUMS` on the `v<version>` GitHub Release.
4. AUR: put the release-deb sha256 into `PKGBUILD`, `makepkg --printsrcinfo > .SRCINFO`,
   push to `ssh://aur@aur.archlinux.org/whatswine-bin.git`.
5. Flathub / Snap Store: see caveats below before submitting.

## Sandbox notes (why some formats need care)

Chromium's setuid sandbox (`chrome-sandbox` root:root 4755) is only guaranteed by the
**deb/rpm** post-install scripts (the rpm `%post` lives in `packaging/rpm/post.sh` — the
deb maker ships its own; a container test caught the rpm installing 755) and the **AUR**
`package()` chmod. Formats that can't setuid fall back to unprivileged user namespaces:

- **AppImage / zip**: works out of the box on most modern kernels. Ubuntu 23.10+
  restricts unprivileged userns via AppArmor — users there need
  `sysctl kernel.apparmor_restrict_unprivileged_userns=0`, an AppArmor profile, or the
  deb instead. Don't ship `--no-sandbox` as a default for these.
- **Flatpak**: no setuid inside the sandbox; the manifest wraps the binary with
  `zypak-wrapper` (from `org.electronjs.Electron2.BaseApp`), the standard Electron answer.
- **Snap**: strict confinement + the `browser-support` plug provides the sandbox story;
  the skeleton passes `--no-sandbox` to Electron because snapd's confinement replaces it
  (this is the documented pattern for Chromium-based snaps).

Also: the rpm's `.desktop` file lacks `StartupWMClass` (the rpm maker has no
`desktopTemplate` option), so on GNOME/Wayland clicking the app icon while WhatsWine is
tray-hidden may not focus the running instance. The deb/AUR/flatpak desktop files set it.

## Trademark / ToS caveat before public store submissions

WhatsWine is an **unofficial** client: it vendors the real WhatsApp icon
(`assets/icon.png`) and automates WhatsApp Web. For GitHub Releases and AUR this is the
same posture as other unofficial clients. **Flathub and the Snap Store apply brand review**
— expect the vendored WhatsApp icon and any "WhatsApp" naming in the listing to be
rejected or later taken down (precedents: unofficial clients there ship their own artwork,
e.g. ZapZap, WhatSie). Before submitting to either store: replace the icon with original
artwork, keep "unofficial" in the summary (the metainfo already says so), and accept the
residual account-ban/ToS risk that applies to all unofficial WhatsApp clients.

## What each skeleton still needs from you

- `packaging/aur/PKGBUILD`: real GitHub `url`, release sha256, AUR repo push.
- `packaging/flatpak/*.yml`: zip path/version per release; icon swap for Flathub.
  **Container-verified** (build + full smoke): privileged ubuntu:24.04 + flatpak-builder,
  needs a system dbus (`mkdir -p /run/dbus && dbus-daemon --system --fork`) wrapped in
  `dbus-run-session`, `--state-dir` on the same fs as the build dir, and `--no-sandbox`
  forwarded only because containers run as root — real desktops need none of that.
- `packaging/snap/snapcraft.yaml`: copy the release zip + `assets/icon.png` in (header
  comment), build with the `ghcr.io/canonical/snapcraft:8_core24` container in
  `--destructive-mode`, `snapcraft register whatswine`, then upload. **Container-verified**
  (pack + payload smoke). No `gnome` extension on purpose: its command-chain helpers are
  missing in the snapcraft container images, so the GTK runtime is staged directly
  (electron-builder's snaps use the same shape). snapd *confinement* itself can't run in
  docker — do one `snap install --dangerous` on a real system before first publish.
- App id `com.ark.whatswine` must stay stable forever once published on Flathub.
