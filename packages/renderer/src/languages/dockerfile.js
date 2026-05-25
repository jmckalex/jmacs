/**
 * @file Dockerfile — tree-sitter language registration. See
 * `./javascript.js` for the template and `./README.md` for "how to add
 * a language".
 *
 * Sublime-Text-style coverage: instruction names (`FROM`, `RUN`,
 * `COPY` etc.) as keywords, strings (single + double + JSON form
 * + heredoc bodies), comments, operators (`:` and `@` for image
 * tags / digests), and `$VAR` / `${VAR}` expansions as variables.
 */

import { registerLanguage } from '../language-registry.js';

const QUERY = `
  ; --- comments / strings ----------------------------------------------
  (comment) @comment
  (double_quoted_string) @string
  (single_quoted_string) @string
  (json_string) @string
  (heredoc_line) @string

  ; --- keywords --------------------------------------------------------
  [
    "FROM" "AS" "RUN" "CMD" "LABEL" "EXPOSE" "ENV" "ADD" "COPY"
    "ENTRYPOINT" "VOLUME" "USER" "WORKDIR" "ARG" "ONBUILD"
    "STOPSIGNAL" "HEALTHCHECK" "SHELL" "MAINTAINER" "CROSS_BUILD"
  ] @keyword
  (heredoc_marker) @keyword
  (heredoc_end) @keyword

  ; --- operators / punctuation ---------------------------------------
  [ ":" "@" ] @operator
  [ "$" "{" "}" ] @paren

  ; --- variables / constants ------------------------------------------
  ((variable) @constant
   (#match? @constant "^[A-Z][A-Z_0-9]*$"))
  (variable) @type
`;

registerLanguage({
  tag: 'dockerfile',
  grammar: 'tree-sitter-dockerfile.wasm',
  query: QUERY,
  suffixes: ['Dockerfile', '.dockerfile', '.Dockerfile'],
  aliases: ['docker'],
});
