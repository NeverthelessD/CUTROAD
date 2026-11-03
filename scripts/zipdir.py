#!/usr/bin/env python3
"""Zip the contents of a folder (optionally only one sub-folder of it).
usage: zipdir.py <base dir> <out.zip> [sub-folder]"""
import os, sys, zipfile

base, out = sys.argv[1], sys.argv[2]
root = os.path.join(base, sys.argv[3]) if len(sys.argv) > 3 else base
if os.path.exists(out):
    os.remove(out)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for dp, dn, fn in os.walk(root):
        dn.sort()
        for f in sorted(fn):
            p = os.path.join(dp, f)
            z.write(p, os.path.relpath(p, base))
