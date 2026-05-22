# vendor/mathjax/

Vendored MathJax — the editor has no bundler, so this is committed
rather than resolved from `node_modules` at runtime. It is loaded over
the `app://` scheme by a `<script>` tag in `../../index.html`.

| File | Source | Purpose |
|------|--------|---------|
| `tex-svg.js` | `mathjax@3.2.2`, its `es5/tex-svg.js` | TeX input, SVG output, all in one self-contained file |

The `tex-svg` build is used deliberately: SVG output carries its glyph
shapes inline, so there are no font files to vendor and nothing is
fetched at runtime. To refresh it, `npm pack mathjax@<version>` and copy
`package/es5/tex-svg.js` from the tarball.

MathJax is loaded once, for the whole app, and typesets HTML in the view
on demand — currently the bodies of sticky notes (`src/sticky-notes.js`).
