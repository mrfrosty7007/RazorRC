import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { FailureBreakdown } from '@/domain';
import { FAILURE_REASONS, toneFill } from '@/domain';
import { formatINRCompact } from '@/lib/format';
import { AXIS_TICK, CHART_COLORS, CURSOR_PROPS } from './chartTheme';
import { ChartTooltipCard } from './ChartTooltipCard';

interface FailureReasonChartProps {
  rows: FailureBreakdown[];
  height?: number;
}

/**
 * Horizontal bars: reason labels are words, and words belong on the axis where
 * they can be read left to right without rotation.
 */
export function FailureReasonChart({ rows, height = 260 }: FailureReasonChartProps) {
  const data = rows.map((row) => ({
    reason: row.reason,
    label: FAILURE_REASONS[row.reason].label,
    atRiskPaise: row.atRiskPaise,
  }));

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
          <XAxis
            type="number"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.axis }}
            tickFormatter={(value: number) => formatINRCompact(value)}
          />
          <YAxis
            type="category"
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={132}
          />
          <Tooltip
            cursor={CURSOR_PROPS}
            content={<ChartTooltipCard formatValue={(value) => formatINRCompact(value)} />}
          />
          <Bar dataKey="atRiskPaise" name="At risk" radius={[0, 2, 2, 0]} barSize={13}>
            {data.map((entry) => (
              <Cell key={entry.reason} fill={toneFill(FAILURE_REASONS[entry.reason].tone)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
