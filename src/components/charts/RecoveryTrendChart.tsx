import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { TrendPoint } from '@/domain';
import { formatINRCompact, formatPercent } from '@/lib/format';
import { formatDay } from '@/lib/datetime';
import { AXIS_TICK, CHART_COLORS, GRID_PROPS } from './chartTheme';
import { ChartTooltipCard } from './ChartTooltipCard';

interface RecoveryTrendChartProps {
  points: TrendPoint[];
  height?: number;
}

const SERIES_NAMES: Record<string, string> = {
  atRiskPaise: 'At risk',
  recoveredPaise: 'Recovered',
  recoveryRate: 'Recovery rate',
};

/**
 * Money on the left axis, rate on the right. Recovered volume is drawn over
 * at-risk volume so the gap between the two bands is the money still outstanding
 * on any given day.
 */
export function RecoveryTrendChart({ points, height = 232 }: RecoveryTrendChartProps) {
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="fill-at-risk" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.atRisk} stopOpacity={0.28} />
              <stop offset="100%" stopColor={CHART_COLORS.atRisk} stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="fill-recovered" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={CHART_COLORS.recovered} stopOpacity={0.34} />
              <stop offset="100%" stopColor={CHART_COLORS.recovered} stopOpacity={0.02} />
            </linearGradient>
          </defs>

          <CartesianGrid {...GRID_PROPS} />

          <XAxis
            dataKey="date"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.axis }}
            tickFormatter={(value: string) => formatDay(value)}
            minTickGap={28}
          />
          <YAxis
            yAxisId="money"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(value: number) => formatINRCompact(value)}
          />
          <YAxis
            yAxisId="rate"
            orientation="right"
            domain={[0, 1]}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={40}
            tickFormatter={(value: number) => formatPercent(value, 0)}
          />

          <Tooltip
            content={
              <ChartTooltipCard
                formatLabel={(label) => formatDay(String(label))}
                formatValue={(value, key) =>
                  key === 'recoveryRate' ? formatPercent(value) : formatINRCompact(value)
                }
              />
            }
          />

          <Area
            yAxisId="money"
            type="monotone"
            dataKey="atRiskPaise"
            name={SERIES_NAMES['atRiskPaise']}
            stroke={CHART_COLORS.atRisk}
            strokeWidth={1.5}
            fill="url(#fill-at-risk)"
          />
          <Area
            yAxisId="money"
            type="monotone"
            dataKey="recoveredPaise"
            name={SERIES_NAMES['recoveredPaise']}
            stroke={CHART_COLORS.recovered}
            strokeWidth={1.5}
            fill="url(#fill-recovered)"
          />
          <Line
            yAxisId="rate"
            type="monotone"
            dataKey="recoveryRate"
            name={SERIES_NAMES['recoveryRate']}
            stroke={CHART_COLORS.rate}
            strokeWidth={1.5}
            strokeDasharray="3 3"
            dot={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
