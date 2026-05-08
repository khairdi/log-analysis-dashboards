import { useState } from 'react'
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { TimeSeriesPoint, ActiveFilter, FilterOperator } from '../types'
import { formatCount } from '../lib/formatters'

interface Props {
  points: TimeSeriesPoint[]
  keys: string[]
  dimension?: string
  dimensionLabel?: string
  activeFilters?: ActiveFilter[]
  onFilter?: (field: string, fieldLabel: string, value: string, type: FilterOperator) => void
}

export const LINE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6']

export default function RequestsChart({ points, keys, dimension, dimensionLabel, activeFilters = [], onFilter }: Props) {
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)

  if (points.length === 0) {
    return (
      <div className="h-56 flex items-center justify-center text-sm text-gray-400">
        No data to display
      </div>
    )
  }

  const showDimSummary = keys.length > 1 || (keys.length === 1 && keys[0] !== 'requests')
  const canFilter = !!onFilter && !!dimension && dimension !== 'all'

  const keyTotals = keys.map((key, i) => {
    const filterType = canFilter
      ? (activeFilters.find(f => f.field === dimension && f.value === key)?.type ?? null)
      : null
    return {
      key,
      color: LINE_COLORS[i % LINE_COLORS.length],
      total: points.reduce((s, p) => s + ((p[key] as number) || 0), 0),
      filterType,
    }
  })

  return (
    <div>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickLine={false}
              axisLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              tick={{ fontSize: 11, fill: '#9ca3af' }}
              tickLine={false}
              axisLine={false}
              tickFormatter={formatCount}
              width={44}
            />
            <Tooltip
              contentStyle={{
                border: '1px solid #e5e7eb',
                borderRadius: 6,
                boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.08)',
                fontSize: 12,
                padding: '8px 12px',
              }}
              formatter={(value: number, name: string) => [
                formatCount(value),
                name === 'requests' ? 'Requests' : name,
              ]}
              labelStyle={{ color: '#374151', marginBottom: 4, fontWeight: 500 }}
            />
            {keyTotals.map(({ key, color, filterType }) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                stroke={filterType === 'neq' || filterType === 'not_contains' ? '#d1d5db' : color}
                strokeWidth={filterType === 'eq' || filterType === 'contains' || filterType === 'starts_with' || filterType === 'ends_with' ? 3 : 2}
                strokeDasharray={filterType === 'neq' || filterType === 'not_contains' ? '4 3' : undefined}
                dot={false}
                activeDot={{ r: 4, strokeWidth: 0 }}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Per-dimension totals with filter actions */}
      {showDimSummary && (
        <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-gray-100">
          {keyTotals.map(({ key, color, total, filterType }) => {
            const isHovered = hoveredKey === key
            const isIncluded = filterType === 'eq' || filterType === 'contains' || filterType === 'starts_with' || filterType === 'ends_with'
            const isExcluded = filterType === 'neq' || filterType === 'not_contains'

            return (
              <div
                key={key}
                onMouseEnter={() => setHoveredKey(key)}
                onMouseLeave={() => setHoveredKey(null)}
                className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full border text-xs transition-colors ${
                  isIncluded
                    ? 'bg-blue-50 border-blue-200'
                    : isExcluded
                    ? 'bg-red-50 border-red-200'
                    : isHovered
                    ? 'bg-gray-50 border-gray-200'
                    : 'bg-white border-transparent'
                }`}
              >
                {/* colour dot */}
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: isExcluded ? '#d1d5db' : color }}
                />

                {/* label */}
                <span
                  className={`truncate max-w-[12rem] ${
                    isIncluded ? 'text-blue-800 font-medium' : isExcluded ? 'text-red-400 line-through' : 'text-gray-700'
                  }`}
                  title={key}
                >
                  {key}
                </span>

                {/* total */}
                <span className={`font-semibold tabular-nums ${
                  isIncluded ? 'text-blue-800' : isExcluded ? 'text-red-400' : 'text-gray-800'
                }`}>
                  {formatCount(total)}
                </span>

                {/* action buttons — appear on hover or when active */}
                {canFilter && (isHovered || filterType) && (
                  <span className="flex items-center gap-0.5 ml-0.5">
                    <button
                      onClick={() => onFilter!(dimension!, dimensionLabel ?? dimension!, key, 'eq')}
                      title={isIncluded ? 'Remove include filter' : `Include only: ${key}`}
                      className={`h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold transition-colors ${
                        isIncluded
                          ? 'bg-blue-200 text-blue-800 hover:bg-blue-300'
                          : 'bg-gray-100 text-gray-500 hover:bg-blue-100 hover:text-blue-700'
                      }`}
                    >
                      =
                    </button>
                    <button
                      onClick={() => onFilter!(dimension!, dimensionLabel ?? dimension!, key, 'neq')}
                      title={isExcluded ? 'Remove exclude filter' : `Exclude: ${key}`}
                      className={`h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold transition-colors ${
                        isExcluded
                          ? 'bg-red-200 text-red-800 hover:bg-red-300'
                          : 'bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-700'
                      }`}
                    >
                      ≠
                    </button>
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
