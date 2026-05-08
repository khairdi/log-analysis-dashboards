export interface LogRow {
  [key: string]: string
}

export interface ParsedLog {
  version: string
  fields: string[]
  rows: LogRow[]
}

export interface TimeSeriesPoint {
  time: string
  timestamp: number
  [key: string]: string | number
}

export interface MetricEntry {
  value: string
  count: number
  percentage: number
}

export type FilterOperator =
  | 'eq' | 'neq'
  | 'contains' | 'not_contains'
  | 'starts_with' | 'ends_with'
  | 'not_starts_with' | 'not_ends_with'
  | 'in' | 'not_in'

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq:              'equals',
  neq:             'does not equal',
  contains:        'contains',
  not_contains:    'does not contain',
  starts_with:     'starts with',
  not_starts_with: 'does not start with',
  ends_with:       'ends with',
  not_ends_with:   'does not end with',
  in:              'is in',
  not_in:          'is not in',
}

export const OPERATOR_SYMBOL: Record<FilterOperator, string> = {
  eq:              '=',
  neq:             '≠',
  contains:        '~',
  not_contains:    '!~',
  starts_with:     '^',
  not_starts_with: '!^',
  ends_with:       '$',
  not_ends_with:   '!$',
  in:              '∈',
  not_in:          '∉',
}

/** Positive operators render as blue chips; negative as red. */
export function isPositiveOp(op: FilterOperator): boolean {
  return op === 'eq' || op === 'contains' || op === 'starts_with' || op === 'ends_with' || op === 'in'
}

export interface ActiveFilter {
  field: string
  fieldLabel: string
  value: string
  type: FilterOperator
}

// Returned by /api/sessions/* — all metrics are pre-computed server-side
export interface SessionData {
  sessionId: string
  fileName: string
  rowCount: number
  dataMin: string   // ISO timestamp of first row
  dataMax: string   // ISO timestamp of last row
  tableMetrics: Metrics
  filteredMetrics: Metrics
  points: TimeSeriesPoint[]
  keys: string[]
  cacheStats?: { hits: number; misses: number }
}

export interface QueryResult {
  tableMetrics: Metrics
  filteredMetrics: Metrics
  points: TimeSeriesPoint[]
  keys: string[]
}

export interface CfLogRow {
  ts: number
  timestamp: string
  ip: string
  country: string
  method: string
  host: string
  path: string
  status: string
  bytes: number
  cacheStatus: string
  refererHost: string
  browser: string
  os: string
  dataCenter: string
  protocol: string
}

export interface RowsResult {
  rows: CfLogRow[]
  total: number
  page: number
  pageSize: number
}

export interface Metrics {
  total: number
  totalBytes: number
  dateRange: { start: string; end: string } | null
  byCountry: MetricEntry[]
  byRefererHost: MetricEntry[]
  byHost: MetricEntry[]
  byPath: MetricEntry[]
  byStatus: MetricEntry[]
  byCache: MetricEntry[]
  byProtocol: MetricEntry[]
  byDataCenter: MetricEntry[]
  byAsn: MetricEntry[]
  byBrowser: MetricEntry[]
  byOS: MetricEntry[]
  bySslProtocol: MetricEntry[]
  byIp: MetricEntry[]
}
