import type { ForgeConfig } from '@electron-forge/shared-types';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerAppImage } from '@reforged/maker-appimage';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

const hasBin = (bin: string): boolean => {
  try { execSync(`command -v ${bin}`, { stdio: 'ignore', shell: '/bin/sh' }); return true; }
  catch { return false; }
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Real WhatsApp app icon (vendored from the Windows/macOS clients into assets/).
    // Packager appends the per-platform extension: .ico (win), .icns (mac).
    icon: 'assets/icon',
  },
  rebuildConfig: {},
  hooks: {
    // The Vite plugin's packager ignore keeps only `/.vite`, so node_modules is
    // stripped. Native modules are external (not bundled), so copy their runtime
    // closure back in; AutoUnpackNatives then unpacks the .node files from asar.
    // ponytail: hand-listed closure. If a native dep gains a runtime dep, add it here.
    async packageAfterCopy(_config, buildPath) {
      const mods = [
        'better-sqlite3', 'bindings', 'file-uri-to-path',
        '@signalapp/libsignal-client', 'node-gyp-build',
      ];
      for (const m of mods) {
        await fs.cp(
          path.resolve(__dirname, 'node_modules', m),
          path.join(buildPath, 'node_modules', m),
          { recursive: true },
        );
      }
    },
    // AppImage entrypoint (MakerAppImage bin points here; inert in deb/rpm/zip). Written
    // at the PACKAGE ROOT next to the WhatsWine binary — packageAfterCopy's buildPath
    // would bury it inside app.asar. The payload's chrome-sandbox can never be setuid on
    // an AppImage's nosuid mount, so on kernels that also block unprivileged user
    // namespaces (Ubuntu 24.04+ AppArmor default) Chromium has NO usable sandbox and
    // FATALs at startup. Probe userns and fall back to --no-sandbox only when blocked.
    async postPackage(_config, pkg) {
      for (const p of pkg.outputPaths ?? []) {
        await fs.writeFile(path.join(p, 'whatswine-appimage.sh'), `#!/bin/sh
d="$(dirname "$(readlink -f "$0")")"
if unshare --user --map-root-user true 2>/dev/null; then
  exec "$d/WhatsWine" "$@"
else
  echo "[whatswine] unprivileged user namespaces are blocked on this system - running with --no-sandbox (install the .deb/.rpm for a fully sandboxed setup)" >&2
  exec "$d/WhatsWine" --no-sandbox "$@"
fi
`, { mode: 0o755 });
      }
    },
  },
  makers: [
    // desktopTemplate adds StartupWMClass so GNOME/Wayland ties an app-list click
    // to the running (tray-hidden) instance instead of doing nothing.
    // `bin` must match the packaged binary, which comes from productName (WhatsWine),
    // not the package `name` the deb maker defaults to (whatswine).
    // Every maker is gated on its external tool: forge aborts the WHOLE make when any
    // resolved maker can't run, and a host missing one tool should still get the rest.
    ...(hasBin('dpkg')
      ? [new MakerDeb({ options: { bin: 'WhatsWine', icon: 'assets/icon.png', desktopTemplate: path.resolve(__dirname, 'assets/whatswine.desktop.ejs') } })]
      : (console.warn('[forge] dpkg not found — skipping deb maker'), [])),
    // rpm: Fedora/RHEL/openSUSE. Same bin/icon reasoning as the deb above; the rpm maker
    // has no desktopTemplate option, so its .desktop lacks StartupWMClass (see PACKAGING.md).
    // The rpm>=4.20 spec-template incompatibility is patched by postinstall — see
    // packaging/rpm/patch-spec.mjs.
    // scripts.post: container test showed the rpm ships chrome-sandbox 755 (deb's postinst
    // sets 4755) — the %post restores the setuid sandbox. Untyped in forge, hence the cast.
    ...(hasBin('rpmbuild')
      ? [new MakerRpm({ options: { bin: 'WhatsWine', icon: 'assets/icon.png', scripts: { post: path.resolve(__dirname, 'packaging/rpm/post.sh') } } } as ConstructorParameters<typeof MakerRpm>[0])]
      : (console.warn('[forge] rpmbuild not found — skipping rpm maker (apt install rpm)'), [])),
    // zip: distro-agnostic archive fallback (also the artifact an AUR PKGBUILD can repack).
    new MakerZIP({}),
    // AppImage: universal single-file. No setuid chrome-sandbox inside an AppImage — the
    // sandbox rides on unprivileged user namespaces (Ubuntu 24.04 caveat in PACKAGING.md).
    // Gated on mksquashfs (squashfs-tools): forge aborts the WHOLE make when any maker's
    // external binary is missing, and hosts without it should still get deb/rpm/zip.
    ...(hasBin('mksquashfs')
      ? [new MakerAppImage({ options: { bin: 'whatswine-appimage.sh', categories: ['Network', 'InstantMessaging'], genericName: 'WhatsApp Client', icon: 'assets/icon.png' } })]
      : (console.warn('[forge] mksquashfs not found — skipping AppImage maker (apt install squashfs-tools)'), [])),
  ],
  plugins: [
    // Keeps native modules (better-sqlite3, libsignal) out of the asar so their
    // .node binaries can be require()'d at runtime — Vite leaves them external.
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      // No local renderer: the window loads the remote WhatsApp Web bundle
      // (src/main.ts -> loadURL), so there is no app-owned HTML/renderer to build.
      renderer: [],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
