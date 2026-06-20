/**
 * @file LaTeX — tree-sitter language registration.
 *
 * The grammar is the latex-lsp / pfoerster fork
 * (`@pfoerster/tree-sitter-latex@0.6.0` on npm — same grammar used by
 * Helix and nvim-treesitter). The package ships only C source, so
 * `scripts/build-grammars.sh` produces `tree-sitter-latex.wasm` via the
 * `tree-sitter build --wasm --docker` toolchain. See `../../vendor/README.md`.
 *
 * The query mirrors Sublime Text's "JMarkdown" LaTeX palette (the
 * reference the architect highlights math against). Measured against a
 * side-by-side, that palette is four colours plus the body foreground —
 * notably it uses **no green** in math (so the old `@string` delimiters
 * were wrong), and it renders every command in *italic*:
 *
 *   - Greek / accents / named symbols   @latex-symbol  (purple, italic):
 *       \alpha…\omega, \Gamma…\Omega, \hat \bar \vec \dot \tilde …,
 *       \hbar \partial \nabla \dagger \infty …, and \begin / \end.
 *   - All other `\command`s            @latex-command (blue, italic):
 *       \frac \sqrt \left \right \lvert \rangle \tfrac \qquad \mathbf …
 *   - Environment names                 @type     (article, align, pmatrix)
 *   - Math `$…$` `$$…$$` `\(…\)` `\[…\]` delimiters, plus `^ _ & = + -`
 *     super/subscripts, alignment and operators  @operator (teal). The
 *     delimiter *tokens* are faced, not the whole span, so numbers and
 *     identifiers inside math keep their natural face.
 *   - Numbers (coords, counters, sizes) @number   (orange)
 *   - \label / \ref / \cite             @link     (the argument text)
 *   - `%` comments                      @comment
 *   - braces / brackets                 @paren
 *
 * The two command faces (`latex-command`, `latex-symbol`) are dedicated
 * rather than reusing `@function` / `@keyword` because they carry
 * `font-style: italic`, and because markdown math is injected (the
 * editor root only tags the buffer's *major* mode, so mode-scoped CSS
 * can't reach injected LaTeX) — the italic has to ride on the face
 * itself. See `apps/desktop/styles.css` (`.tok-latex-command` /
 * `.tok-latex-symbol`).
 *
 * Plus TikZ-specific touches:
 *
 *   - `\node`, `\draw`, `\path`, `\fill`, `\foreach`, `\coordinate`,
 *     `\matrix`, `\shade`, … → @tag (the red accent that announces
 *     "this is drawing code"). Restricted via #match? on the command
 *     name; the corresponding #not-match? on the @latex-command rule
 *     keeps each token in exactly one face.
 *   - Anchor words inside a curly_group — north, south.east, center, … →
 *     @constant.
 *   - Numeric coordinates and sizes (`1`, `0.5`, `2pt`) → @number, picked
 *     out of plain (word) nodes via a numeric regex predicate.
 *
 * The TikZ rules are name-anchored rather than environment-restricted
 * because tree-sitter has no ancestor-context predicate and a strict
 * structural restriction would only catch direct children of the
 * tikzpicture environment — half the lines in a real TikZ block are
 * nested inside other groups. The TikZ control sequences listed here
 * are TikZ-only in practice (no document uses `\foreach` outside TikZ
 * / pgffor), so faceing them as @tag wherever they occur is safe.
 */

import { registerLanguage } from '../language-registry.js';
import { latexFolds } from '../latex-folds.js';

// Greek letters, accents and named math symbols that Sublime's JMarkdown
// palette renders purple (the @latex-symbol face). `command_name` text
// includes the leading backslash; in this template-literal query each
// literal `\` needs eight source backslashes (JS halves to four, the
// tree-sitter query parser halves to two, the regex reads `\\` → one `\`).
const SYMBOL_COMMANDS =
  '^\\\\\\\\(alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|' +
  'vartheta|iota|kappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|' +
  'tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|' +
  'Sigma|Upsilon|Phi|Psi|Omega|hat|widehat|bar|overline|vec|dot|ddot|dddot|' +
  'tilde|widetilde|check|breve|acute|grave|mathring|hbar|hslash|partial|' +
  'nabla|dagger|ddagger|infty|ell|Re|Im|aleph|wp|prime|imath|jmath)$';

// TikZ drawing commands faced as @tag (and excluded from @latex-command).
const TIKZ_COMMANDS =
  '^\\\\\\\\(node|draw|path|fill|filldraw|clip|coordinate|foreach|matrix|' +
  'shade|shadedraw|useasboundingbox)$';

