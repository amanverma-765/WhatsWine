# analysis/

Reverse-engineering reference behind this Electron port. Hand-written; the raw
dumps and decompiled binaries it was derived from are **not** in this repo.

- **`docs/`** — the RE reference set (`00`–`97`). Start at [`docs/README.md`](./docs/README.md).
  `path:LINE` citations in these docs are relative to the original `decompiled_source/`
  tree (kept outside this repo).
- **`scripts/`** — IDB forensics tooling: `dump_idb.py` (LevelDB string scan),
  `idb2.py` (ccl_chromium_reader decode). `docs/idb_schema.txt` is sample output.

## External reference (not vendored)

Lives outside this repo; re-fetch as needed:

- `decompiled_source/` — decompiled WhatsApp clients (Windows .NET, Ghidra, Android, web bundle).
- Third-party RE repos consulted: Baileys, whatsmeow, whatsapp-web-reveng,
  whatsapp-web-multi-device-reveng, whatsapp-msgstore-viewer.
