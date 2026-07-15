import type { LogRow, TimeSeriesPoint, MetricEntry, ActiveFilter, Metrics } from '../types'
import type { FilterOperator } from '../types'
import { parseUserAgent, decodeUserAgent } from './userAgent'

export type TimeRange = '5m' | '10m' | '15m' | '30m' | '1' | '2' | '3' | '6' | '12' | 'today' | 'all'

export const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: '5m',    label: '5m' },
  { value: '10m',   label: '10m' },
  { value: '15m',   label: '15m' },
  { value: '30m',   label: '30m' },
  { value: '1',     label: '1h' },
  { value: '2',     label: '2h' },
  { value: '3',     label: '3h' },
  { value: '6',     label: '6h' },
  { value: '12',    label: '12h' },
  { value: 'today', label: 'Today' },
  { value: 'all',   label: 'All' },
]

function rangeToMs(range: TimeRange): number | 'today' | 'all' {
  if (range === 'all') return 'all'
  if (range === 'today') return 'today'
  if (range.endsWith('m')) return parseInt(range) * 60_000
  return parseInt(range) * 3_600_000
}

export function applyDateRange(rows: LogRow[], start: Date, end: Date): LogRow[] {
  const minTs = start.getTime()
  const maxTs = end.getTime()
  return rows.filter(r => {
    const t = new Date(`${r.date}T${r.time}Z`).getTime()
    return !isNaN(t) && t >= minTs && t <= maxTs
  })
}

export function applyTimeRange(rows: LogRow[], range: TimeRange): LogRow[] {
  if (range === 'all' || rows.length === 0) return rows

  // Max timestamp: rows are chronologically ordered so last row is newest
  const last = rows[rows.length - 1]
  const maxTs = new Date(`${last.date}T${last.time}Z`).getTime()
  if (isNaN(maxTs)) return rows

  let minTs: number
  if (range === 'today') {
    // midnight in the browser's local timezone
    const d = new Date(maxTs)
    minTs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  } else {
    minTs = maxTs - (rangeToMs(range) as number)
  }

  return rows.filter(r => {
    const t = new Date(`${r.date}T${r.time}Z`).getTime()
    return !isNaN(t) && t >= minTs
  })
}

function getRefererHost(referer: string): string {
  if (!referer || referer === '-' || referer === '') return 'Direct / None'
  try {
    return new URL(referer).hostname
  } catch {
    return referer
  }
}

function getFieldValue(row: LogRow, field: string): string {
  if (field === 'referer-host') return getRefererHost(row['cs(Referer)'])
  if (field === 'browser') return parseUserAgent(row['cs(User-Agent)']).browser
  if (field === 'os') return parseUserAgent(row['cs(User-Agent)']).os
  if (field === 'device') return parseUserAgent(row['cs(User-Agent)']).device
  if (field === 'userAgent') return decodeUserAgent(row['cs(User-Agent)'])
  if (field === 'full-path') {
    const path = row['cs-uri-stem'] || '/'
    const query = row['cs-uri-query']
    return (query && query !== '-') ? `${path}?${query}` : path
  }
  return row[field] || 'Unknown'
}

function matchesOp(val: string, op: FilterOperator, fv: string): boolean {
  const v = (val ?? '').toLowerCase(), f = fv.toLowerCase()
  const list = () => f.split(',').map(s => s.trim()).filter(Boolean)
  switch (op) {
    case 'eq':              return v === f
    case 'neq':             return v !== f
    case 'contains':        return v.includes(f)
    case 'not_contains':    return !v.includes(f)
    case 'starts_with':     return v.startsWith(f)
    case 'not_starts_with': return !v.startsWith(f)
    case 'ends_with':       return v.endsWith(f)
    case 'not_ends_with':   return !v.endsWith(f)
    case 'in':              return list().includes(v)
    case 'not_in':          return !list().includes(v)
    default: return true
  }
}

export function filterRows(rows: LogRow[], filters: ActiveFilter[]): LogRow[] {
  if (filters.length === 0) return rows
  return rows.filter(row => {
    for (const f of filters) {
      if (!matchesOp(getFieldValue(row, f.field), f.type, f.value)) return false
    }
    return true
  })
}

function getBucketIntervalMs(rows: LogRow[]): number {
  if (rows.length < 2) return 60_000
  const first = rows[0]
  const last = rows[rows.length - 1]
  const t0 = new Date(`${first.date}T${first.time}Z`).getTime()
  const t1 = new Date(`${last.date}T${last.time}Z`).getTime()
  const rangeMs = Math.abs(t1 - t0)
  if (rangeMs <= 3_600_000) return 60_000        // ≤1h  → 1-min buckets
  if (rangeMs <= 21_600_000) return 300_000       // ≤6h  → 5-min buckets
  if (rangeMs <= 86_400_000) return 900_000       // ≤24h → 15-min buckets
  return 3_600_000                                 // >24h → 1-hour buckets
}

