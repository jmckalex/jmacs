/**
 * @file Pure find-file path completion — CASE-INSENSITIVE prefix completion of a
 * typed path against a directory listing.
 *
 * The fs read (resolving the typed directory prefix to an absolute path and
 * listing it) is the caller's job, injected as `listDir`, so this stays pure +
 * unit-testable. The server (server.js) wires `listDir` to a real `readdirSync`.
 */

/**
 * Complete a typed path VALUE against its directory.
 *
 * Splits VALUE at its last '/': the part up to and including the slash is the
 * directory prefix (preserved verbatim in the result so the minibuffer keeps
 * showing what the user typed), the rest is the partial file name. Matches the
 * directory's entries whose name CASE-INSENSITIVELY starts with the partial,
 * then completes to the longest common prefix of the matches (a unique match
 * completes fully, with a trailing '/' for a directory so further typing keeps
 * descending). The completed prefix uses the on-disk casing.
 *
 * @param {string} value - The typed path so far (may be '', 'foo', 'src/ba',
 *   '/abs/pa', '~/x').
 * @param {(dirPrefix: string) => ({ name: string, isDir: boolean }[] | null)} listDir
 *   List the directory named by the typed prefix ('' = the working dir); null on
 *   an unreadable directory.
 * @returns {{ value: string, items: string[], directory: string }}
 *   `value` — the completed input; `items` — the matching display names
 *   (directories with a trailing '/'); `directory` — the typed dir prefix.
 */
export function completePath(value, listDir) {
  const input = typeof value === 'string' ? value : '';
  const slash = input.lastIndexOf('/');
  const dirPrefix = slash >= 0 ? input.slice(0, slash + 1) : '';
  const partial = slash >= 0 ? input.slice(slash + 1) : input;

  const entries = (typeof listDir === 'function' ? listDir(dirPrefix) : null) || [];
  const lowerPartial = partial.toLowerCase();
  const matches = entries.filter((e) =>
    typeof e.name === 'string' && e.name.toLowerCase().startsWith(lowerPartial));

  if (matches.length === 0) {
    return { value: input, items: [], directory: dirPrefix };
  }

  const display = (e) => e.name + (e.isDir ? '/' : '');
  const items = matches.map(display);

  // A single match completes fully (with a trailing '/' for a directory).
  if (matches.length === 1) {
    return { value: dirPrefix + display(matches[0]), items, directory: dirPrefix };
  }

  // Otherwise complete to the longest common prefix of the matched names
  // (case-insensitive comparison). Keep the user's typed partial verbatim (don't
  // re-case what they typed) and only EXTEND it by the common run beyond it,
  // taking that run's casing from the first match.
  const ref = matches[0].name;
  let commonLen = ref.length;
  for (const e of matches.slice(1)) {
    let i = 0;
    while (i < commonLen && i < e.name.length
      && ref[i].toLowerCase() === e.name[i].toLowerCase()) {
      i += 1;
    }
    commonLen = i;
  }
  const completed = partial + ref.slice(partial.length, commonLen);
  return { value: dirPrefix + completed, items, directory: dirPrefix };
}
