# Build resources

App-icon assets for packaging. electron-builder auto-detects `icon.icns` /
`icon.ico` / `icon.png` in this directory at build time (see **C3** in
`plans/launch/06-audit-remediation.md`).

| File | Use |
|------|-----|
| `icon.icns` | macOS bundle icon — Retina pairs 16→1024 |
| `icon.ico` | Windows — sizes 16→256 |
| `icon.png` | Linux / fallback — 1024px |
| `icon.svg` | master art (the bare tree at dusk), rasterised at 64px+ |
| `icon-small.svg` | bolder, glow-free art for the ≤32px slots (menu-bar / taskbar legibility) |

The mark: Beckett's bare tree under a low moon — *Waiting for Godot* — in the
Mariana palette (`#303841` ground, gold→amber light).

## Regenerate

Needs `rsvg-convert` (librsvg), ImageMagick (`magick`), and macOS `iconutil`.

```sh
# from this directory:
ICONSET=$(mktemp -d)/icon.iconset; mkdir -p "$ICONSET"
r(){ rsvg-convert -w "$1" -h "$1" "$2" -o "$3"; }
# ≤32px → bold variant; 64px+ → detailed
r 16  icon-small.svg "$ICONSET/icon_16x16.png"
r 32  icon-small.svg "$ICONSET/icon_16x16@2x.png"
r 32  icon-small.svg "$ICONSET/icon_32x32.png"
r 64  icon.svg       "$ICONSET/icon_32x32@2x.png"
r 128 icon.svg       "$ICONSET/icon_128x128.png"
r 256 icon.svg       "$ICONSET/icon_128x128@2x.png"
r 256 icon.svg       "$ICONSET/icon_256x256.png"
r 512 icon.svg       "$ICONSET/icon_256x256@2x.png"
r 512 icon.svg       "$ICONSET/icon_512x512.png"
r 1024 icon.svg      "$ICONSET/icon_512x512@2x.png"
iconutil -c icns "$ICONSET" -o icon.icns

for s in 16 24 32 48; do r $s icon-small.svg "ico-$s.png"; done
for s in 64 128 256;  do r $s icon.svg       "ico-$s.png"; done
magick ico-16.png ico-24.png ico-32.png ico-48.png ico-64.png ico-128.png ico-256.png icon.ico
rm -f ico-*.png
rsvg-convert -w 1024 -h 1024 icon.svg -o icon.png
```
