/**
 * @file LaTeX — tree-sitter language registration.
 *
 * The grammar is the latex-lsp / pfoerster fork
 * (`@pfoerster/tree-sitter-latex@0.6.0` on npm — same grammar used by
 * Helix and nvim-treesitter). The package ships only C source, so
 * `scripts/build-grammars.sh` produces `tree-sitter-latex.wasm` via the
 * `tree-sitter build --wasm --docker` toolchain. See `../../vendor/README.md`.
 *
 * The query targets Sublime-Text-style coverage:
 *
 *   - `\command` →            @function (the catch-all for unknown commands)
 *   - Control words           @keyword  (\section, \begin, \end, \usepackage,
 *                                        \newcommand, sectioning, includes,
 *                                        labels, refs, cites)
 *   - Environment names       @type     (article, equation, tikzpicture)
 *   - Math `$…$`, `\[…\]`     @string   (the delimiter tokens themselves; the
 *                                        body keeps its natural face so numbers
 *                                        and identifiers inside math still read)
 *   - \label / \ref / \cite   @link     (the argument text)
 *   - `%` comments            @comment
 *   - braces / brackets       @paren
 *
 * Plus TikZ-specific touches:
 *
 *   - `\node`, `\draw`, `\path`, `\fill`, `\foreach`, `\coordinate`,
 *     `\matrix`, `\shade`, … → @tag (the red accent that announces
 *     "this is drawing code"). Restricted via #match? on the command
 *     name; the corresponding #not-match? on the @function rule keeps
 *     each token in exactly one face.
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

const QUERY = `
  ; --- comments ------------------------------------------------------
  (line_comment)  @comment
  (block_comment) @comment

  ; --- generic commands: \\\\foo → @function, except TikZ specials --
  ; The TikZ specials (\\\\node, \\\\draw, …) are faced as @tag below;
  ; this #not-match? keeps them out of @function so the splitter never
  ; sees an overlapping pair on the same offsets.
  ((generic_command command: (command_name) @function)
   (#not-match? @function "^\\\\\\\\(node|draw|path|fill|filldraw|clip|coordinate|foreach|matrix|shade|shadedraw|useasboundingbox)$"))

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

  ; --- environment open / close: \\\\begin / \\\\end → @keyword,
  ;     environment name → @type
  (begin command: _ @keyword)
  (end   command: _ @keyword)
  (begin name: (curly_group_text text: (text) @type))
  (end   name: (curly_group_text text: (text) @type))

  ; --- math delimiters → @string ------------------------------------
  ; Faceing the delimiter tokens rather than the whole node keeps inner
  ; captures (numbers, command names) visible at their natural face and
  ; sidesteps the splitter's no-overlap precondition.
  (inline_formula     [ "$" "\\\\(" "\\\\)" ] @string)
  (displayed_equation [ "$$" "\\\\[" "\\\\]" ] @string)

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
   (#match? @tag "^\\\\\\\\(node|draw|path|fill|filldraw|clip|coordinate|foreach|matrix|shade|shadedraw|useasboundingbox)$"))

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
  suffixes: ['.tex', '.latex'],
  aliases: ['tex', 'latex'],
});
