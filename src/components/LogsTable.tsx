import { useState, useEffect, useRef } from 'react'
import { formatCount } from '../lib/formatters'
import type { ActiveFilter, FilterOperator } from '../types'
import { isPositiveOp } from '../types'

export interface Column<T> {
  key: string
  header: string
  className: string
  render: (row: T) => React.ReactNode
}

interface Props<T extends object> {
  endpoint: string
  requestBody: object
  columns: Column<T>[]
  renderDetail: (row: T) => React.ReactNode
  title?: string
}

const PAGE_SIZE = 10

interface DetailFieldProps {
  label: string
  value: React.ReactNode
  /** If provided together with onFilter, include/exclude buttons appear on hover */
  field?: string
  filterValue?: string
  activeFilters?: ActiveFilter[]
  onFilter?: (field: string, fieldLabel: string, value: string, type: FilterOperator) => void
}

function DetailField({ label, value, field, filterValue, activeFilters, onFilter }: DetailFieldProps) {
  const canFilter = !!(field && filterValue && onFilter)
  const filterType = canFilter
    ? (activeFilters?.find(f => f.field === field && f.value === filterValue)?.type ?? null)
    : null
  const isIncluded = filterType !== null && isPositiveOp(filterType)
  const isExcluded = filterType !== null && !isPositiveOp(filterType)

  return (
    <div className="group">
      <div className="text-xs text-gray-400 mb-0.5">{label}</div>
      <div className="flex items-center gap-1.5 min-w-0">
        <div className={`text-sm break-all min-w-0 ${isIncluded ? 'text-blue-700 font-medium' : isExcluded ? 'text-red-400 line-through' : 'text-gray-800'}`}>
          {value ?? '—'}
        </div>
        {canFilter && (
          <div className={`flex items-center gap-0.5 shrink-0 transition-opacity ${filterType ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            <button
              onClick={() => onFilter!(field!, label, filterValue!, 'eq')}
              title={isIncluded ? 'Remove include filter' : `Include: ${filterValue}`}
              className={`h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold transition-colors ${
                isIncluded ? 'bg-blue-200 text-blue-800 hover:bg-blue-300' : 'bg-gray-100 text-gray-500 hover:bg-blue-100 hover:text-blue-700'
              }`}
            >=</button>
            <button
              onClick={() => onFilter!(field!, label, filterValue!, 'neq')}
              title={isExcluded ? 'Remove exclude filter' : `Exclude: ${filterValue}`}
              className={`h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold transition-colors ${
                isExcluded ? 'bg-red-200 text-red-800 hover:bg-red-300' : 'bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-700'
              }`}
            >≠</button>
          </div>
        )}
      </div>
    </div>
  )
}
export { DetailField }
export type { DetailFieldProps }

export default function LogsTable<T extends object>({
  endpoint, requestBody, columns, renderDetail, title = 'Sampled logs',
}: Props<T>) {
  const [page, setPage] = useState(0)
  const [rows, setRows] = useState<T[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null)

  const bodyKey = JSON.stringify(requestBody)
  const prevBodyKey = useRef(bodyKey)
  if (prevBodyKey.current !== bodyKey) {
    prevBodyKey.current = bodyKey
    if (page !== 0) setPage(0)
    setExpandedIdx(null)
  }

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setExpandedIdx(null)

    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...requestBody, page, pageSize: PAGE_SIZE }),
    })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() as Promise<{ rows: T[]; total: number }> })
      .then(data => { if (!cancelled) { setRows(data.rows); setTotal(data.total) } })
      .catch(err => { if (!cancelled) setError(err.message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [endpoint, bodyKey, page])

  const totalPages = Math.ceil(total / PAGE_SIZE)
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1
  const to   = Math.min((page + 1) * PAGE_SIZE, total)

  const toggle = (i: number) => setExpandedIdx(prev => (prev === i ? null : i))

  return (
    <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
      {/* Section header */}
      <div className="px-5 py-4 border-b border-gray-100">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-gray-800">{title}</h3>
            <p className="text-xs text-gray-400 mt-0.5">Sorted by most recent. Click a row to expand details.</p>
          </div>
          <div className="flex items-center gap-3">
            {!loading && total > 0 && (
              <span className="text-xs text-gray-400 tabular-nums">
                {from}–{to} of {formatCount(total)}{total === 10_000 ? '+' : ''}
              </span>
            )}
            {loading && (
              <svg className="animate-spin h-4 w-4 text-gray-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
              </svg>
            )}
            {total > PAGE_SIZE && (
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0 || loading}
                  className="px-2.5 py-1 text-xs border border-gray-200 rounded text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >← Prev</button>
                <span className="text-xs text-gray-400 tabular-nums">{page + 1}/{totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1 || loading}
                  className="px-2.5 py-1 text-xs border border-gray-200 rounded text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >Next →</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Column headers */}
      <div className="flex items-center px-4 py-2 bg-gray-50 border-b border-gray-100">
        <div className="w-7 shrink-0" />
        {columns.map(col => (
          <div key={col.key} className={`text-xs font-semibold text-gray-500 uppercase tracking-wide ${col.className}`}>
            {col.header}
          </div>
        ))}
      </div>

      {/* Rows */}
      {error ? (
        <div className="px-5 py-10 text-center text-sm text-red-500">{error}</div>
      ) : rows.length === 0 && !loading ? (
        <div className="px-5 py-10 text-center text-sm text-gray-400">No matching requests</div>
      ) : (
        <div className={loading ? 'opacity-50 pointer-events-none' : ''}>
          {rows.map((row, i) => {
            const isOpen = expandedIdx === i
            return (
              <div key={i} className="border-b border-gray-100 last:border-b-0">
                {/* Summary row */}
                <div
                  onClick={() => toggle(i)}
                  className={`flex items-center px-4 py-3 cursor-pointer select-none transition-colors ${isOpen ? 'bg-blue-50' : 'hover:bg-gray-50'}`}
                >
                  {/* Expand toggle */}
                  <div className="w-7 shrink-0 text-blue-500">
                    <svg
                      viewBox="0 0 16 16"
                      className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                      fill="currentColor"
                    >
                      <path d="M6 4l4 4-4 4V4z" />
                    </svg>
                  </div>

                  {columns.map(col => (
                    <div key={col.key} className={`text-sm ${col.className}`}>
                      {col.render(row)}
                    </div>
                  ))}
                </div>

                {/* Expanded detail panel */}
                {isOpen && (
                  <div className="border-t border-blue-100 bg-gray-50 px-6 py-5">
                    {renderDetail(row)}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