const QUERY = `
  ; --- comments ------------------------------------------------------
  (line_comment)  @comment
  (block_comment) @comment

  ; --- generic commands: split into two italic faces ----------------
  ; Greek / accents / symbols → @latex-symbol (purple); everything else
  ; (except the TikZ specials, faced @tag below) → @latex-command (blue).
  ; The #not-match?es keep every command in exactly one face so the
  ; splitter never sees an overlapping pair on the same offsets.
  ((generic_command command: (command_name) @latex-symbol)
   (#match? @latex-symbol "${SYMBOL_COMMANDS}"))
  ((generic_command command: (command_name) @latex-command)
   (#not-match? @latex-command "${TIKZ_COMMANDS}")
   (#not-match? @latex-command "${SYMBOL_COMMANDS}"))

  ; --- sectioning command tokens → @keyword -------------------------
  (part           command: _ @keyword)
  (chapter        command: _ @keyword)
  (section        command: _ @keyword)
  (subsection     command: _ @keyword)
  (subsubsection  command: _ @keyword)
  (paragraph      command: _ @keyword)
  (subparagraph   command: _ @keyword)

  (title_declaration  command: _ @keyword)
  (author_declaration command: _ @keyword)

  ; --- packages / classes / includes → @keyword ---------------------
  (class_include    command: _ @keyword)
  (package_include  command: _ @keyword)
  (latex_include    command: _ @keyword)
  (bibtex_include   command: _ @keyword)
  (bibstyle_include command: _ @keyword)
  (import_include   command: _ @keyword)
  (graphics_include command: _ @keyword)
  (verbatim_include command: _ @keyword)
  (svg_include      command: _ @keyword)
  (inkscape_include command: _ @keyword)
  (tikz_library_import command: _ @keyword)

  ; --- command / environment definitions → @keyword -----------------
  (new_command_definition       command: _ @keyword)
  (old_command_definition       command: _ @keyword)
  (let_command_definition       command: _ @keyword)
  (environment_definition       command: _ @keyword)
  (theorem_definition           command: _ @keyword)
  (paired_delimiter_definition  command: _ @keyword)
  (color_definition             command: _ @keyword)
  (color_set_definition         command: _ @keyword)
  (glossary_entry_definition    command: _ @keyword)
  (acronym_definition           command: _ @keyword)
  (label_definition             command: _ @keyword)
  (label_reference              command: _ @keyword)
  (label_reference_range        command: _ @keyword)
  (citation                     command: _ @keyword)

  ; --- environment open / close: \\\\begin / \\\\end → @latex-symbol
  ;     (purple, italic — same as the symbol commands); name → @type
  (begin command: _ @latex-symbol)
  (end   command: _ @latex-symbol)
  (begin name: (curly_group_text text: (text) @type))
  (end   name: (curly_group_text text: (text) @type))

  ; --- math delimiters → @operator (teal) ---------------------------
  ; Faceing the delimiter tokens rather than the whole node keeps inner
  ; captures (numbers, command names) visible at their natural face and
  ; sidesteps the splitter's no-overlap precondition.
  (inline_formula     [ "$" "\\\\(" "\\\\)" ] @operator)
  (displayed_equation [ "$$" "\\\\[" "\\\\]" ] @operator)
  ; \\\\left / \\\\right size the surrounding delimiters — blue, like a command.
  (math_delimiter [ "\\\\left" "\\\\right" ] @latex-command)

  ; --- super/subscripts, alignment & infix operators → @operator ----
  (superscript "^" @operator)
  (subscript   "_" @operator)
  (operator) @operator
  (delimiter) @operator
  "=" @operator

  ; --- labels / refs / cites — argument text faces as a link --------
  (label_definition name: (curly_group_label (label) @link))
  (label_reference  names: (curly_group_label_list (label) @link))
  (label_reference_range from: (curly_group_label (label) @link))
  (label_reference_range to:   (curly_group_label (label) @link))
  (citation         keys:  (curly_group_text_list (text) @link))

  ; --- braces / brackets → @paren -----------------------------------
  [ "{" "}" "[" "]" ] @paren

  ; --- TikZ specials: \\\\node, \\\\draw, … → @tag ------------------
  ((generic_command command: (command_name) @tag)
   (#match? @tag "${TIKZ_COMMANDS}"))

  ; --- TikZ anchor words inside a curly_group → @constant -----------
  ((curly_group
     (text word: (word) @constant))
   (#match? @constant "^(north|south|east|west|center|base|mid|north east|north west|south east|south west)$"))

  ; --- numbers (TikZ coordinates, counter values, sizes) → @number --
  ; Tree-sitter parses numeric tokens as ordinary (word)s. A regex
  ; predicate picks the numeric ones; the cost is one regex per word
  ; capture in the file, paid at query time.
  ((word) @number (#match? @number "^[+-]?[0-9]+(\\\\.[0-9]+)?(pt|mm|cm|in|em|ex|bp|dd|pc|sp)?$"))
`;

registerLanguage({
  tag: 'latex',
  grammar: 'tree-sitter-latex.wasm',
  query: QUERY,
  // Folds come from a pure line scanner, not the grammar: `.tex` editing is
  // hand-tokenised, so there is no tree to query, and the fold path is
  // independent of highlighting anyway. Drives the gutter fold rail and the
  // sticky structure headers (section breadcrumb + environments).
  foldProvider: latexFolds,
  suffixes: ['.tex', '.latex'],
  aliases: ['tex', 'latex'],
});
