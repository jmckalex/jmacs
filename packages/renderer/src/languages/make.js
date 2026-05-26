/**
 * @file Make / Makefile — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Captures cover the constructs a real Makefile needs to read clearly:
 * recipe text strings, conditional and definition keywords (`ifeq` /
 * `ifdef` / `define` / `endef`), the GNU make built-in functions
 * (`subst`, `patsubst`, `wildcard`, `shell`, …), the automatic
 * variables (`$@`, `$<`, `$^`, …), and the canonical target names
 * (`all`, `clean`, `install`, `.PHONY`, …) which read as constants.
 *
 * Replaces the hand-tokenized fallback in `../highlight.js` for the
 * common case — when the grammar fails to load, that line tokenizer
 * still kicks in.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings ---------------------------------------------
  (comment) @comment
  (text) @string
  (string) @string
  (raw_text) @string
  (variable_assignment (word) @string)

  ; --- conditionals / definitions / include ---------------------------
  [
    "ifeq" "ifneq" "ifdef" "ifndef"
    "else" "endif" "if"
  ] @keyword

  "foreach" @keyword

  [
    "define" "endef" "vpath" "undefine"
    "export" "unexport" "override" "private"
  ] @keyword

  [ "include" "sinclude" "-include" ] @keyword

  ; --- built-in functions (called as $(name ...)) ---------------------
  [
    "subst" "patsubst" "strip" "findstring" "filter" "filter-out"
    "sort" "word" "words" "wordlist" "firstword" "lastword"
    "dir" "notdir" "suffix" "basename" "addsuffix" "addprefix"
    "join" "wildcard" "realpath" "abspath"
    "call" "eval" "file" "value" "shell"
    "or" "and"
  ] @function

  ; The diagnostic functions feel keyword-y; keep them grouped.
  [ "error" "warning" "info" ] @keyword

  ; --- operators / punctuation ----------------------------------------
  [ "=" ":=" "::=" "?=" "+=" "!=" "@" "-" "+" ] @operator

  [ "(" ")" "{" "}" ] @paren
  [ ":" "&:" "::" "|" ";" "\"" "'" "," ] @paren

  ; Variable expansions: \`$\` and the doubled \`$$\` (literal dollar).
  [ "$" "$$" ] @operator

  ; Automatic variables — \`$@\`, \`$<\`, \`$^\`, \`$?\`, \`$+\`, \`$*\`,
  ; the D/F suffix variants. Face as @constant so they pop the way
  ; canonical names do.
  (automatic_variable
    [ "@" "%" "<" "?" "^" "+" "/" "*" "D" "F" ] @constant)

  ; --- variables -------------------------------------------------------
  (variable_assignment name: (word) @type)
  (variable_reference (word) @type)

  ; --- canonical / built-in target names ------------------------------
  ((targets (word) @constant)
   (#match? @constant "^(all|install|install-html|install-dvi|install-pdf|install-ps|uninstall|install-strip|clean|distclean|mostlyclean|maintainer-clean|TAGS|info|dvi|html|pdf|ps|dist|check|installcheck|installdirs)$"))

  ((targets (word) @constant)
   (#match? @constant "^\\\\.(PHONY|SUFFIXES|DEFAULT|PRECIOUS|INTERMEDIATE|SECONDARY|SECONDEXPANSION|DELETE_ON_ERROR|IGNORE|LOW_RESOLUTION_TIME|SILENT|EXPORT_ALL_VARIABLES|NOTPARALLEL|ONESHELL|POSIX)$"))

  ; Conventional GNU build variables (\`CC\`, \`CFLAGS\`, \`LDFLAGS\`, …)
  ; faced as constants on both sides of an assignment.
  ((variable_assignment name: (word) @constant)
   (#match? @constant "^(AR|AS|CC|CXX|CPP|FC|LEX|YACC|RM|ARFLAGS|ASFLAGS|CFLAGS|CXXFLAGS|CPPFLAGS|FFLAGS|LDFLAGS|LDLIBS|LFLAGS|YFLAGS|PREFIX|DESTDIR|MAKEFILE_LIST|MAKE_RESTARTS|\\\\.DEFAULT_GOAL|\\\\.RECIPEPREFIX|\\\\.EXTRA_PREREQS|VPATH)$"))
  ((variable_reference (word) @constant)
   (#match? @constant "^(AR|AS|CC|CXX|CPP|FC|LEX|YACC|RM|ARFLAGS|ASFLAGS|CFLAGS|CXXFLAGS|CPPFLAGS|FFLAGS|LDFLAGS|LDLIBS|LFLAGS|YFLAGS|PREFIX|DESTDIR|MAKEFILE_LIST|VPATH)$"))
`;

const FOLD_QUERY = `
  (rule) @fold
  (define_directive) @fold
  (conditional) @fold
`;

registerLanguage({
  tag: 'makefile',
  grammar: 'tree-sitter-make.wasm',
  query: QUERY,
  foldQuery: FOLD_QUERY,
  suffixes: ['.mk', 'Makefile', 'makefile', 'GNUmakefile'],
});
