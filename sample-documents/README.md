# Sample documents

A curated corpus of **manual-render test documents** — files you open inside
the editor to eyeball how a given file type is displayed, syntax-highlighted,
or handled by a custom view. They exist to be opened, not to be imported by
any package.

**These are not project source.** Nothing here is built, bundled, or referenced
by the test suite. Do not wire code against these files; treat them as fixtures
for human (or sub-agent) inspection only.

Keep the set curated: roughly one representative file per file type the editor
needs to render. Current contents:

| File             | Exercises                                              |
|------------------|-------------------------------------------------------|
| `Makefile`       | Makefile syntax highlighting (tab-indented recipes)   |
| `fa-stacking.png` | image rendering in the image view                    |
| `math-highlight-test.md` | Markdown + embedded LaTeX math: highlighting (LaTeX injection) and `C-c C-p` MathJax preview — `$…$`, `$$…$$`, `\(…\)`, `\[…\]`, `\begin{…}` envs, plus code/escaped-`$` exclusions |

When you add a sample, add a row above explaining what it is meant to exercise.
