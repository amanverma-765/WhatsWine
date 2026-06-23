#!/usr/bin/env python3
# Dump WhatsApp Web IndexedDB (Chromium LevelDB) records -> readable strings.
# Focus: signal-storage / noise / appstate object stores. Prints key + printable runs.
import sys, re
from pathlib import Path

LDB = Path(sys.argv[1])
try:
    from ccl_leveldb import RawLevelDb
except Exception as e:
    print("NO ccl_leveldb:", e); sys.exit(2)

ascii_re = re.compile(rb'[\x20-\x7e]{4,}')
def utf16(b):
    out = []
    i = 0
    cur = bytearray()
    while i + 1 < len(b):
        if b[i+1] == 0 and 0x20 <= b[i] <= 0x7e:
            cur.append(b[i])
        else:
            if len(cur) >= 4: out.append(bytes(cur).decode('latin1'))
            cur = bytearray()
        i += 2
    if len(cur) >= 4: out.append(bytes(cur).decode('latin1'))
    return out

KEYWORDS = ('signal','noise','identity','prekey','session','senderkey','sender-key',
            'appstate','app_state','app-state','critical','companion','registration',
            'WASignal','adv','wawc','model-storage','staticKey','privKey','pubKey','indexedDB')

db = RawLevelDb(str(LDB))
seen = 0
hits = 0
store_names = set()
for rec in db.iterate_records_raw():
    seen += 1
    val = rec.value or b''
    key = rec.key or b''
    blob = key + b'\x00' + val
    strs = [s.decode('latin1') for s in ascii_re.findall(blob)] + utf16(blob)
    joined = ' '.join(strs)
    low = joined.lower()
    if any(k.lower() in low for k in KEYWORDS):
        hits += 1
        # collect probable object-store / key names
        for s in strs:
            if any(k.lower() in s.lower() for k in KEYWORDS) and len(s) < 80:
                store_names.add(s.strip())
        if hits <= 400:
            print('--- rec#%d state=%s klen=%d vlen=%d' % (seen, getattr(rec,'state',''), len(key), len(val)))
            # print up to ~12 readable strings per record, truncated
            for s in strs[:12]:
                s = s.strip()
                if len(s) >= 4:
                    print('   ', (s[:120]))
print('=== TOTAL records: %d ; crypto-relevant: %d' % (seen, hits))
print('=== distinct store/key-ish names:')
for n in sorted(store_names)[:120]:
    print('   ', n)
