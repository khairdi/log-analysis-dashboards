import { useState, useEffect, useRef } from 'react'
import type { ActiveFilter, Metrics, TimeSeriesPoint, SessionData, QueryResult, CfLogRow, FilterOperator } from '../types'
import { OPERATOR_SYMBOL, isPositiveOp } from '../types'
import { formatCount, formatBytes, formatDate } from '../lib/formatters'
import { exportMetricEntriesCsv } from '../lib/csv'
import RequestsChart from './RequestsChart'
import MetricTable from './MetricTable'
import IpLink from './IpLink'
import LogsTable, { DetailField } from './LogsTable'
import type { Column } from './LogsTable'
import AddFilterPanel from './AddFilterPanel'
import DateRangePicker from './DateRangePicker'
import type { DateRange } from './DateRangePicker'

interface Props {
  session: SessionData
  onReset: () => void
}

const DIMENSIONS = [
  { id: 'all', label: 'All' },
  { id: 'referer-host', label: 'Referer host' },
  { id: 'cs(Host)', label: 'Host' },
  { id: 'c-country', label: 'Country' },
  { id: 'cs-uri-stem', label: 'Path' },
  { id: 'sc-status', label: 'Status code' },
  { id: 'x-edge-result-type', label: 'Cache status' },
]

export default function Dashboard({ session, onReset }: Props) {
  const [activeFilters, setActiveFilters] = useState<ActiveFilter[]>([])
  const [dimension, setDimension] = useState('all')
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [showAddFilter, setShowAddFilter] = useState(false)

  // Server-computed results — initialised from the session response
  const [tableMetrics, setTableMetrics] = useState<Metrics>(session.tableMetrics)
  const [filteredMetrics, setFilteredMetrics] = useState<Metrics>(session.filteredMetrics)
  const [points, setPoints] = useState<TimeSeriesPoint[]>(session.points)
  const [keys, setKeys] = useState<string[]>(session.keys)
  const [querying, setQuerying] = useState(false)
  const [sessionError, setSessionError] = useState('')

  // Skip the effect on the very first render (initial data comes from session props)
  const isFirstRender = useRef(true)

  useEffect(() => {
    if (isFirstRender.current) { isFirstRender.current = false; return }

    let cancelled = false
    setQuerying(true)
    fetch(`/api/sessions/${session.sessionId}/query`, {
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
        return r.json() as Promise<QueryResult>
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
      // eq replaces any other eq on the same field; all other operators are additive
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

  const dateHeader = filteredMetrics.dateRange
    ? `${formatDate(filteredMetrics.dateRange.start.split(' ')[0], filteredMetrics.dateRange.start.split(' ')[1])} → ${formatDate(filteredMetrics.dateRange.end.split(' ')[0], filteredMetrics.dateRange.end.split(' ')[1])}`
    : ''

  function countryFilterType(value: string): FilterOperator | null {
    return activeFilters.find(f => f.field === 'c-country' && f.value === value)?.type ?? null
  }

  const CF_FILTER_FIELDS = [
    { field: 'c-country',           label: 'Country' },
    { field: 'cs(Host)',             label: 'Host' },
    { field: 'cs-uri-stem',          label: 'Path' },
    { field: 'full-path',            label: 'Full path (path + query)' },
    { field: 'cs-uri-query',         label: 'Query params' },
    { field: 'sc-status',            label: 'Status code' },
    { field: 'referer-host',         label: 'Referer host' },
    { field: 'x-edge-result-type',   label: 'Cache status' },
    { field: 'cs-protocol-version',  label: 'Protocol' },
    { field: 'x-edge-location',      label: 'Data center' },
    { field: 'asn',                  label: 'ASN' },
    { field: 'browser',              label: 'Browser' },
    { field: 'os',                   label: 'OS' },
    { field: 'device',               label: 'Device type' },
    { field: 'ssl-protocol',         label: 'SSL protocol' },
    { field: 'c-ip',                 label: 'IP address' },
    { field: 'cs-method',            label: 'Method' },
    { field: 'userAgent',            label: 'User agent' },
  ]

  const STATUS_COLORS: Record<string, string> = {
    '2': 'bg-green-100 text-green-800',
    '3': 'bg-blue-100 text-blue-800',
    '4': 'bg-yellow-100 text-yellow-800',
    '5': 'bg-red-100 text-red-800',
  }
  const statusBadge = (s: string) => (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${STATUS_COLORS[s[0]] ?? 'bg-gray-100 text-gray-700'}`}>{s}</span>
  )

  const CF_COLUMNS: Column<CfLogRow>[] = [
    { key: 'timestamp', header: 'Time (UTC)',  className: 'w-44 shrink-0 pr-4', render: r => <span className="font-mono text-gray-700 text-xs">{r.timestamp}</span> },
    { key: 'ip',        header: 'Source IP',   className: 'w-36 shrink-0 pr-4', render: r => <IpLink ip={r.ip} className="text-xs" /> },
    { key: 'host',      header: 'Host',        className: 'w-48 shrink-0 pr-4', render: r => <span className="text-gray-800 text-xs truncate block">{r.host}</span> },
    { key: 'path',      header: 'Path',        className: 'flex-1 min-w-0 pr-4', render: r => <span className="font-mono text-gray-600 text-xs truncate block" title={r.path}>{r.path}</span> },
    { key: 'userAgent', header: 'User Agent',  className: 'w-48 shrink-0 pr-4 hidden md:block', render: r => <span className="text-gray-600 text-xs truncate block" title={r.userAgent}>{r.userAgent}</span> },
    { key: 'status',    header: 'Status',      className: 'w-16 shrink-0 text-right', render: r => statusBadge(r.status) },
  ]

  const cfRenderDetail = (r: CfLogRow) => {
    const fp = { activeFilters, onFilter: handleFilter }
    return (
      <div className="space-y-5">
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 pb-1.5 border-b border-gray-200">Edge response</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
            <DetailField label="Edge status code"  value={statusBadge(r.status)}  field="sc-status"            filterValue={r.status}      {...fp} />
            <DetailField label="Cache status"      value={r.cacheStatus}          field="x-edge-result-type"   filterValue={r.cacheStatus} {...fp} />
            <DetailField label="Bytes transferred" value={formatBytes(r.bytes)} />
            <DetailField label="Data center"       value={r.dataCenter}           field="x-edge-location"      filterValue={r.dataCenter}  {...fp} />
            <DetailField label="Protocol"          value={r.protocol}             field="cs-protocol-version"  filterValue={r.protocol}    {...fp} />
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-3 pb-1.5 border-b border-gray-200">Request details</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3">
            <DetailField label="IP"       value={<IpLink ip={r.ip} className="text-xs" />}               field="c-ip"          filterValue={r.ip}          {...fp} />
            <DetailField label="Country"  value={r.country}                                               field="c-country"     filterValue={r.country}     {...fp} />
            <DetailField label="Method"   value={<span className="font-semibold">{r.method}</span>}       field="cs-method"     filterValue={r.method}      {...fp} />
            <DetailField label="Browser"  value={r.browser}                                               field="browser"       filterValue={r.browser}     {...fp} />
            <DetailField label="OS"       value={r.os}                                                    field="os"            filterValue={r.os}          {...fp} />
            <DetailField label="Device"   value={r.device}                                                field="device"        filterValue={r.device}      {...fp} />
            <DetailField label="Referrer" value={r.refererHost}                                           field="referer-host"  filterValue={r.refererHost} {...fp} />
            <DetailField label="Host"     value={r.host}                                                  field="cs(Host)"      filterValue={r.host}        {...fp} />
            <DetailField label="Query params" value={r.queryParams}                                       field="cs-uri-query"  filterValue={r.queryParams} {...fp} />
          </div>
        </div>
        <div>
          <div className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5 pb-1.5 border-b border-gray-200">Full path</div>
          <div className="flex items-start gap-1.5 group">
            <span className="font-mono text-xs text-gray-700 break-all">{r.fullPath}</span>
            <div className={`flex items-center gap-0.5 shrink-0 mt-0.5 transition-opacity ${activeFilters.find(f => f.field === 'full-path' && f.value === r.fullPath) ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
              <button onClick={() => handleFilter('full-path', 'Full path', r.fullPath, 'eq')} className="h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold bg-gray-100 text-gray-500 hover:bg-blue-100 hover:text-blue-700">=</button>
              <button onClick={() => handleFilter('full-path', 'Full path', r.fullPath, 'neq')} className="h-4 w-4 rounded flex items-center justify-center text-[10px] font-bold bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-700">≠</button>
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

  const cfLogsBody = {
    filters: activeFilters,
    dateRangeStart: dateRange?.start.toISOString(),
    dateRangeEnd: dateRange?.end.toISOString(),
  }

  if (sessionError) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-600 mb-4">{sessionError}</p>
          <button onClick={onReset} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">
            Load files again
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top nav */}
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold text-xs">CF</div>
          <div>
            <div className="text-base font-semibold text-gray-900 leading-tight flex items-center gap-2">
              HTTP traffic — {session.fileName}
              {querying && (
                <svg className="animate-spin h-3.5 w-3.5 text-blue-400 shrink-0" viewBox="0 0 24 24" fill="none">
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
          <button onClick={onReset} className="text-sm text-blue-600 hover:text-blue-800 font-medium">
            Load another file
          </button>
        </div>
      </div>

      <div className="px-6 py-5 w-full">

        {/* Add filter button + panel */}
        <div className="mb-4">
          <button
            onClick={() => setShowAddFilter(v => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-gray-300 rounded-lg text-gray-600 hover:bg-gray-50 hover:border-gray-400 transition-colors"
          >
            <svg viewBox="0 0 16 16" className="w-3.5 h-3.5" fill="currentColor">
              <path d="M8 2a.75.75 0 0 1 .75.75v4.5h4.5a.75.75 0 0 1 0 1.5h-4.5v4.5a.75.75 0 0 1-1.5 0v-4.5h-4.5a.75.75 0 0 1 0-1.5h4.5v-4.5A.75.75 0 0 1 8 2z"/>
            </svg>
            Add filter
          </button>
          {showAddFilter && (
            <div className="mt-2 max-w-2xl">
              <AddFilterPanel
                fields={CF_FILTER_FIELDS}
                onApply={(field, fieldLabel, value, type) => { handleFilter(field, fieldLabel, value, type); setShowAddFilter(false) }}
                onClose={() => setShowAddFilter(false)}
              />
            </div>
          )}
        </div>

        {/* Active filter chips */}
        {activeFilters.length > 0 && (
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-500 uppercase tracking-wide font-medium">Filters</span>
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
            <button onClick={() => setActiveFilters([])} className="text-xs text-gray-400 hover:text-gray-700 underline">
              Clear all
            </button>
          </div>
        )}

        {/* Requests over time */}
        <div className="bg-white border border-gray-200 rounded-lg p-5 mb-5">
          <div className="flex items-start justify-between mb-1">
            <div>
              <div className="text-sm font-semibold text-gray-700 mb-3">Requests over time</div>
              <div className="flex flex-wrap gap-0 border-b border-gray-200 -mb-px">
                {DIMENSIONS.map(d => (
                  <button
                    key={d.id}
                    onClick={() => setDimension(d.id)}
                    className={`px-3 py-1.5 text-xs font-medium -mb-px transition-colors border-b-2 ${
                      dimension === d.id ? 'text-blue-600 border-blue-600' : 'text-gray-500 border-transparent hover:text-gray-800'
                    }`}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="text-right ml-6">
              <div className="text-xs text-gray-400 mb-0.5">Total requests</div>
              <div className="text-3xl font-bold text-gray-900 tabular-nums leading-none">
                {formatCount(filteredMetrics.total)}
              </div>
              {filteredMetrics.totalBytes > 0 && (
                <div className="text-xs text-gray-400 mt-1">{formatBytes(filteredMetrics.totalBytes)} transferred</div>
              )}
            </div>
          </div>
          <div className="mt-5">
            <RequestsChart
              points={points}
              keys={keys}
              dimension={dimension}
              dimensionLabel={DIMENSIONS.find(d => d.id === dimension)?.label}
              activeFilters={activeFilters}
              onFilter={handleFilter}
            />
          </div>
        </div>

        {/* Volume by country */}
        <div className="bg-white border border-gray-200 rounded-lg mb-5">
          <div className="px-5 py-3 border-b border-gray-100 flex items-start justify-between gap-2">
            <div>
              <span className="text-sm font-semibold text-gray-700">Requests volume by country</span>
              <p className="text-xs text-gray-400 mt-0.5">
                Hover a row to include (<span className="font-bold">=</span>) or exclude (<span className="font-bold">≠</span>) that country.
              </p>
            </div>
            {filteredMetrics.byCountry.length > 0 && (
              <button
                onClick={() => exportMetricEntriesCsv('Country', 'Country', filteredMetrics.byCountry)}
                title={`Export top ${Math.min(filteredMetrics.byCountry.length, 500)} rows as CSV`}
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
          <div className="grid grid-cols-2 divide-x divide-gray-100">
            {[0, 1].map(col => (
              <div key={col}>
                {filteredMetrics.byCountry.slice(col * 10, col * 10 + 10).map(entry => {
                  const ft = countryFilterType(entry.value)
                  return (
                    <CountryRow
                      key={entry.value}
                      value={entry.value}
                      count={entry.count}
                      maxCount={filteredMetrics.byCountry[0]?.count ?? 1}
                      filterType={ft}
                      onInclude={() => handleFilter('c-country', 'Country', entry.value, 'eq')}
                      onExclude={() => handleFilter('c-country', 'Country', entry.value, 'neq')}
                    />
                  )
                })}
              </div>
            ))}
          </div>
          {filteredMetrics.byCountry.length > 20 && (
            <div className="px-5 py-2 border-t border-gray-100 text-xs text-gray-400">
              Showing top 20 of {filteredMetrics.byCountry.length} countries
            </div>
          )}
        </div>

        {/* Paths + User agents + Full path + Query params — half-width each, right after country */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {[
            { title: 'Paths',                field: 'cs-uri-stem',           fieldLabel: 'Path',          entries: filteredMetrics.byPath },
            { title: 'User agents',          field: 'userAgent',             fieldLabel: 'User agent',    entries: filteredMetrics.byUserAgent },
            { title: 'Full path',            field: 'full-path',             fieldLabel: 'Full path',     entries: filteredMetrics.byFullPath },
            { title: 'Query params',         field: 'cs-uri-query',          fieldLabel: 'Query params',  entries: filteredMetrics.byQueryParams },
          ].map(t => (
            <MetricTable
              key={t.field}
              title={t.title}
              field={t.field}
              fieldLabel={t.fieldLabel}
              entries={t.entries}
              activeFilters={activeFilters}
              onFilter={handleFilter}
            />
          ))}
        </div>

        {/* Requests volume by source */}
        <div className="mb-3">
          <div className="text-sm font-semibold text-gray-700 mb-1">Requests volume by source</div>
          <p className="text-xs text-gray-400">
            Hover any row and click <span className="font-bold">=</span> to include or <span className="font-bold">≠</span> to exclude that value from the entire dashboard.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
          {[
            { title: 'Referrers',            field: 'referer-host',         fieldLabel: 'Referer host',  entries: filteredMetrics.byRefererHost },
            { title: 'Hosts',                field: 'cs(Host)',              fieldLabel: 'Host',          entries: filteredMetrics.byHost },
            { title: 'Edge status codes',    field: 'sc-status',             fieldLabel: 'Status code',   entries: filteredMetrics.byStatus },
            { title: 'Source browsers',      field: 'browser',               fieldLabel: 'Browser',       entries: filteredMetrics.byBrowser },
            { title: 'Operating systems',    field: 'os',                    fieldLabel: 'OS',            entries: filteredMetrics.byOS },
            { title: 'Device types',         field: 'device',                fieldLabel: 'Device type',   entries: filteredMetrics.byDevice },
            { title: 'Cache statuses',       field: 'x-edge-result-type',    fieldLabel: 'Cache status',  entries: filteredMetrics.byCache },
            { title: 'HTTP / TLS protocols', field: 'cs-protocol-version',   fieldLabel: 'Protocol',      entries: filteredMetrics.byProtocol },
            { title: 'Data centers',         field: 'x-edge-location',       fieldLabel: 'Data center',   entries: filteredMetrics.byDataCenter },
            { title: 'Source ASNs',          field: 'asn',                   fieldLabel: 'ASN',           entries: filteredMetrics.byAsn },
            { title: 'SSL protocols',        field: 'ssl-protocol',          fieldLabel: 'SSL protocol',  entries: filteredMetrics.bySslProtocol },
            { title: 'Source IPs',           field: 'c-ip',                  fieldLabel: 'IP address',    entries: filteredMetrics.byIp,         isIpField: true },
          ].map(t => (
            <MetricTable
              key={t.field}
              title={t.title}
              field={t.field}
              fieldLabel={t.fieldLabel}
              entries={t.entries}
              activeFilters={activeFilters}
              onFilter={handleFilter}
            />
          ))}
        </div>

        {/* Request logs */}
        <div className="mt-5">
          <LogsTable<CfLogRow>
            title="Sampled logs"
            endpoint={`/api/sessions/${session.sessionId}/rows`}
            requestBody={cfLogsBody}
            columns={CF_COLUMNS}
            renderDetail={cfRenderDetail}
          />
        </div>
      </div>
    </div>
  )
}

function CountryRow({ value, count, maxCount, filterType, onInclude, onExclude }: {
  value: string; count: number; maxCount: number
  filterType: FilterOperator | null
  onInclude: () => void; onExclude: () => void
}) {
  const [hovered, setHovered] = useState(false)
  const isIncluded = filterType !== null && isPositiveOp(filterType)
  const isExcluded = filterType !== null && !isPositiveOp(filterType)

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className={`relative flex items-center gap-2 px-4 py-2.5 border-b border-gray-50 last:border-b-0 transition-colors ${
        isIncluded ? 'bg-blue-50' : isExcluded ? 'bg-red-50' : hovered ? 'bg-gray-50' : ''
      }`}
    >
      <div
        className={`absolute left-0 top-0 bottom-0 opacity-25 ${isIncluded ? 'bg-blue-400' : isExcluded ? 'bg-red-300' : 'bg-blue-100'}`}
        style={{ width: `${(count / maxCount) * 100}%` }}
      />
      <span
        onClick={onInclude}
        className={`relative text-sm flex-1 cursor-pointer truncate ${
          isIncluded ? 'text-blue-800 font-medium' : isExcluded ? 'text-red-400 line-through' : 'text-gray-700'
        }`}
      >
        {value}
      </span>
      <span className={`relative text-sm font-medium tabular-nums ${isIncluded ? 'text-blue-800' : isExcluded ? 'text-red-400' : 'text-gray-600'}`}>
        {formatCount(count)}
      </span>
      <div className={`relative flex items-center gap-0.5 transition-opacity ${hovered || filterType ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <button
          onClick={onInclude}
          title={isIncluded ? 'Remove include filter' : `Include only: ${value}`}
          className={`h-5 w-5 rounded flex items-center justify-center text-xs font-bold transition-colors ${
            isIncluded ? 'bg-blue-200 text-blue-800' : 'bg-gray-100 text-gray-500 hover:bg-blue-100 hover:text-blue-700'
          }`}
        >=</button>
        <button
          onClick={onExclude}
          title={isExcluded ? 'Remove exclude filter' : `Exclude: ${value}`}
          className={`h-5 w-5 rounded flex items-center justify-center text-xs font-bold transition-colors ${
            isExcluded ? 'bg-red-200 text-red-800' : 'bg-gray-100 text-gray-500 hover:bg-red-100 hover:text-red-700'
          }`}
        >≠</button>
      </div>
    </div>
  )
}
