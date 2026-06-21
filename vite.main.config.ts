import { defineConfig } from 'vite';

// https://vitejs.dev/config
// Native addons must stay external (Rollup can't bundle .node binaries); they're
// require()'d from node_modules at runtime and unpacked from asar by
// @electron-forge/plugin-auto-unpack-natives.
export default defineConfig({
  build: {
    rollupOptions: {
      external: ['better-sqlite3', '@signalapp/libsignal-client'],
    },
  },
});
