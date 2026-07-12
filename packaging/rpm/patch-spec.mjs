// Overwrite electron-installer-redhat's spec.ejs with our rpm>=4.20-compatible copy
// (see the header in spec.ejs). electron-installer-redhat 3.x has no specTemplate
// option and hardcodes its bundled template, so postinstall replaces the resource
// wherever npm placed the package. Runs on every `npm install`; silently a no-op
// when the maker isn't installed (e.g. production installs).
// Must NEVER fail `npm install`: any problem is a warning, exit stays 0 — a missed patch
// surfaces later as the rpm maker's cp error, which PACKAGING.md points back here.
import * as fs from 'node:fs';
import path from 'node:path';

try {
  if (typeof fs.globSync !== 'function') throw new Error('fs.globSync requires Node >= 22');
  const ours = path.resolve(import.meta.dirname, 'spec.ejs');
  const targets = fs.globSync('node_modules/**/electron-installer-redhat/resources/spec.ejs');
  for (const t of targets) {
    fs.copyFileSync(ours, t);
    console.log(`[patch-spec] replaced ${t}`);
  }
  if (!targets.length) console.log('[patch-spec] electron-installer-redhat not present — nothing to patch');
} catch (e) {
  console.warn(`[patch-spec] skipped: ${e && e.message ? e.message : e} (rpm builds may fail on rpm >= 4.20 until this runs)`);
}
