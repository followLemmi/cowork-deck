export interface Rect { left: number; top: number; width: number; height: number; }
export interface FlipTransform { dx: number; dy: number; sx: number; sy: number; }

/** Inverse transform that visually maps `last` back onto `first` (FLIP invert step). */
export function flipTransform(first: Rect, last: Rect): FlipTransform {
  return {
    dx: first.left - last.left,
    dy: first.top - last.top,
    sx: last.width === 0 ? 1 : first.width / last.width,
    sy: last.height === 0 ? 1 : first.height / last.height,
  };
}

export interface ZoomParts { zoomed: string | null; minimized: string[]; }

/**
 * Decide the zoom layout over the visible (non-hidden) tiles.
 * Returns `zoomed: null` (grid mode / no-op) when there is no valid zoom target:
 * zoomedSession is null, not visible, or there are 1 or fewer visible tiles.
 */
export function zoomParticipants(
  tiles: { session: string; hidden: boolean }[],
  zoomedSession: string | null,
): ZoomParts {
  const visible = tiles.filter((t) => !t.hidden).map((t) => t.session);
  if (zoomedSession === null || !visible.includes(zoomedSession) || visible.length <= 1) {
    return { zoomed: null, minimized: [] };
  }
  return { zoomed: zoomedSession, minimized: visible.filter((s) => s !== zoomedSession) };
}
