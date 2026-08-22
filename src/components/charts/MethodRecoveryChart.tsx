import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { MethodBreakdown } from '@/domain';
import { PAYMENT_METHODS } from '@/domain';
import { formatINRCompact } from '@/lib/format';
import { AXIS_TICK, CHART_COLORS, CURSOR_PROPS, GRID_PROPS } from './chartTheme';
import { ChartTooltipCard } from './ChartTooltipCard';

interface MethodRecoveryChartProps {
  rows: MethodBreakdown[];
  height?: number;
}

/** Recovered against still-at-risk per payment rail, stacked to show the split. */
export function MethodRecoveryChart({ rows, height = 240 }: MethodRecoveryChartProps) {
  const data = rows.map((row) => ({
    label: PAYMENT_METHODS[row.method].label,
    recoveredPaise: row.recoveredPaise,
    atRiskPaise: row.atRiskPaise,
  }));

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid {...GRID_PROPS} />
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: CHART_COLORS.axis }}
          />
          <YAxis
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(value: number) => formatINRCompact(value)}
          />
          <Tooltip
            cursor={CURSOR_PROPS}
            content={<ChartTooltipCard formatValue={(value) => formatINRCompact(value)} />}
          />
          <Bar
            dataKey="recoveredPaise"
            name="Recovered"
            stackId="money"
            fill={CHART_COLORS.recovered}
            barSize={26}
          />
          <Bar
            dataKey="atRiskPaise"
            name="Still at risk"
            stackId="money"
            fill={CHART_COLORS.atRisk}
            barSize={26}
            radius={[2, 2, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
