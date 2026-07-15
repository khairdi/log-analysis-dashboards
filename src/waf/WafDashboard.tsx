import { useState, useEffect, useRef } from 'react'
import type { ActiveFilter, WafMetrics, WafSessionData, WafQueryResult, WafLogRow, FilterOperator } from './types'
import { formatCount, formatDate } from '../lib/formatters'
import { OPERATOR_SYMBOL, isPositiveOp } from '../types'
import RequestsChart from '../components/RequestsChart'
import MetricTable from '../components/MetricTable'
import IpLink from '../components/IpLink'
import LogsTable, { DetailField } from '../components/LogsTable'
import type { Column } from '../components/LogsTable'
import AddFilterPanel from '../components/AddFilterPanel'
import DateRangePicker from '../components/DateRangePicker'
import type { DateRange } from '../components/DateRangePicker'

interface Props {
  session: WafSessionData
  onReset: () => void
}

const WAF_DIMENSIONS = [
  { id: 'all',             label: 'All' },
  { id: 'action',          label: 'Action' },
  { id: 'country',         label: 'Country' },
  { id: 'method',          label: 'Method' },
  { id: 'terminatingRule', label: 'Rule' },
]

const WAF_FILTER_FIELDS = [
  { field: 'action',              label: 'Action' },
  { field: 'country',             label: 'Country' },
  { field: 'terminatingRule',     label: 'Terminating rule' },
  { field: 'terminatingRuleType', label: 'Rule type' },
  { field: 'uri',                 label: 'URI / Path' },
  { field: 'host',                label: 'Host' },
  { field: 'method',              label: 'Method' },
  { field: 'httpVersion',         label: 'HTTP version' },
  { field: 'label',               label: 'WAF label' },
  { field: 'ruleGroup',           label: 'Rule group' },
  { field: 'clientIp',            label: 'Client IP' },
  { field: 'ja3',                 label: 'JA3' },
  { field: 'ja4',                 label: 'JA4' },
  { field: 'userAgent',           label: 'User agent' },
]

const ACTION_COLORS: Record<string, string> = {
  ALLOW:     'text-green-700 bg-green-50 border-green-200',
  BLOCK:     'text-red-700 bg-red-50 border-red-200',
  COUNT:     'text-blue-700 bg-blue-50 border-blue-200',
  CAPTCHA:   'text-yellow-700 bg-yellow-50 border-yellow-200',
  CHALLENGE: 'text-purple-700 bg-purple-50 border-purple-200',
}

