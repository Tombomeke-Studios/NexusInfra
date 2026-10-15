// Whether the top bar folds behind its Menu button (#352).
//
// It used to fold below a fixed 900px (#247). But how much the bar holds depends
// on the edition and the role — a hosted administrator has two more links — so
// any one width is wrong for someone: between 900px and ~1300px the full bar
// overflowed, clipping Sign out and scrolling the page sideways. So the bar folds
// when it does not fit, measured.
//
// Pure, so the rule is tested without a layout engine. The one subtlety is that
// a folded bar cannot be measured for whether the full one would fit — its links
// are hidden — so the width the full bar needed is remembered from the last time
// it was shown, and the bar unfolds only once that much room is back.

export interface NavFitState {
  compact: boolean;
  /** The width the full bar needed when it last overflowed; null until it has. */
  neededWidth: number | null;
}

export interface NavMeasure {
  /** The bar's own width. */
  clientWidth: number;
  /** The width its content wants; only meaningful while the full bar is shown. */
  scrollWidth: number;
}

/** Sub-pixel rounding must not count as overflow, or the bar flickers at the edge. */
const TOLERANCE = 1;

export function nextNavFit(state: NavFitState, measure: NavMeasure): NavFitState {
  if (!state.compact) {
    if (measure.scrollWidth > measure.clientWidth + TOLERANCE) return { compact: true, neededWidth: measure.scrollWidth };
    return state;
  }
  if (state.neededWidth !== null && measure.clientWidth >= state.neededWidth) return { compact: false, neededWidth: state.neededWidth };
  return state;
}
