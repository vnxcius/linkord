#!/usr/bin/env python3
"""Builds src/assets/fonts/twemoji.woff2 from the twemoji-colr-font package (Twemoji as a COLR font).

Chromium (and so WebView2) drops U+FE0F before the font's ligatures run, so every sequence with FE0F in
the middle (keycaps 1️⃣, 🏳️‍🌈, ❤️‍🔥, 🕵️‍♀️, ...) fell apart into blank or separate glyphs. This adds the
same ligatures without FE0F. Where the font already had an FE0F-less sequence pointing elsewhere (👩‍❤‍👨 ->
the generic 💑), the fully-qualified emoji wins, since that is what the picker and other apps send.

Also repairs glyphs the upstream SVG->COLR conversion broke (see LAYER_FIXES) and renames the family so it never
clashes with an installed Twemoji.

It also writes the Android app's copy, android/designsystem/src/main/res/font/twemoji.ttf: the same font as a TTF plus
a cmap format 14 table (see ANDROID_OUT below), so rerunning this after a Twemoji bump updates both clients.

Upstream bugs were found by rendering every emoji with this font and with the official Twemoji SVGs
(@twemoji/svg, same version) in Chromium and comparing the images; recheck that way when bumping the package.

Needs fontTools + brotli:  python3 -m venv /tmp/ft && /tmp/ft/bin/pip install fonttools brotli
Run from app/:             /tmp/ft/bin/python scripts/patch-twemoji.py
"""

from pathlib import Path

from fontTools.pens.recordingPen import DecomposingRecordingPen, RecordingPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables.C_O_L_R_ import LayerRecord
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable
from fontTools.ttLib.tables.otTables import Ligature

APP = Path(__file__).resolve().parent.parent
SRC = APP / "node_modules/twemoji-colr-font/twemoji.woff2"
OUT = APP / "src/assets/fonts/twemoji.woff2"
ANDROID_OUT = APP.parent / "android/designsystem/src/main/res/font/twemoji.ttf"
FAMILY = "Linkord Twemoji"

# Colour glyphs whose layers ended up in the wrong order: glyph -> [(layer, contour, before layer)], indexes into
# the glyph's COLR layer list. The contour moves into a new layer of the same colour, drawn before the given layer.
# 🥺 and 🥹: the left eye's white was merged into a layer drawn over the pupils, hiding the left pupil.
LAYER_FIXES = {
    "u1f97a": [(4, 2, 3)],
    "u1f979": [(5, 2, 4)],
}

font = TTFont(SRC)
added = 0
for lookup in font["GSUB"].table.LookupList.Lookup:
    for sub in lookup.SubTable:
        for ligs in (getattr(sub, "ligatures", None) or {}).values():
            have = {tuple(l.Component): l for l in ligs}
            for lig in list(ligs):
                comp = [g for g in lig.Component if g != "ufe0f"]
                if comp and comp != lig.Component and tuple(comp) in have:
                    have[tuple(comp)].LigGlyph = lig.LigGlyph
                elif comp and comp != lig.Component:
                    alt = Ligature()
                    alt.Component, alt.LigGlyph, alt.CompCount = comp, lig.LigGlyph, len(comp) + 1
                    ligs.append(alt)
                    have[tuple(comp)] = alt
                    added += 1
            # Longest sequences first, so a shorter one never wins over a full ZWJ sequence.
            ligs.sort(key=lambda l: -len(l.Component))



def contours(glyph):
    """The glyph's outline, one recording per contour."""
    rec = DecomposingRecordingPen(font.getGlyphSet())
    font.getGlyphSet()[glyph].draw(rec)
    out, cur = [], []
    for op, args in rec.value:
        cur.append((op, args))
        if op in ("closePath", "endPath"):
            out.append(RecordingPen())
            out[-1].value, cur = cur, []
    return out


new_glyphs = []


def add_glyph(name, parts, advance):
    pen = TTGlyphPen(None)
    for part in parts:
        part.replay(pen)
    glyph = font["glyf"].glyphs[name] = pen.glyph()
    glyph.recalcBounds(font["glyf"])
    # Renderers place the outline by its left side bearing, so it must match the outline's xMin.
    font["hmtx"][name] = (advance, glyph.xMin)
    new_glyphs.append(name)


colr = font["COLR"].ColorLayers
for glyph, moves in LAYER_FIXES.items():
    # Layers are shared between glyphs, so the changed ones become new glyphs.
    layers, advance = colr[glyph], font["hmtx"][glyph][0]
    parts = [contours(layer.name) for layer in layers]
    fixed = []
    for i, layer in enumerate(layers):
        for k, c, before in moves:
            if before == i:
                add_glyph(f"{glyph}.fix{len(new_glyphs)}", [parts[k][c]], advance)
                fixed.append(LayerRecord(new_glyphs[-1], layers[k].colorID))
        gone = {c for k, c, _ in moves if k == i}
        if gone:
            add_glyph(f"{glyph}.fix{len(new_glyphs)}", [p for c, p in enumerate(parts[i]) if c not in gone], advance)
            fixed.append(LayerRecord(new_glyphs[-1], layer.colorID))
        else:
            fixed.append(layer)
    colr[glyph] = fixed
order = font.getGlyphOrder() + new_glyphs
font.setGlyphOrder(order)
font["glyf"].setGlyphOrder(order)

for rec in font["name"].names:
    if rec.nameID in (1, 4, 16):
        rec.string = FAMILY
    elif rec.nameID == 6:
        rec.string = FAMILY.replace(" ", "")

OUT.parent.mkdir(parents=True, exist_ok=True)
font.flavor = "woff2"
font.save(OUT)
print(f"{OUT.relative_to(APP)}: added {added} ligatures without FE0F, fixed {len(LAYER_FIXES)} glyphs")

# Android (Minikin) picks a font per character, and for a character followed by U+FE0F it only keeps a font that
# declares that variation sequence in a cmap format 14 table; otherwise the system emoji font (Noto) wins. So in 🏳️‍🌈
# the flag came from Noto and the rainbow after the ZWJ from Twemoji: two pictures (❤️‍🔥, 1️⃣, 🕵️‍♀️ too). Declaring
# <character, FE0F> as a default variation sequence for every character keeps the whole sequence in Twemoji; HarfBuzz
# then drops the FE0F before GSUB, as Chromium does, and the FE0F-less ligatures above apply. Only the Android copy
# gets it, so the web font stays as it was.
uvs = CmapSubtable.newSubtable(14)
uvs.platformID, uvs.platEncID, uvs.language, uvs.cmap = 0, 5, 0xFF, {}
uvs.uvsDict = {
    0xFE0F: [(cp, None) for cp in sorted(font.getBestCmap()) if cp not in (0x200D, 0xFE0F, 0x20E3) and not 0xE0000 <= cp <= 0xE007F]
}
font["cmap"].tables.append(uvs)
font.flavor = None
font.save(ANDROID_OUT)
print(f"{ANDROID_OUT.relative_to(APP.parent)}: the same as TTF, {len(uvs.uvsDict[0xFE0F])} FE0F sequences declared")
