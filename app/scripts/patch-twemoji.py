#!/usr/bin/env python3
"""Builds src/assets/fonts/twemoji.woff2 from the twemoji-colr-font package (Twemoji as a COLR font).

Chromium (and so WebView2) drops U+FE0F before the font's ligatures run, so every sequence with FE0F in
the middle (keycaps 1️⃣, 🏳️‍🌈, ❤️‍🔥, 🕵️‍♀️, ...) fell apart into blank or separate glyphs. This adds the
same ligatures without FE0F. Also renames the family so it never clashes with an installed Twemoji.

Needs fontTools + brotli:  python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
Run from app/:             /tmp/ft/bin/python scripts/patch-twemoji.py
"""

from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.tables.otTables import Ligature

APP = Path(__file__).resolve().parent.parent
SRC = APP / "node_modules/twemoji-colr-font/twemoji.woff2"
OUT = APP / "src/assets/fonts/twemoji.woff2"
FAMILY = "Linkord Twemoji"

font = TTFont(SRC)
added = 0
for lookup in font["GSUB"].table.LookupList.Lookup:
    for sub in lookup.SubTable:
        for ligs in (getattr(sub, "ligatures", None) or {}).values():
            have = {tuple(l.Component) for l in ligs}
            for lig in list(ligs):
                comp = [g for g in lig.Component if g != "ufe0f"]
                if comp and comp != lig.Component and tuple(comp) not in have:
                    alt = Ligature()
                    alt.Component, alt.LigGlyph, alt.CompCount = comp, lig.LigGlyph, len(comp) + 1
                    ligs.append(alt)
                    have.add(tuple(comp))
                    added += 1
            # Longest sequences first, so a shorter one never wins over a full ZWJ sequence.
            ligs.sort(key=lambda l: -len(l.Component))

for rec in font["name"].names:
    if rec.nameID in (1, 4, 16):
        rec.string = FAMILY
    elif rec.nameID == 6:
        rec.string = FAMILY.replace(" ", "")

OUT.parent.mkdir(parents=True, exist_ok=True)
font.flavor = "woff2"
font.save(OUT)
print(f"{OUT.relative_to(APP)}: added {added} ligatures without FE0F")
