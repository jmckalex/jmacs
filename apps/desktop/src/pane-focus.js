/**
 * @file Pure helper for the pane focus-border policy. Whether the active
 * pane draws its focus border depends on the `*pane-focus-border*` setting
 * and how many panes are focusable: the 'auto mode hides the border when
 * there's only one focusable pane — a single editing surface (e.g. a
 * project with passive sidebars) has nothing to disambiguate, so the border
 * is just noise. Kept dependency-free for direct unit testing.
 */

/**
 * Whether to draw the active-pane focus border.
 *
 * @param {string} mode - The `*pane-focus-border*` value: 'auto' | 'on' |
 *   'off' (an unknown value is treated as 'auto').
 * @param {number} focusableCount - The number of focusable panes.
 * @returns {boolean}
 */
export function shouldDrawFocusBorder(mode, focusableCount) {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  // 'auto' (and any unknown value): only when there's more than one
  // focusable pane — i.e. there's actually a choice to indicate.
  return focusableCount > 1;
}
