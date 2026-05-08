import type { MetricEntry, TimeSeriesPoint, ActiveFilter } from '../types'

export interface WafMetrics {
  total: number
  blocked: number
  allowed: number
  challenged: number   // CAPTCHA + CHALLENGE combined
  counted: number
  dateRange: { start: string; end: string } | null
  byAction: MetricEntry[]
  byCountry: MetricEntry[]
  byClientIp: MetricEntry[]
  byUri: MetricEntry[]
  byHost: MetricEntry[]
  byMethod: MetricEntry[]
  byHttpVersion: MetricEntry[]
  byTerminatingRule: MetricEntry[]
  byTerminatingRuleType: MetricEntry[]
  byLabel: MetricEntry[]
  byRuleGroup: MetricEntry[]
  byJa3: MetricEntry[]
  byJa4: MetricEntry[]
  byUserAgent: MetricEntry[]
}

export interface WafSessionData {
  sessionId: string
  fileName: string
  rowCount: number
  dataMin: string   // ISO: YYYY-MM-DDTHH:MM:SS.sssZ
  dataMax: string
  tableMetrics: WafMetrics
  filteredMetrics: WafMetrics
  points: TimeSeriesPoint[]
  keys: string[]
  cacheStats?: { hits: number; misses: number }
}

export interface WafQueryResult {
  tableMetrics: WafMetrics
  filteredMetrics: WafMetrics
  points: TimeSeriesPoint[]
  keys: string[]
}

export interface WafLogRow {
  ts: number
  timestamp: string
  action: string
  clientIp: string
  country: string
  host: string
  uri: string
  method: string
  httpVersion: string
  terminatingRule: string
  terminatingRuleType: string
  labels: string[]
  ja3: string
  ja4: string
  userAgent: string
}

export interface WafRowsResult {
  rows: WafLogRow[]
  total: number
  page: number
  pageSize: number
}

export type { ActiveFilter, FilterOperator } from '../types'