export function computeTimeSeries(
  rows: LogRow[],
  filters: ActiveFilter[],
  dimension: string
): { points: TimeSeriesPoint[]; keys: string[] } {
  const filtered = filterRows(rows, filters)
  if (filtered.length === 0) return { points: [], keys: [] }

  const interval = getBucketIntervalMs(filtered)
  const buckets = new Map<number, Map<string, number>>()

  for (const row of filtered) {
    let ts: number
    try {
      ts = new Date(`${row.date}T${row.time}Z`).getTime()
    } catch {
      continue
    }
    const bucketTs = Math.floor(ts / interval) * interval
    if (!buckets.has(bucketTs)) buckets.set(bucketTs, new Map())
    const bucket = buckets.get(bucketTs)!

    const dimValue = dimension === 'all' ? 'requests' : (getFieldValue(row, dimension) || 'Unknown')
    bucket.set(dimValue, (bucket.get(dimValue) ?? 0) + 1)
  }

  // Find top 5 dimension values by total count
  const keyTotals = new Map<string, number>()
  buckets.forEach(counts => {
    counts.forEach((n, k) => keyTotals.set(k, (keyTotals.get(k) ?? 0) + n))
  })

  const keys = dimension === 'all'
    ? ['requests']
    : Array.from(keyTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)

  const points: TimeSeriesPoint[] = Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketTs, counts]) => {
      const d = new Date(bucketTs)
      const hh = d.getHours().toString().padStart(2, '0')
      const mm = d.getMinutes().toString().padStart(2, '0')
      const point: TimeSeriesPoint = { time: `${hh}:${mm}`, timestamp: bucketTs }
      keys.forEach(k => { point[k] = counts.get(k) ?? 0 })
      return point
    })

  return { points, keys }
}

function countBy(rows: LogRow[], keyFn: (row: LogRow) => string): MetricEntry[] {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = keyFn(row)
    if (key && key !== '-') counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const total = rows.length
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count, percentage: total > 0 ? (count / total) * 100 : 0 }))
}

export function computeMetrics(rows: LogRow[], filters: ActiveFilter[]): Metrics {
  const filtered = filterRows(rows, filters)

  let dateRange: { start: string; end: string } | null = null
  if (filtered.length > 0) {
    const f = filtered[0], l = filtered[filtered.length - 1]
    dateRange = { start: `${f.date} ${f.time}`, end: `${l.date} ${l.time}` }
  }

  const totalBytes = filtered.reduce((sum, r) => {
    const b = parseInt(r['sc-bytes'] ?? '0', 10)
    return sum + (isNaN(b) ? 0 : b)
  }, 0)

  return {
    total: filtered.length,
    totalBytes,
    dateRange,
    byCountry: countBy(filtered, r => r['c-country'] || 'Unknown'),
    byRefererHost: countBy(filtered, r => getRefererHost(r['cs(Referer)'])),
    byHost: countBy(filtered, r => r['cs(Host)'] || 'Unknown'),
    byPath: countBy(filtered, r => r['cs-uri-stem'] || '/'),
    byQueryParams: countBy(filtered, r => (r['cs-uri-query'] && r['cs-uri-query'] !== '-') ? r['cs-uri-query'] : 'None'),
    byFullPath: countBy(filtered, r => getFieldValue(r, 'full-path')),
    byStatus: countBy(filtered, r => r['sc-status'] || 'Unknown'),
    byCache: countBy(filtered, r => r['x-edge-result-type'] || 'Unknown'),
    byProtocol: countBy(filtered, r => r['cs-protocol-version'] || 'Unknown'),
    byDataCenter: countBy(filtered, r => r['x-edge-location'] || 'Unknown'),
    byAsn: countBy(filtered, r => r['asn'] || 'Unknown'),
    byBrowser: countBy(filtered, r => parseUserAgent(r['cs(User-Agent)']).browser),
    byOS: countBy(filtered, r => parseUserAgent(r['cs(User-Agent)']).os),
    byDevice: countBy(filtered, r => parseUserAgent(r['cs(User-Agent)']).device),
    bySslProtocol: countBy(filtered, r => r['ssl-protocol'] || 'Unknown'),
    byIp: countBy(filtered, r => r['c-ip'] || 'Unknown'),
    byUserAgent: countBy(filtered, r => decodeUserAgent(r['cs(User-Agent)'])),
  }
}
