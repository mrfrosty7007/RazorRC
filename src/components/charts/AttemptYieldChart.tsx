import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AttemptEffectiveness } from '@/domain';
import { formatCount, formatPercent } from '@/lib/format';
import { AXIS_TICK, CHART_COLORS, CURSOR_PROPS, GRID_PROPS } from './chartTheme';
import { ChartTooltipCard } from './ChartTooltipCard';

interface AttemptYieldChartProps {
  rows: AttemptEffectiveness[];
  height?: number;
}

/**
 * Volume against yield per retry number. Where the line crosses below the cost
 * of an attempt is where the retry budget should stop.
 */
export function AttemptYieldChart({ rows, height = 240 }: AttemptYieldChartProps) {
  const data = rows.map((row) => ({
    label: `Attempt ${row.attempt}`,
    attempted: row.attempted,
    recoveryRate: row.recoveryRate,
  }));

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.axis }}
          />
          <YAxis yAxisId="count" tick={AXIS_TICK} tickLine={false} axisLine={false} width={40} />
          <YAxis
            yAxisId="rate"
            orientation="right"
            domain={[0, 'auto']}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(value: number) => formatPercent(value, 0)}
          />
          <Tooltip
            cursor={CURSOR_PROPS}
            content={
              <ChartTooltipCard
                formatValue={(value, key) =>
                  key === 'recoveryRate' ? formatPercent(value) : formatCount(value)
                }
              />
            }
          />
          <Bar
            yAxisId="count"
            dataKey="attempted"
            name="Jobs attempted"
            fill={CHART_COLORS.engine}
            fillOpacity={0.55}
            barSize={30}
            radius={[2, 2, 0, 0]}
          />
          <Line
            yAxisId="rate"
            type="monotone"
            dataKey="recoveryRate"
            name="Yield"
            stroke={CHART_COLORS.recovered}
            strokeWidth={1.75}
            dot={{ r: 2.5, fill: CHART_COLORS.recovered, strokeWidth: 0 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
