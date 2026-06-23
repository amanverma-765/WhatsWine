#!/usr/bin/env python3
# Decode WhatsApp Web IndexedDB via ccl_chromium_reader. Redacts secret bytes (len + first 4 bytes only).
import sys
ldb = sys.argv[1]
from ccl_chromium_reader import ccl_chromium_indexeddb

def red(b):
    if isinstance(b, (bytes, bytearray)):
        return "bytes[%d] %s.." % (len(b), b[:4].hex())
    if isinstance(b, str):
        return "str[%d] %r" % (len(b), (b[:48] + ('..' if len(b) > 48 else '')))
    return type(b).__name__

def summ(v, depth=0):
    if isinstance(v, dict):
        out = {}
        for k, val in list(v.items())[:25]:
            out[str(k)[:32]] = summ(val, depth+1) if depth < 2 else red(val)
        return out
    if isinstance(v, (list, tuple)):
        return "[%d] " % len(v) + (summ(v[0], depth+1) if v and depth < 2 else "")
    return red(v)

wrap = ccl_chromium_indexeddb.WrappedIndexDB(ldb)
for dbid in wrap.database_ids:
    try:
        db = wrap[dbid.dbid_no]
    except Exception as e:
        print("DB", dbid.name, "open-err", e); continue
    print("\n==== DB '%s' (origin %s) stores=%s" % (dbid.name, getattr(dbid,'origin','?'), list(db.object_store_names)))
    for sn in db.object_store_names:
        try:
            store = db.get_object_store_by_name(sn)
            n = 0
            sample = []
            for r in store.iterate_records():
                n += 1
                if n <= 6:
                    try: sample.append((repr(r.key)[:70], summ(r.value)))
                    except Exception as e: sample.append((repr(r.key)[:70], "valerr:%s" % e))
            print("  -- store '%s' : %d records" % (sn, n))
            for k, v in sample:
                print("       key=%s" % k)
                print("       val=%s" % (str(v)[:400]))
        except Exception as e:
            print("  -- store '%s' ERR %s" % (sn, e))
