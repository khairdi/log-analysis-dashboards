import { useState } from 'react'
import type { MetricEntry, ActiveFilter, FilterOperator } from '../types'
import { formatCount } from '../lib/formatters'
import { exportMetricEntriesCsv } from '../lib/csv'
import IpLink from './IpLink'

interface Props {
  title: string
  field: string
  fieldLabel: string
  entries: MetricEntry[]
  activeFilters: ActiveFilter[]
  onFilter: (field: string, fieldLabel: string, value: string, type: FilterOperator) => void
  isIpField?: boolean
}

const PAGE_SIZE = 10

export default function MetricTable({ title, field, fieldLabel, entries, activeFilters, onFilter, isIpField }: Props) {
  const [expanded, setExpanded] = useState(false)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)

  const displayed = expanded ? entries : entries.slice(0, PAGE_SIZE)
  const maxCount = entries[0]?.count ?? 1
  const hasMore = entries.length > PAGE_SIZE

  function filterTypeFor(value: string): FilterOperator | null {
    const f = activeFilters.find(f => f.field === field && f.value === value)
    return f?.type ?? null
  }
  const isPositive = (t: FilterOperator) => t === 'eq' || t === 'contains' || t === 'starts_with' || t === 'ends_with'

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden bg-white">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-2">
        <div>
          <span className="text-sm font-semibold text-gray-700">{title}</span>
          {entries.length > 0 && (
            <span className="ml-2 text-xs text-gray-400">{entries.length} unique</span>
          )}
        </div>
        {entries.length > 0 && (
          <button
            onClick={() => exportMetricEntriesCsv(title, fieldLabel, entries)}
            title={`Export top ${Math.min(entries.length, 500)} rows as CSV`}
            className="shrink-0 inline-flex items-center gap-1 text-xs text-gray-500 hover:text-blue-600 font-medium transition-colors"
          >
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor">
              <path d="M8 1.5a.75.75 0 0 1 .75.75v6.19l1.72-1.72a.75.75 0 1 1 1.06 1.06l-3 3a.75.75 0 0 1-1.06 0l-3-3a.75.75 0 1 1 1.06-1.06l1.72 1.72V2.25A.75.75 0 0 1 8 1.5z"/>
              <path d="M2.5 10.75a.75.75 0 0 1 .75.75v1a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1v-1a.75.75 0 0 1 1.5 0v1a2.5 2.5 0 0 1-2.5 2.5h-7.5a2.5 2.5 0 0 1-2.5-2.5v-1a.75.75 0 0 1 .75-.75z"/>
            </svg>
            CSV
          </button>
        )}
      </div>

      <div>
        {displayed.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-400">No data</div>
        ) : (
          displayed.map((entry) => {
            const filterType = filterTypeFor(entry.value)
            const isIncluded = filterType !== null && isPositive(filterType)
            const isExcluded = filterType !== null && !isPositive(filterType)
            const isHovered = hoveredKey === entry.value
            const barWidth = `${(entry.count / maxCount) * 100}%`

            return (
              <div
                key={entry.value}
                onMouseEnter={() => setHoveredKey(entry.value)}
                onMouseLeave={() => setHoveredKey(null)}
                className={`relative px-3 py-2.5 border-b border-gray-50 last:border-b-0 transition-colors ${
                  isIncluded ? 'bg-blue-50' : isExcluded ? 'bg-red-50' : isHovered ? 'bg-gray-50' : ''
                }`}
              >
                {/* proportional bar */}
                <div
                  className={`absolute left-0 top-0 bottom-0 opacity-30 transition-all ${
                    isIncluded ? 'bg-blue-400' : isExcluded ? 'bg-red-300' : 'bg-blue-100'
                  }`}
                  style={{ width: barWidth }}
                />

                <div className="relative flex items-center gap-2">
                  {/* value label — click to include */}
                  <span
                    onClick={() => onFilter(field, fieldLabel, entry.value, 'eq')}
                    className={`text-sm truncate flex-1 cursor-pointer ${
                      isIncluded ? 'text-blue-800 font-medium' : isExcluded ? 'text-red-400 line-through' : 'text-gray-700 hover:text-gray-900'
                    }`}
                    title={entry.value}
                  >
                    {entry.value}
                  </span>
                  {/* IP lookup icon — outside the truncate span so it never gets clipped */}
                  {isIpField && (
                    <a
                      href={`https://whatismyipaddress.com/ip/${entry.value}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Look up ${entry.value}`}
                      onClick={e => e.stopPropagation()}
                      className="shrink-0 text-gray-300 hover:text-blue-500 transition-colors"
                    >
                      <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor">
                        <path d="M8.5 2.5a.5.5 0 0 1 .5-.5h4a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-1 0V3.707L6.354 9.854a.5.5 0 1 1-.708-.708L11.793 3H9a.5.5 0 0 1-.5-.5z"/>
                        <path d="M14 8.5a.5.5 0 0 1 .5.5v4A1.5 1.5 0 0 1 13 14.5H3A1.5 1.5 0 0 1 1.5 13V3A1.5 1.5 0 0 1 3 1.5h4a.5.5 0 0 1 0 1H3a.5.5 0 0 0-.5.5v10a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5V9a.5.5 0 0 1 .5-.5z"/>
                      </svg>
                    </a>
                  )}

                  {/* percentage + count */}
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-gray-400 tabular-nums">{entry.percentage.toFixed(1)}%</span>
                    <span className={`text-sm font-medium tabular-nums w-12 text-right ${
                      isIncluded ? 'text-blue-800' : isExcluded ? 'text-red-400' : 'text-gray-600'
                    }`}>
                      {formatCount(entry.count)}
                    </span>
                  </div>

                  {/* include / exclude action buttons — visible on hover or when active */}
                  <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ${
                    isHovered || filterType ? 'opacity-100' : 'opacity-0 pointer-events-none'
                  }`}>
                    <button
                      onClick={() => onFilter(field, fieldLabel, entry.value, 'eq')}
                      title={isIncluded ? 'Remove filter' : `Include only: ${entry.value}`}
                      className={`h-5 w-5 rounded flex items-center justify-center text-xs font-bold transition-colors ${
                        isIncluded
                          ? 'bg-blue-200 text-blue-800 hover:bg-blue-300'
                          : 'bg-gray-100 text-gray-500 hover:bg-blue-100 hover:text-blue-700'
                      }`}
                    >
                      =
                    </button>
                    <button
                      onClick={() => onFilter(field, fieldLabel, entry.value, 'neq')}
                      title={isExcluded ? 'Remove filter' : `Exclude: ${entry.value}`}
                      className={`h-5 w-5 rounded flex items-center justify-center text-xs font-bold transition-colors ${
                        isExcluded
                          ? 'bg-red-200 text-red-800 hover:bg-red-300'
                          : 'bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-700'
                      }`}
                    >
                      ≠
                    </button>
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {hasMore && (
        <div className="px-4 py-2 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
          <span className="text-xs text-gray-400">
            {expanded ? `All ${entries.length} items` : `1–${PAGE_SIZE} of ${entries.length}`}
          </span>
          <button
            onClick={() => setExpanded(v => !v)}
            className="text-xs text-blue-600 hover:text-blue-800 font-medium"
          >
            {expanded ? 'Show less' : `Show all ${entries.length}`}
          </button>
        </div>
      )}
    </div>
  )
}
