/**
 * Shared Recharts styling. Charts are instruments, not illustrations: hairline
 * horizontal rules only, monospaced ticks so values line up with the tables
 * beside them, and no drop shadows or 3D effects anywhere.
 */
export const CHART_COLORS = {
  atRisk: '#FF5C72',
  recovered: '#17C79A',
  rate: '#3D7DFF',
  engine: '#8B7BFF',
  grid: '#1E2A3D',
  axis: '#2A3950',
  tick: '#5F6E8A',
} as const;

export const AXIS_TICK = {
  fill: CHART_COLORS.tick,
  fontSize: 11,
  fontFamily: '"IBM Plex Mono", ui-monospace, monospace',
} as const;

export const GRID_PROPS = {
  stroke: CHART_COLORS.grid,
  strokeDasharray: '0',
  vertical: false,
} as const;

/** Highlight bar behind the hovered category. */
export const CURSOR_PROPS = { fill: '#FFFFFF', fillOpacity: 0.04 } as const;
