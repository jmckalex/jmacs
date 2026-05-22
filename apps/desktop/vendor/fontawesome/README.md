# vendor/fontawesome/

Vendored Font Awesome Free — the editor has no bundler, so this is
committed rather than resolved from `node_modules`. The stylesheet is
loaded over the `app://` scheme by a `<link>` in `../../index.html`.

| Path | Source | Purpose |
|------|--------|---------|
| `css/all.min.css` | `@fortawesome/fontawesome-free@7.2.0` | the icon styles |
| `webfonts/*.woff2` | `@fortawesome/fontawesome-free@7.2.0` | the icon webfonts (solid, regular, brands, v4 compat) |

`css/all.min.css` references the webfonts by the relative `../webfonts/`
path, so the two directories must stay siblings. To refresh, `npm pack
@fortawesome/fontawesome-free@<version>` and copy `package/css/all.min.css`
and `package/webfonts/` from the tarball.

The free icons are available app-wide as `<i class="fa-solid fa-…">`;
sticky notes use them for the collapse control and the collapsed-note
icon (`src/sticky-notes.js`).