export default function WafDashboard({ session, onReset }: Props) {
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([])
  const [dimension, setDimension] = useState('action')
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [showAddFilter, setShowAddFilter] = useState(false)

  const [tableMetrics, setTableMetrics] = useState<WafMetrics>(session.tableMetrics)
  const [filteredMetrics, setFilteredMetrics] = useState<WafMetrics>(session.filteredMetrics)
  const [points, setPoints] = useState(session.points)
  const [keys, setKeys] = useState(session.keys)
  const [querying, setQuerying] = useState(false)
  const [sessionError, setSessionError] = useState('')

  const isFirstRender = useRef(true)

  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }

    let cancelled = false
    setQuerying(true)
    fetch(`/api/waf-sessions/${session.sessionId}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dateRangeStart: dateRange?.start.toISOString(),
        dateRangeEnd: dateRange?.end.toISOString(),
        filters: activeFilters,
        dimension,
      }),
    })
      .then(r => {
        if (r.status === 404) throw new Error('expired')
        return r.json() as Promise<WafQueryResult>
      })
      .then(data => {
        if (cancelled) return
        setTableMetrics(data.tableMetrics)
        setFilteredMetrics(data.filteredMetrics)
        setPoints(data.points)
        setKeys(data.keys)
      })
      .catch(err => {
        if (cancelled) return
        if (err.message === 'expired') setSessionError('Session expired — please reload your files.')
      })
      .finally(() => { if (!cancelled) setQuerying(false) })

    return () => { cancelled = true }
  }, [session.sessionId, activeFilters, dimension, dateRange])

  const handleFilter = (field: string, fieldLabel: string, value: string, type: FilterOperator) => {
    setActiveFilters(prev => {
      const exists = prev.find(f => f.field === field && f.value === value && f.type === type)
      if (exists) return prev.filter(f => !(f.field === field && f.value === value && f.type === type))
      if (type === 'eq') {
        return [...prev.filter(f => !(f.field === field && f.type === 'eq')), { field, fieldLabel, value, type }]
      }
      return [...prev, { field, fieldLabel, value, type }]
    })
  }

  const removeFilter = (f: ActiveFilter) => {
    setActiveFilters(prev => prev.filter(p => !(p.field === f.field && p.value === f.value && p.type === f.type)))
  }

  const dataMin = session.dataMin ? new Date(session.dataMin) : null
  const dataMax = session.dataMax ? new Date(session.dataMax) : null

  const WAF_ACTION_COLORS: Record<string, string> = {
    ALLOW:     'bg-green-100 text-green-800',
    BLOCK:     'bg-red-100 text-red-800',
    COUNT:     'bg-blue-100 text-blue-800',
    CAPTCHA:   'bg-yellow-100 text-yellow-800',
    CHALLENGE: 'bg-purple-100 text-purple-800',
  }
  const actionBadge = (a: string) => (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${WAF_ACTION_COLORS[a] ?? 'bg-gray-100 text-gray-700'}`}>{a}</span>
  )

  const WAF_COLUMNS: Column<WafLogRow>[] = [
    { key: 'timestamp', header: 'Time (UTC)', className: 'w-44 shrink-0 pr-4', render: r => <span className="font-mono text-gray-700 text-xs">{r.timestamp}</span> },
    { key: 'action',    header: 'Action',     className: 'w-24 shrink-0 pr-4', render: r => actionBadge(r.action) },
    { key: 'clientIp',  header: 'Source IP',  className: 'w-36 shrink-0 pr-4', render: r => <IpLink ip={r.clientIp} className="text-xs" /> },
    { key: 'host',      header: 'Host',       className: 'w-52 shrink-0 pr-4', render: r => <span className="text-gray-800 text-xs truncate block">{r.host}</span> },
    { key: 'uri',       header: 'URI / Path', className: 'flex-1 min-w-0 pr-4', render: r => <span className="font-mono text-gray-600 text-xs truncate block" title={r.uri}>{r.uri}</span> },
    { key: 'rule',      header: 'Rule',       className: 'w-48 shrink-0', render: r => <span className="text-gray-500 text-xs truncate block" title={r.terminatingRule}>{r.terminatingRule}</span> },
  ]

  const wafRenderDetail = (r: WafLogRow) => {
    const fp = { activeFilters, onFilter: handleFilter }
    return (
      <div className="space-y-5">
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 pb-1.5 border-b border-gray-200">WAF decision</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
            <DetailField label="Action"           value={actionBadge(r.action)}  field="action"              filterValue={r.action}              {...fp} />
            <DetailField label="Terminating rule" value={r.terminatingRule}      field="terminatingRule"     filterValue={r.terminatingRule}     {...fp} />
            <DetailField label="Rule type"        value={r.terminatingRuleType}  field="terminatingRuleType" filterValue={r.terminatingRuleType} {...fp} />
            <DetailField label="HTTP version"     value={r.httpVersion}          field="httpVersion"         filterValue={r.httpVersion}         {...fp} />
          </div>
        </div>

        {r.labels.length > 0 && (
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 pb-1.5 border-b border-gray-200">WAF labels</div>
            <div className="flex flex-wrap gap-1.5">
              {r.labels.map(l => {
                const lblFilter = activeFilters.find(f => f.field === 'label' && f.value === l)
                const isLblIncluded = lblFilter ? isPositiveOp(lblFilter.type) : false
                const isLblExcluded = lblFilter ? !isPositiveOp(lblFilter.type) : false
                return (
                  <span key={l} className="group/lbl inline-flex items-center gap-0.5">
                    <span className={`rounded px-2 py-0.5 text-xs font-mono ${isLblIncluded ? 'bg-blue-100 text-blue-800' : isLblExcluded ? 'bg-red-50 text-red-400 line-through' : 'bg-gray-100 text-gray-700'}`}>{l}</span>
                    <span className={`inline-flex gap-0.5 transition-opacity ${isLblIncluded || isLblExcluded ? 'opacity-100' : 'opacity-0 group-hover/lbl:opacity-100'}`}>
                      <button onClick={() => handleFilter('label', 'Label', l, 'eq')} className={`h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold ${isLblIncluded ? 'bg-blue-200 text-blue-800' : 'bg-gray-100 text-gray-500 hover:bg-blue-100 hover:text-blue-700'}`}>=</button>
                      <button onClick={() => handleFilter('label', 'Label', l, 'neq')} className={`h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold ${isLblExcluded ? 'bg-red-200 text-red-800' : 'bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-700'}`}>≠</button>
                    </span>
                  </span>
                )
              })}
            </div>
          </div>
        )}

        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 pb-1.5 border-b border-gray-200">Request details</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
            <DetailField label="Client IP" value={<IpLink ip={r.clientIp} className="text-xs" />}          field="clientIp" filterValue={r.clientIp} {...fp} />
            <DetailField label="Country"   value={r.country}                                                field="country"  filterValue={r.country}  {...fp} />
            <DetailField label="Method"    value={<span className="font-semibold">{r.method}</span>}        field="method"   filterValue={r.method}   {...fp} />
            <DetailField label="Host"      value={r.host}                                                   field="host"     filterValue={r.host}     {...fp} />
          </div>
        </div>

        {(r.ja3 !== '-' || r.ja4 !== '-') && (
          <div>
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 pb-1.5 border-b border-gray-200">Fingerprints</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              {r.ja3 !== '-' && <DetailField label="JA3" value={<span className="font-mono text-xs break-all">{r.ja3}</span>} field="ja3" filterValue={r.ja3} {...fp} />}
              {r.ja4 !== '-' && <DetailField label="JA4" value={<span className="font-mono text-xs break-all">{r.ja4}</span>} field="ja4" filterValue={r.ja4} {...fp} />}
            </div>
          </div>
        )}

        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 pb-1.5 border-b border-gray-200">Full URI</div>
          <div className="flex items-start gap-1.5 group">
            <span className="font-mono text-xs text-gray-700 break-all">{r.uri}</span>
            <div className={`flex items-center gap-0.5 shrink-0 mt-0.5 transition-opacity ${activeFilters.find(f => f.field === 'uri' && f.value === r.uri) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
              <button onClick={() => handleFilter('uri', 'URI', r.uri, 'eq')} className="h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold bg-gray-100 text-gray-500 hover:bg-blue-100 hover:text-blue-700">=</button>
              <button onClick={() => handleFilter('uri', 'URI', r.uri, 'neq')} className="h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-700">≠</button>
            </div>
          </div>
        </div>

        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 pb-1.5 border-b border-gray-200">User agent</div>
          <div className="flex items-start gap-1.5 group">
            <span className="text-xs text-gray-700 break-all">{r.userAgent}</span>
            <div className={`flex items-center gap-0.5 shrink-0 mt-0.5 transition-opacity ${activeFilters.find(f => f.field === 'userAgent' && f.value === r.userAgent) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
              <button onClick={() => handleFilter('userAgent', 'User agent', r.userAgent, 'eq')} className="h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold bg-gray-100 text-gray-500 hover:bg-blue-100 hover:text-blue-700">=</button>
              <button onClick={() => handleFilter('userAgent', 'User agent', r.userAgent, 'neq')} className="h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-700">≠</button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  const wafLogsBody = {
    filters: activeFilters,
    dateRangeStart: dateRange?.start.toISOString(),
    dateRangeEnd: dateRange?.end.toISOString(),
  }

  const dateHeader = filteredMetrics.dateRange
    ? `${formatDate(filteredMetrics.dateRange.start.split(' ')[0], filteredMetrics.dateRange.start.split(' ')[1])} → ${formatDate(filteredMetrics.dateRange.end.split(' ')[0], filteredMetrics.dateRange.end.split(' ')[1])}`
    : ''

  if (sessionError) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600 mb-4">{sessionError}</p>
          <button onClick={onReset} className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700">
            Load files again
          </button>
        </div>
      </div>
    )
  }

  const METRIC_CARDS = [
    { label: 'Total requests',  value: filteredMetrics.total,      color: 'text-gray-900', bg: '' },
    { label: 'Allowed',         value: filteredMetrics.allowed,    color: 'text-green-700', bg: 'bg-green-50' },
    { label: 'Blocked',         value: filteredMetrics.blocked,    color: 'text-red-700',   bg: 'bg-red-50' },
    { label: 'Challenged',      value: filteredMetrics.challenged, color: 'text-yellow-700',bg: 'bg-yellow-50' },
  ]

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-full bg-red-600 flex items-center justify-center text-white font-bold text-xs">WAF</div>
          <div>
            <div className="text-base font-semibold text-gray-900 leading-tight flex items-center gap-2">
              WAF Security — {session.fileName}
              {querying && (
                <svg className="animate-spin h-3.5 w-3.5 text-red-400 shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
              )}
            </div>
            <div className="text-xs text-gray-400">{dateHeader}</div>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <DateRangePicker value={dateRange} dataMin={dataMin} dataMax={dataMax} onChange={setDateRange} />
          <button onClick={onReset} className="text-sm text-red-600 hover:text-red-800 font-medium">
            Load another file
          </button>
        </div>
      </div>

      <div className="px-6 py-5 w-full">

        {/* Active filter chips + Add filter */}
        <div className="mb-4">
          {(activeFilters.length > 0 || showAddFilter) && (
            <div className="flex flex-wrap items-center gap-2 mb-2">
              {activeFilters.length > 0 && (
                <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">Filters</span>
              )}
              {activeFilters.map(f => (
                <span
                  key={`${f.field}-${f.value}-${f.type}`}
                  className={`inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full border ${
                    isPositiveOp(f.type) ? 'bg-blue-50 border-blue-200 text-blue-800' : 'bg-red-50 border-red-200 text-red-800'
                  }`}
                >
                  <span className={`font-bold ${isPositiveOp(f.type) ? 'text-blue-500' : 'text-red-400'}`}>
                    {OPERATOR_SYMBOL[f.type]}
                  </span>
                  <span className="font-medium">{f.fieldLabel}:</span>
                  <span className="max-w-[14rem] truncate">{f.value}</span>
                  <button
                    onClick={() => removeFilter(f)}
                    className={`ml-0.5 font-bold leading-none ${isPositiveOp(f.type) ? 'text-blue-400 hover:text-blue-800' : 'text-red-400 hover:text-red-800'}`}
                  >×</button>
                </span>
              ))}
              {activeFilters.length > 0 && (
                <button onClick={() => setActiveFilters([])} className="text-xs text-gray-400 hover:text-gray-700 underline">
                  Clear all
                </button>
              )}
            </div>
          )}
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowAddFilter(v => !v)}
              className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-dashed border-gray-300 text-gray-500 hover:border-red-400 hover:text-red-600 transition-colors"
            >
              <svg viewBox="0 0 16 16" className="w-3 h-3" fill="currentColor"><path d="M8 3a.5.5 0 0 1 .5.5v4h4a.5.5 0 0 1 0 1h-4v4a.5.5 0 0 1-1 0v-4h-4a.5.5 0 0 1 0-1h4v-4A.5.5 0 0 1 8 3z"/></svg>
              Add filter
            </button>
          </div>
          {showAddFilter && (
            <div className="mt-2">
              <AddFilterPanel
                fields={WAF_FILTER_FIELDS}
                onApply={(field, fieldLabel, value, type) => { handleFilter(field, fieldLabel, value, type); setShowAddFilter(false) }}
                onClose={() => setShowAddFilter(false)}
              />
            </div>
          )}
        </div>

        {/* Metric cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
          {METRIC_CARDS.map(card => (
            <div key={card.label} className={`rounded-lg border border-gray-200 p-4 ${card.bg || 'bg-white'}`}>
              <div className="text-xs text-gray-500 font-medium mb-1">{card.label}</div>
              <div className={`text-2xl font-bold tabular-nums leading-none ${card.color}`}>
                {formatCount(card.value)}
              </div>
              {card.value > 0 && filteredMetrics.total > 0 && card.label !== 'Total requests' && (
                <div className="text-xs text-gray-400 mt-1">
                  {((card.value / filteredMetrics.total) * 100).toFixed(1)}% of total
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Requests over time */}
        <div className="bg-white border border-gray-200 rounded-lg p-5 mb-5">
          <div className="flex items-start justify-between mb-1">
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-3">Requests over time</div>
              <div className="flex flex-wrap gap-0 border-b border-gray-200 -mb-px">
                {WAF_DIMENSIONS.map(d => (
                  <button
                    key={d.id}
                    onClick={() => setDimension(d.id)}
                    className={`px-3 py-1.5 text-xs font-medium -mb-px transition-colors border-b-2 ${
                      dimension === d.id ? 'text-red-600 border-red-600' : 'text-gray-500 border-transparent hover:text-gray-800'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-right ml-6 shrink-0">
              <div className="text-xs text-gray-400 mb-0.5">Total requests</div>
              <div className="text-3xl font-bold text-gray-900 tabular-nums leading-none">
                {formatCount(filteredMetrics.total)}
              </div>
              {filteredMetrics.counted > 0 && (
                <div className="text-xs text-gray-400 mt-1">{formatCount(filteredMetrics.counted)} counted</div>
              )}
            </div>
          </div>
          <div className="mt-5">
            <RequestsChart
              points={points}
              keys={keys}
              dimension={dimension}
              dimensionLabel={WAF_DIMENSIONS.find(d => d.id === dimension)?.label}
              activeFilters={activeFilters}
              onFilter={handleFilter}
            />
          </div>
        </div>

        {/* Action breakdown badges */}
        {filteredMetrics.byAction.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-2">
            {filteredMetrics.byAction.map(entry => {
              const colorClass = ACTION_COLORS[entry.value] ?? 'text-gray-700 bg-gray-50 border-gray-200'
              const isActive = activeFilters.find(f => f.field === 'action' && f.value === entry.value && isPositiveOp(f.type))
              return (
                <button
                  key={entry.value}
                  onClick={() => handleFilter('action', 'Action', entry.value, 'eq')}
                  className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium transition-colors ${
                    isActive ? 'ring-2 ring-offset-1 ring-blue-400 ' : ''
                  }${colorClass}`}
                >
                  <span className="font-semibold">{entry.value}</span>
                  <span className="tabular-nums">{formatCount(entry.count)}</span>
                  <span className="text-[10px] opacity-70">{entry.percentage.toFixed(1)}%</span>
                </button>
              )
            })}
          </div>
        )}

        {/* Metric tables */}
        <div className="mb-3">
          <div className="text-sm font-semibold text-gray-700 mb-1">Requests by dimension</div>
          <p className="text-xs text-gray-400">
            Hover any row and click <span className="font-bold">=</span> to include or <span className="font-bold">≠</span> to exclude that value.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {[
            { title: 'Actions',              field: 'action',              fieldLabel: 'Action',        entries: filteredMetrics.byAction },
            { title: 'Countries',            field: 'country',             fieldLabel: 'Country',       entries: filteredMetrics.byCountry },
            { title: 'Terminating rules',    field: 'terminatingRule',     fieldLabel: 'Rule',          entries: filteredMetrics.byTerminatingRule },
            { title: 'Rule types',           field: 'terminatingRuleType', fieldLabel: 'Rule type',     entries: filteredMetrics.byTerminatingRuleType },
            { title: 'URIs / Paths',         field: 'uri',                 fieldLabel: 'URI',           entries: filteredMetrics.byUri },
            { title: 'Hosts',                field: 'host',                fieldLabel: 'Host',          entries: filteredMetrics.byHost },
            { title: 'HTTP methods',         field: 'method',              fieldLabel: 'Method',        entries: filteredMetrics.byMethod },
            { title: 'HTTP versions',        field: 'httpVersion',         fieldLabel: 'HTTP version',  entries: filteredMetrics.byHttpVersion },
            { title: 'WAF labels',           field: 'label',               fieldLabel: 'Label',         entries: filteredMetrics.byLabel },
            { title: 'Matched rule groups',  field: 'ruleGroup',           fieldLabel: 'Rule group',    entries: filteredMetrics.byRuleGroup },
            { title: 'Client IPs',           field: 'clientIp',            fieldLabel: 'Client IP',     entries: filteredMetrics.byClientIp,   isIpField: true },
            { title: 'JA3 fingerprints',     field: 'ja3',                 fieldLabel: 'JA3',           entries: filteredMetrics.byJa3 },
            { title: 'JA4 fingerprints',     field: 'ja4',                 fieldLabel: 'JA4',           entries: filteredMetrics.byJa4 },
            { title: 'User agents',          field: 'userAgent',           fieldLabel: 'User agent',    entries: filteredMetrics.byUserAgent },
          ].map(t => (
            <MetricTable
              key={t.field}
              title={t.title}
              field={t.field}
              fieldLabel={t.fieldLabel}
              entries={t.entries}
              activeFilters={activeFilters}
              onFilter={handleFilter}
              isIpField={'isIpField' in t && t.isIpField === true}
            />
          ))}
        </div>

        {/* Request logs */}
        <div className="mt-5">
          <LogsTable<WafLogRow>
            title="Sampled logs"
            endpoint={`/api/waf-sessions/${session.sessionId}/rows`}
            requestBody={wafLogsBody}
            columns={WAF_COLUMNS}
            renderDetail={wafRenderDetail}
          />
        </div>
      </div>
    </div>
  )
}
