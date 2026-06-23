import type { ForgeConfig } from '@electron-forge/shared-types';
import path from 'node:path';
import fs from 'node:fs/promises';
import { MakerDeb } from '@electron-forge/maker-deb';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

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
  },
  makers: [
    // desktopTemplate adds StartupWMClass so GNOME/Wayland ties an app-list click
    // to the running (tray-hidden) instance instead of doing nothing.
    // `bin` must match the packaged binary, which comes from productName (WhatsWine),
    // not the package `name` the deb maker defaults to (whatswine).
    new MakerDeb({ options: { bin: 'WhatsWine', icon: 'assets/icon.png', desktopTemplate: path.resolve(__dirname, 'assets/whatswine.desktop.ejs') } }),
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
