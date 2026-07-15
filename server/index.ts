import express from 'express'
import cors from 'cors'
import { S3Client, ListObjectsV2Command, GetObjectCommand, GetBucketLocationCommand } from '@aws-sdk/client-s3'
import { fromIni } from '@aws-sdk/credential-providers'
import { gunzipSync } from 'zlib'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import { parseUserAgent, decodeUserAgent } from '../src/lib/userAgent'
import type { ActiveFilter, MetricEntry, Metrics, TimeSeriesPoint, SessionData, QueryResult } from '../src/types'
import type { WafMetrics, WafSessionData, WafQueryResult, WafLogRow, WafRowsResult } from '../src/waf/types'
import type { CfLogRow, RowsResult } from '../src/types'

// ── Local disk cache ─────────────────────────────────────────────────────────
const CACHE_DIR = process.env.CACHE_DIR ?? join(homedir(), '.cloudfront-dashboard-cache')
mkdirSync(CACHE_DIR, { recursive: true })

function cachePath(bucket: string, key: string): string {
  return join(CACHE_DIR, bucket, key)
}

function readCache(bucket: string, key: string): string | null {
  const p = cachePath(bucket, key)
  return existsSync(p) ? readFileSync(p, 'utf-8') : null
}

function writeCache(bucket: string, key: string, text: string): void {
  const p = cachePath(bucket, key)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text, 'utf-8')
}

// ── Session store ─────────────────────────────────────────────────────────────
// Sessions hold only metadata + file paths — NO parsed row objects in memory.
// Actual metrics are streamed from disk on every query.
interface Session {
  filePaths: string[]
  fileName: string
  rowCount: number
  dataMin: string   // ISO: YYYY-MM-DDTHH:MM:SSZ
  dataMax: string
  lastAccess: number
}

const sessions = new Map<string, Session>()

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [id, s] of sessions) {
    if (s.lastAccess < cutoff) {
      sessions.delete(id)
      console.log(`[session expired] ${id}`)
    }
  }
}, 10 * 60 * 1000).unref()

// ── Streaming metrics computation ─────────────────────────────────────────────
// Reads each cache file once, processes line-by-line, accumulates count maps.
// Peak memory: ~1 file's decompressed text + small count maps. No LogRow objects.

function getRefererHost(referer: string): string {
  if (!referer || referer === '-' || referer === '') return 'Direct / None'
  try { return new URL(referer).hostname } catch { return referer }
}

function inc(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1)
}

// CloudFront standard logs come in two shapes: legacy tab-delimited W3C
// (with a "#Fields:" header naming each column) or newer JSON-per-line
// (same field names, but as JSON object keys). Format is fixed for a given
// distribution, so we detect it once from the first content line and reuse
// that decision for the rest of the file.
type CfLineState = { fieldIndex: Record<string, number>; jsonMode: boolean | null }
function newCfLineState(): CfLineState {
  return { fieldIndex: {}, jsonMode: null }
}
/** Returns a field accessor for a data row, or null if `line` is a header/comment/unparseable row. */
function cfLineGetter(line: string, state: CfLineState): ((name: string) => string) | null {
  if (state.jsonMode === null) {
    if (line.startsWith('#Fields:')) {
      line.slice('#Fields:'.length).trim().split('\t').forEach((f, i) => { state.fieldIndex[f] = i })
      state.jsonMode = false
      return null
    }
    if (line.startsWith('#')) return null
    if (line.startsWith('{')) state.jsonMode = true
    else return null
  }
  if (line.startsWith('#')) return null
  if (state.jsonMode) {
    let obj: Record<string, unknown>
    try { obj = JSON.parse(line) } catch { return null }
    return (name: string) => { const v = obj[name]; return v == null ? '-' : String(v) }
  }
  const vals = line.split('\t')
  return (name: string) => vals[state.fieldIndex[name]] ?? '-'
}

/** Returns true when a single string value satisfies the filter. */
function matchesOp(val: string, op: string, fv: string): boolean {
  const v = (val ?? '').toLowerCase(), f = fv.toLowerCase()
  const list = () => f.split(',').map(s => s.trim()).filter(Boolean)
  switch (op) {
    case 'eq':              case 'include': return v === f
    case 'neq':             case 'exclude': return v !== f
    case 'contains':                        return v.includes(f)
    case 'not_contains':                    return !v.includes(f)
    case 'starts_with':                     return v.startsWith(f)
    case 'not_starts_with':                 return !v.startsWith(f)
    case 'ends_with':                       return v.endsWith(f)
    case 'not_ends_with':                   return !v.endsWith(f)
    case 'in':                              return list().includes(v)
    case 'not_in':                          return !list().includes(v)
    default: return true
  }
}

/** Returns true when any element of an array satisfies the filter (for WAF labels/ruleGroups). */
function arrayMatchesOp(arr: string[], op: string, fv: string): boolean {
  const f = fv.toLowerCase()
  const list = () => f.split(',').map(s => s.trim()).filter(Boolean)
  switch (op) {
    case 'eq':              case 'include': return arr.some(v => v.toLowerCase() === f)
    case 'neq':             case 'exclude': return !arr.some(v => v.toLowerCase() === f)
    case 'contains':                        return arr.some(v => v.toLowerCase().includes(f))
    case 'not_contains':                    return !arr.some(v => v.toLowerCase().includes(f))
    case 'starts_with':                     return arr.some(v => v.toLowerCase().startsWith(f))
    case 'not_starts_with':                 return !arr.some(v => v.toLowerCase().startsWith(f))
    case 'ends_with':                       return arr.some(v => v.toLowerCase().endsWith(f))
    case 'not_ends_with':                   return !arr.some(v => v.toLowerCase().endsWith(f))
    case 'in':                              return arr.some(v => list().includes(v.toLowerCase()))
    case 'not_in':                          return !arr.some(v => list().includes(v.toLowerCase()))
    default: return true
  }
}

function mapToEntries(m: Map<string, number>, total: number): MetricEntry[] {
  return Array.from(m.entries())
    .filter(([v]) => v && v !== '-')
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count, percentage: total > 0 ? (count / total) * 100 : 0 }))
}

function getBucketMs(rangeMs: number): number {
  if (rangeMs <= 3_600_000) return 60_000         // ≤1h  → 1-min buckets
  if (rangeMs <= 21_600_000) return 300_000        // ≤6h  → 5-min buckets
  if (rangeMs <= 86_400_000) return 900_000        // ≤24h → 15-min buckets
  return 3_600_000                                  // >24h → 1-hour buckets
}

interface StreamResult {
  tableMetrics: Metrics
  filteredMetrics: Metrics
  points: TimeSeriesPoint[]
  keys: string[]
  rowCount: number
  dataMin: string
  dataMax: string
}

function computeFromFilePaths(
  filePaths: string[],
  filters: ActiveFilter[],
  dateRangeStart: Date | null,
  dateRangeEnd: Date | null,
  dimension: string,
  dataMin: string,
  dataMax: string
): StreamResult {
  // Determine bucket interval from the effective query range
  const refStart = dateRangeStart ?? (dataMin ? new Date(dataMin) : null)
  const refEnd = dateRangeEnd ?? (dataMax ? new Date(dataMax) : null)
  const rangeMs = refStart && refEnd ? Math.abs(refEnd.getTime() - refStart.getTime()) : 86_400_000
  const bucketMs = getBucketMs(rangeMs)

  const minTs = dateRangeStart ? dateRangeStart.getTime() : -Infinity
  const maxTs = dateRangeEnd ? dateRangeEnd.getTime() : Infinity

  // TABLE accumulators (all rows in date range, no filter)
  let tCount = 0, tBytes = 0
  let tFirst = '', tLast = ''
  const tCountry = new Map<string, number>()
  const tReferer = new Map<string, number>()
  const tHost = new Map<string, number>()
  const tPath = new Map<string, number>()
  const tQuery = new Map<string, number>()
  const tFullPath = new Map<string, number>()
  const tStatus = new Map<string, number>()
  const tCache = new Map<string, number>()
  const tProtocol = new Map<string, number>()
  const tDC = new Map<string, number>()
  const tASN = new Map<string, number>()
  const tBrowser = new Map<string, number>()
  const tOS = new Map<string, number>()
  const tDevice = new Map<string, number>()
  const tSSL = new Map<string, number>()
  const tIP = new Map<string, number>()
  const tUA = new Map<string, number>()

  // FILTERED accumulators
  let fCount = 0, fBytes = 0
  let fFirst = '', fLast = ''
  const fCountry = new Map<string, number>()
  const fReferer = new Map<string, number>()
  const fHost = new Map<string, number>()
  const fPath = new Map<string, number>()
  const fQuery = new Map<string, number>()
  const fFullPath = new Map<string, number>()
  const fStatus = new Map<string, number>()
  const fCache = new Map<string, number>()
  const fProtocol = new Map<string, number>()
  const fDC = new Map<string, number>()
  const fASN = new Map<string, number>()
  const fBrowser = new Map<string, number>()
  const fOS = new Map<string, number>()
  const fDevice = new Map<string, number>()
  const fSSL = new Map<string, number>()
  const fIP = new Map<string, number>()
  const fUA = new Map<string, number>()

  // Time series
  const timeBuckets = new Map<number, Map<string, number>>()

  const cfState = newCfLineState()

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {
      console.warn(`[warn] cache file not found: ${filePath}`)
      continue
    }
    // Read one file at a time — previous file's string is GC-eligible after this loop
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue

      const get = cfLineGetter(line, cfState)
      if (!get) continue

      const date = get('date')
      const time = get('time')
      if (!date || date === '-' || !time || time === '-') continue

      const ts = new Date(`${date}T${time}Z`).getTime()
      if (isNaN(ts) || ts < minTs || ts > maxTs) continue

      // Derive all values once per row (reused for both table + filtered accums)
      const country  = get('c-country') || 'Unknown'
      const refHost  = getRefererHost(get('cs(Referer)'))
      const host     = get('cs(Host)') || 'Unknown'
      const path     = get('cs-uri-stem') || '/'
      const rawQuery = get('cs-uri-query')
      const queryParams = (rawQuery && rawQuery !== '-') ? rawQuery : 'None'
      const fullPath = queryParams !== 'None' ? `${path}?${queryParams}` : path
      const status   = get('sc-status') || 'Unknown'
      const cache    = get('x-edge-result-type') || 'Unknown'
      const protocol = get('cs-protocol-version') || 'Unknown'
      const dc       = get('x-edge-location') || 'Unknown'
      const asn      = get('asn') || 'Unknown'
      const uaStr    = get('cs(User-Agent)')
      const ua       = parseUserAgent(uaStr)
      const decodedUA= decodeUserAgent(uaStr)
      const ssl      = get('ssl-protocol') || 'Unknown'
      const ip       = get('c-ip') || 'Unknown'
      const bytesRaw = parseInt(get('sc-bytes'), 10)
      const bytes    = isNaN(bytesRaw) ? 0 : bytesRaw
      const rowLabel = `${date} ${time}`

      // Table accumulation (unfiltered)
      tCount++
      tBytes += bytes
      if (!tFirst) tFirst = rowLabel
      tLast = rowLabel

      inc(tCountry,  country)
      inc(tReferer,  refHost)
      inc(tHost,     host)
      inc(tPath,     path)
      inc(tQuery,    queryParams)
      inc(tFullPath, fullPath)
      inc(tStatus,   status)
      inc(tCache,    cache)
      inc(tProtocol, protocol)
      inc(tDC,       dc)
      inc(tASN,      asn)
      inc(tBrowser,  ua.browser)
      inc(tOS,       ua.os)
      inc(tDevice,   ua.device)
      inc(tSSL,      ssl)
      inc(tIP,       ip)
      inc(tUA,       decodedUA)

      // Filter check
      let passes = true
      for (const f of filters) {
        let val: string
        if      (f.field === 'referer-host') val = refHost
        else if (f.field === 'browser')      val = ua.browser
        else if (f.field === 'os')           val = ua.os
        else if (f.field === 'device')       val = ua.device
        else if (f.field === 'userAgent')    val = decodedUA
        else if (f.field === 'full-path')    val = fullPath
        else                                 val = get(f.field) || 'Unknown'
        if (!matchesOp(val, f.type, f.value)) { passes = false; break }
      }

      if (!passes) continue

      // Filtered accumulation
      fCount++
      fBytes += bytes
      if (!fFirst) fFirst = rowLabel
      fLast = rowLabel

      inc(fCountry,  country)
      inc(fReferer,  refHost)
      inc(fHost,     host)
      inc(fPath,     path)
      inc(fQuery,    queryParams)
      inc(fFullPath, fullPath)
      inc(fStatus,   status)
      inc(fCache,    cache)
      inc(fProtocol, protocol)
      inc(fDC,       dc)
      inc(fASN,      asn)
      inc(fBrowser,  ua.browser)
      inc(fOS,       ua.os)
      inc(fDevice,   ua.device)
      inc(fSSL,      ssl)
      inc(fIP,       ip)
      inc(fUA,       decodedUA)

      // Time series bucket
      const bucketTs = Math.floor(ts / bucketMs) * bucketMs
      if (!timeBuckets.has(bucketTs)) timeBuckets.set(bucketTs, new Map())
      const bucket = timeBuckets.get(bucketTs)!
      let dimVal: string
      if      (dimension === 'all')          dimVal = 'requests'
      else if (dimension === 'referer-host') dimVal = refHost
      else if (dimension === 'browser')      dimVal = ua.browser
      else if (dimension === 'os')           dimVal = ua.os
      else if (dimension === 'device')       dimVal = ua.device
      else if (dimension === 'userAgent')    dimVal = decodedUA
      else if (dimension === 'full-path')    dimVal = fullPath
      else                                   dimVal = get(dimension) || 'Unknown'
      inc(bucket, dimVal)
    }
  }

  // Build time series
  const keyTotals = new Map<string, number>()
  timeBuckets.forEach(counts => {
    counts.forEach((n, k) => keyTotals.set(k, (keyTotals.get(k) ?? 0) + n))
  })
  const keys = dimension === 'all'
    ? ['requests']
    : Array.from(keyTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)

  const points: TimeSeriesPoint[] = Array.from(timeBuckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketTs, counts]) => {
      const d = new Date(bucketTs)
      const hh = d.getUTCHours().toString().padStart(2, '0')
      const mm = d.getUTCMinutes().toString().padStart(2, '0')
      const point: TimeSeriesPoint = { time: `${hh}:${mm}`, timestamp: bucketTs }
      keys.forEach(k => { point[k] = counts.get(k) ?? 0 })
      return point
    })

  const tableMetrics: Metrics = {
    total: tCount, totalBytes: tBytes,
    dateRange: tFirst ? { start: tFirst, end: tLast } : null,
    byCountry:    mapToEntries(tCountry,  tCount),
    byRefererHost:mapToEntries(tReferer,  tCount),
    byHost:       mapToEntries(tHost,     tCount),
    byPath:       mapToEntries(tPath,     tCount),
    byQueryParams:mapToEntries(tQuery,    tCount),
    byFullPath:   mapToEntries(tFullPath, tCount),
    byStatus:     mapToEntries(tStatus,   tCount),
    byCache:      mapToEntries(tCache,    tCount),
    byProtocol:   mapToEntries(tProtocol, tCount),
    byDataCenter: mapToEntries(tDC,       tCount),
    byAsn:        mapToEntries(tASN,      tCount),
    byBrowser:    mapToEntries(tBrowser,  tCount),
    byOS:         mapToEntries(tOS,       tCount),
    byDevice:     mapToEntries(tDevice,   tCount),
    bySslProtocol:mapToEntries(tSSL,      tCount),
    byIp:         mapToEntries(tIP,       tCount),
    byUserAgent:  mapToEntries(tUA,       tCount),
  }

  const filteredMetrics: Metrics = {
    total: fCount, totalBytes: fBytes,
    dateRange: fFirst ? { start: fFirst, end: fLast } : null,
    byCountry:    mapToEntries(fCountry,  fCount),
    byRefererHost:mapToEntries(fReferer,  fCount),
    byHost:       mapToEntries(fHost,     fCount),
    byPath:       mapToEntries(fPath,     fCount),
    byQueryParams:mapToEntries(fQuery,    fCount),
    byFullPath:   mapToEntries(fFullPath, fCount),
    byStatus:     mapToEntries(fStatus,   fCount),
    byCache:      mapToEntries(fCache,    fCount),
    byProtocol:   mapToEntries(fProtocol, fCount),
    byDataCenter: mapToEntries(fDC,       fCount),
    byAsn:        mapToEntries(fASN,      fCount),
    byBrowser:    mapToEntries(fBrowser,  fCount),
    byOS:         mapToEntries(fOS,       fCount),
    byDevice:     mapToEntries(fDevice,   fCount),
    bySslProtocol:mapToEntries(fSSL,      fCount),
    byIp:         mapToEntries(fIP,       fCount),
    byUserAgent:  mapToEntries(fUA,       fCount),
  }

  return {
    tableMetrics, filteredMetrics, points, keys,
    rowCount: tCount,
    dataMin: tFirst ? `${tFirst.slice(0, 10)}T${tFirst.slice(11)}Z` : '',
    dataMax: tLast  ? `${tLast.slice(0, 10)}T${tLast.slice(11)}Z`  : '',
  }
}

// ── WAF Session store ─────────────────────────────────────────────────────────
interface WafSession {
  filePaths: string[]
  fileName: string
  rowCount: number
  dataMin: string
  dataMax: string
  lastAccess: number
}

const wafSessions = new Map<string, WafSession>()

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [id, s] of wafSessions) {
    if (s.lastAccess < cutoff) { wafSessions.delete(id); console.log(`[waf session expired] ${id}`) }
  }
}, 10 * 60 * 1000).unref()

// ── WAF streaming metrics computation ─────────────────────────────────────────
// Reads each WAF cache file (JSON-per-line), accumulates count Maps.
// No parsed objects are retained between lines — only aggregate maps.

interface WafStreamResult {
  tableMetrics: WafMetrics
  filteredMetrics: WafMetrics
  points: TimeSeriesPoint[]
  keys: string[]
  rowCount: number
  dataMin: string
  dataMax: string
}

function computeWafFromFilePaths(
  filePaths: string[],
  filters: ActiveFilter[],
  dateRangeStart: Date | null,
  dateRangeEnd: Date | null,
  dimension: string,
  dataMin: string,
  dataMax: string
): WafStreamResult {
  const refStart = dateRangeStart ?? (dataMin ? new Date(dataMin) : null)
  const refEnd   = dateRangeEnd   ?? (dataMax ? new Date(dataMax) : null)
  const rangeMs  = refStart && refEnd ? Math.abs(refEnd.getTime() - refStart.getTime()) : 86_400_000
  const bucketMs = getBucketMs(rangeMs)
  const minTs = dateRangeStart ? dateRangeStart.getTime() : -Infinity
  const maxTs = dateRangeEnd   ? dateRangeEnd.getTime()   : Infinity

  // TABLE accumulators
  let tCount = 0, tBlocked = 0, tAllowed = 0, tChallenged = 0, tCounted = 0
  let tFirst = '', tLast = ''
  const tAction   = new Map<string, number>(), tCountry  = new Map<string, number>()
  const tClientIp = new Map<string, number>(), tUri      = new Map<string, number>()
  const tHost     = new Map<string, number>(), tMethod   = new Map<string, number>()
  const tHttpVer  = new Map<string, number>(), tTermRule = new Map<string, number>()
  const tRuleType = new Map<string, number>(), tLabel    = new Map<string, number>()
  const tRuleGrp  = new Map<string, number>(), tJa3      = new Map<string, number>()
  const tJa4      = new Map<string, number>(), tUA       = new Map<string, number>()

  // FILTERED accumulators
  let fCount = 0, fBlocked = 0, fAllowed = 0, fChallenged = 0, fCounted = 0
  let fFirst = '', fLast = ''
  const fAction   = new Map<string, number>(), fCountry  = new Map<string, number>()
  const fClientIp = new Map<string, number>(), fUri      = new Map<string, number>()
  const fHost     = new Map<string, number>(), fMethod   = new Map<string, number>()
  const fHttpVer  = new Map<string, number>(), fTermRule = new Map<string, number>()
  const fRuleType = new Map<string, number>(), fLabel    = new Map<string, number>()
  const fRuleGrp  = new Map<string, number>(), fJa3      = new Map<string, number>()
  const fJa4      = new Map<string, number>(), fUA       = new Map<string, number>()

  const timeBuckets = new Map<number, Map<string, number>>()

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) { console.warn(`[waf warn] cache file not found: ${filePath}`); continue }
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.split('\n')

    for (const rawLine of lines) {
      const line = rawLine.trim()
      if (!line) continue

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let entry: Record<string, any>
      try { entry = JSON.parse(line) } catch { continue }

      const ts: number = entry.timestamp
      if (!ts || isNaN(ts) || ts < minTs || ts > maxTs) continue

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: Record<string, any>   = entry.httpRequest ?? {}
      const action: string             = entry.action ?? 'UNKNOWN'
      const terminatingRuleId: string  = entry.terminatingRuleId ?? 'Unknown'
      const terminatingRuleType: string= entry.terminatingRuleType ?? 'Unknown'
      const country: string            = req.country ?? 'Unknown'
      const clientIp: string           = req.clientIp ?? 'Unknown'
      const uri: string                = req.uri ?? '/'
      const host: string               = req.host
        ?? (req.headers ?? []).find((h: { name: string }) => h.name === 'host')?.value
        ?? 'Unknown'
      const httpMethod: string  = req.httpMethod ?? 'Unknown'
      const httpVersion: string = req.httpVersion ?? 'Unknown'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ua: string = (req.headers ?? []).find((h: any) => h.name?.toLowerCase() === 'user-agent')?.value ?? 'Unknown'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const labels: string[]       = (entry.labels ?? []).map((l: any) => l.name as string).filter(Boolean)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchedGroups: string[]= (entry.ruleGroupList ?? []).filter((rg: any) =>
        rg.terminatingRule || (rg.nonTerminatingMatchingRules ?? []).length > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ).map((rg: any) => rg.ruleGroupId as string)
      const ja3: string = entry.ja3Fingerprint ?? '-'
      const ja4: string = entry.ja4Fingerprint ?? '-'

      const d = new Date(ts)
      const dateLabel = d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 19)

      // TABLE accumulation
      tCount++
      if      (action === 'BLOCK')                      tBlocked++
      else if (action === 'ALLOW')                      tAllowed++
      else if (action === 'CAPTCHA' || action === 'CHALLENGE') tChallenged++
      else if (action === 'COUNT')                      tCounted++
      if (!tFirst) tFirst = dateLabel
      tLast = dateLabel

      inc(tAction, action); inc(tCountry, country); inc(tClientIp, clientIp)
      inc(tUri, uri); inc(tHost, host); inc(tMethod, httpMethod)
      inc(tHttpVer, httpVersion); inc(tTermRule, terminatingRuleId)
      inc(tRuleType, terminatingRuleType)
      for (const lb of labels)       inc(tLabel, lb)
      for (const rg of matchedGroups) inc(tRuleGrp, rg)
      if (ja3 && ja3 !== '-') inc(tJa3, ja3)
      if (ja4 && ja4 !== '-') inc(tJa4, ja4)
      inc(tUA, ua)

      // FILTER check
      let passes = true
      for (const f of filters) {
        const isLbl = f.field === 'label', isRG = f.field === 'ruleGroup'
        if (isLbl || isRG) {
          if (!arrayMatchesOp(isLbl ? labels : matchedGroups, f.type, f.value)) { passes = false; break }
        } else {
          let val: string
          switch (f.field) {
            case 'action':              val = action; break
            case 'country':             val = country; break
            case 'clientIp':            val = clientIp; break
            case 'uri':                 val = uri; break
            case 'host':                val = host; break
            case 'method':              val = httpMethod; break
            case 'httpVersion':         val = httpVersion; break
            case 'terminatingRule':     val = terminatingRuleId; break
            case 'terminatingRuleType': val = terminatingRuleType; break
            case 'ja3':                 val = ja3; break
            case 'ja4':                 val = ja4; break
            case 'userAgent':           val = ua; break
            default:                    val = 'Unknown'
          }
          if (!matchesOp(val, f.type, f.value)) { passes = false; break }
        }
      }

      if (!passes) continue

      // FILTERED accumulation
      fCount++
      if      (action === 'BLOCK')                      fBlocked++
      else if (action === 'ALLOW')                      fAllowed++
      else if (action === 'CAPTCHA' || action === 'CHALLENGE') fChallenged++
      else if (action === 'COUNT')                      fCounted++
      if (!fFirst) fFirst = dateLabel
      fLast = dateLabel

      inc(fAction, action); inc(fCountry, country); inc(fClientIp, clientIp)
      inc(fUri, uri); inc(fHost, host); inc(fMethod, httpMethod)
      inc(fHttpVer, httpVersion); inc(fTermRule, terminatingRuleId)
      inc(fRuleType, terminatingRuleType)
      for (const lb of labels)       inc(fLabel, lb)
      for (const rg of matchedGroups) inc(fRuleGrp, rg)
      if (ja3 && ja3 !== '-') inc(fJa3, ja3)
      if (ja4 && ja4 !== '-') inc(fJa4, ja4)
      inc(fUA, ua)

      // Time series
      const bucketTs = Math.floor(ts / bucketMs) * bucketMs
      if (!timeBuckets.has(bucketTs)) timeBuckets.set(bucketTs, new Map())
      const bucket = timeBuckets.get(bucketTs)!
      let dimVal: string
      switch (dimension) {
        case 'action':          dimVal = action; break
        case 'country':         dimVal = country; break
        case 'method':          dimVal = httpMethod; break
        case 'terminatingRule': dimVal = terminatingRuleId; break
        default:                dimVal = 'requests'
      }
      inc(bucket, dimVal)
    }
  }

  // Build time series
  const keyTotals = new Map<string, number>()
  timeBuckets.forEach(counts => counts.forEach((n, k) => keyTotals.set(k, (keyTotals.get(k) ?? 0) + n)))
  const keys = dimension === 'all'
    ? ['requests']
    : Array.from(keyTotals.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k)
  const points: TimeSeriesPoint[] = Array.from(timeBuckets.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([bucketTs, counts]) => {
      const d = new Date(bucketTs)
      const hh = d.getUTCHours().toString().padStart(2, '0')
      const mm = d.getUTCMinutes().toString().padStart(2, '0')
      const point: TimeSeriesPoint = { time: `${hh}:${mm}`, timestamp: bucketTs }
      keys.forEach(k => { point[k] = counts.get(k) ?? 0 })
      return point
    })

  const buildWafMetrics = (
    count: number, blocked: number, allowed: number, challenged: number, counted: number,
    first: string, last: string,
    mAction: Map<string, number>, mCountry: Map<string, number>, mClientIp: Map<string, number>,
    mUri: Map<string, number>, mHost: Map<string, number>, mMethod: Map<string, number>,
    mHttpVer: Map<string, number>, mTermRule: Map<string, number>, mRuleType: Map<string, number>,
    mLabel: Map<string, number>, mRuleGrp: Map<string, number>, mJa3: Map<string, number>,
    mJa4: Map<string, number>, mUA: Map<string, number>
  ): WafMetrics => ({
    total: count, blocked, allowed, challenged, counted,
    dateRange: first ? { start: first, end: last } : null,
    byAction:             mapToEntries(mAction,   count),
    byCountry:            mapToEntries(mCountry,  count),
    byClientIp:           mapToEntries(mClientIp, count),
    byUri:                mapToEntries(mUri,       count),
    byHost:               mapToEntries(mHost,      count),
    byMethod:             mapToEntries(mMethod,    count),
    byHttpVersion:        mapToEntries(mHttpVer,   count),
    byTerminatingRule:    mapToEntries(mTermRule,  count),
    byTerminatingRuleType:mapToEntries(mRuleType,  count),
    byLabel:              mapToEntries(mLabel,     count),
    byRuleGroup:          mapToEntries(mRuleGrp,   count),
    byJa3:                mapToEntries(mJa3,       count),
    byJa4:                mapToEntries(mJa4,       count),
    byUserAgent:          mapToEntries(mUA,        count),
  })

  const tableMetrics    = buildWafMetrics(tCount, tBlocked, tAllowed, tChallenged, tCounted, tFirst, tLast, tAction, tCountry, tClientIp, tUri, tHost, tMethod, tHttpVer, tTermRule, tRuleType, tLabel, tRuleGrp, tJa3, tJa4, tUA)
  const filteredMetrics = buildWafMetrics(fCount, fBlocked, fAllowed, fChallenged, fCounted, fFirst, fLast, fAction, fCountry, fClientIp, fUri, fHost, fMethod, fHttpVer, fTermRule, fRuleType, fLabel, fRuleGrp, fJa3, fJa4, fUA)

  return {
    tableMetrics, filteredMetrics, points, keys,
    rowCount: tCount,
    dataMin: tFirst ? new Date(tFirst.replace(' ', 'T') + 'Z').toISOString() : '',
    dataMax: tLast  ? new Date(tLast.replace(' ', 'T')  + 'Z').toISOString() : '',
  }
}

// ── Express app ────────────────────────────────────────────────────────────────
const app = express()
app.use(cors())
app.use(express.json())

// Named profiles from ~/.aws/credentials and ~/.aws/config (section names only — never read secret values here).
function listAwsProfiles(): string[] {
  const profiles = new Set<string>(['default'])
  for (const file of [join(homedir(), '.aws', 'credentials'), join(homedir(), '.aws', 'config')]) {
    if (!existsSync(file)) continue
    const isConfigFile = file.endsWith('config')
    for (const line of readFileSync(file, 'utf-8').split('\n')) {
      const match = line.match(/^\s*\[\s*(.+?)\s*\]\s*$/)
      if (!match) continue
      const name = isConfigFile ? match[1].replace(/^profile\s+/, '') : match[1]
      profiles.add(name)
    }
  }
  return Array.from(profiles).sort()
}

// One S3 client per (profile, region) pair.
const s3Clients = new Map<string, S3Client>()
function s3ForRegion(region: string, profile?: string): S3Client {
  const key = `${profile ?? ''}::${region}`
  if (!s3Clients.has(key)) {
    s3Clients.set(key, new S3Client({
      region,
      ...(profile ? { credentials: fromIni({ profile }) } : {}),
    }))
  }
  return s3Clients.get(key)!
}

// Cache bucket → region so we only call GetBucketLocation once per (profile, bucket).
const bucketRegionCache = new Map<string, string>()
async function s3ForBucket(bucket: string, profile?: string): Promise<S3Client> {
  const cacheKey = `${profile ?? ''}::${bucket}`
  if (!bucketRegionCache.has(cacheKey)) {
    try {
      // GetBucketLocation requires us-east-1 as the initial region.
      const probe = s3ForRegion('us-east-1', profile)
      const { LocationConstraint } = await probe.send(new GetBucketLocationCommand({ Bucket: bucket }))
      // AWS returns an empty string (not "us-east-1") for buckets in us-east-1.
      bucketRegionCache.set(cacheKey, LocationConstraint || 'us-east-1')
    } catch {
      // Fall back to explicitly configured region or ap-southeast-1.
      bucketRegionCache.set(cacheKey, process.env.AWS_REGION ?? 'ap-southeast-1')
    }
  }
  return s3ForRegion(bucketRegionCache.get(cacheKey)!, profile)
}

interface S3Uri { bucket: string; prefix: string }

function parseS3Uri(uri: string): S3Uri {
  const cleaned = uri.trim().replace(/^s3:\/\//, '')
  const slash = cleaned.indexOf('/')
  if (slash === -1) return { bucket: cleaned, prefix: '' }
  return { bucket: cleaned.slice(0, slash), prefix: cleaned.slice(slash + 1) }
}

async function listCommonPrefixes(bucket: string, prefix: string, profile?: string): Promise<string[]> {
  const client = await s3ForBucket(bucket, profile)
  const cmd = new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, Delimiter: '/' })
  const result = await client.send(cmd)
  return (result.CommonPrefixes ?? []).map(p => p.Prefix!.slice(prefix.length).replace(/\/$/, ''))
}

/**
 * GET /api/aws/profiles
 * Returns named profile IDs from ~/.aws/credentials and ~/.aws/config (never secret values).
 */
app.get('/api/aws/profiles', (_req, res) => {
  try {
    res.json({ profiles: listAwsProfiles() })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * GET /api/s3/dates?uri=s3://bucket/prefix/
 * Three detection strategies (hierarchical → flat folders → flat files).
 */
app.get('/api/s3/dates', async (req, res) => {
  const uri = req.query.uri as string
  const profile = (req.query.profile as string) || undefined
  if (!uri) return res.status(400).json({ error: 'Missing ?uri parameter' })

  const { bucket, prefix: rawPrefix } = parseS3Uri(uri)
  // Strip any trailing date/hour/minute path that the user may have included,
  // e.g. .../2026/04/30/00/00/ → strip back to the base prefix before the year.
  const prefix = rawPrefix.replace(/\d{4}\/\d{2}\/\d{2}(\/\d{2})*(\/\d{2})*\/?$/, '')

  try {
    const topFolders = await listCommonPrefixes(bucket, prefix, profile)

    // Strategy 1: hierarchical year/month/day
    const yearFolders = topFolders.filter(f => /^\d{4}$/.test(f))
    if (yearFolders.length > 0) {
      const dates: string[] = []
      for (const year of yearFolders) {
        const yearPrefix = `${prefix}${year}/`
        const months = (await listCommonPrefixes(bucket, yearPrefix, profile)).filter(m => /^\d{2}$/.test(m))
        for (const month of months) {
          const monthPrefix = `${yearPrefix}${month}/`
          const days = (await listCommonPrefixes(bucket, monthPrefix, profile)).filter(d => /^\d{2}$/.test(d))
          for (const day of days) dates.push(`${year}-${month}-${day}`)
        }
      }
      if (dates.length > 0)
        return res.json({ bucket, prefix, mode: 'hierarchical', dates: dates.sort().reverse() })
    }

    // Strategy 2: flat YYYY-MM-DD folders
    const dateFolders = topFolders.filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f))
    if (dateFolders.length > 0)
      return res.json({ bucket, prefix, mode: 'folders', dates: dateFolders.sort().reverse() })

    // Strategy 3: flat files, extract date from filename
    const allResult = await (await s3ForBucket(bucket, profile)).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }))
    const dateSet = new Set<string>()
    for (const obj of allResult.Contents ?? []) {
      const match = obj.Key!.match(/(\d{4}-\d{2}-\d{2})/)
      if (match) dateSet.add(match[1])
    }
    if (dateSet.size === 0)
      return res.status(404).json({ error: 'No date folders or .gz log files found at this path.' })
    return res.json({ bucket, prefix, mode: 'flat', dates: Array.from(dateSet).sort().reverse() })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * GET /api/s3/hours?bucket=X&prefix=Y&date=YYYY-MM-DD
 * Returns 2-digit hour subfolders (00–23) present under a day prefix.
 * Used by the WAF picker to add hour-level selection for year/month/day/hour/minute paths.
 */
app.get('/api/s3/hours', async (req, res) => {
  const { bucket, prefix, date, profile } = req.query as Record<string, string>
  if (!bucket || !date) return res.status(400).json({ error: 'Missing required parameters' })
  const [year, month, day] = date.split('-')
  const dayPrefix = `${prefix ?? ''}${year}/${month}/${day}/`
  try {
    const hours = (await listCommonPrefixes(bucket, dayPrefix, profile || undefined))
      .filter(h => /^\d{2}$/.test(h))
      .sort()
      .reverse()
    res.json({ hours })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * GET /api/s3/files?bucket=X&prefix=Y&date=YYYY-MM-DD&mode=hierarchical|folders|flat[&hour=HH]
 * Optional ?hour=HH narrows hierarchical mode to a single hour subfolder (WAF logs).
 */
app.get('/api/s3/files', async (req, res) => {
  const { bucket, prefix, date, mode, hour, profile } = req.query as Record<string, string>
  if (!bucket || !date) return res.status(400).json({ error: 'Missing required parameters' })

  let listPrefix: string
  if (mode === 'hierarchical') {
    const [year, month, day] = date.split('-')
    listPrefix = hour
      ? `${prefix}${year}/${month}/${day}/${hour}/`
      : `${prefix}${year}/${month}/${day}/`
  } else if (mode === 'folders') {
    listPrefix = `${prefix}${date}/`
  } else {
    listPrefix = prefix
  }

  try {
    const s3 = await s3ForBucket(bucket, profile || undefined)
    let allObjects: Array<{ key: string; size: number; lastModified: Date | undefined; cached: boolean }> = []
    let continuationToken: string | undefined

    do {
      const result = await s3.send(new ListObjectsV2Command({
        Bucket: bucket, Prefix: listPrefix, ContinuationToken: continuationToken,
      }))
      const page = (result.Contents ?? [])
        .filter(obj => obj.Key!.endsWith('.gz'))
        .filter(obj => mode === 'flat' ? obj.Key!.includes(date) : true)
        .map(obj => ({
          key: obj.Key!, size: obj.Size ?? 0,
          lastModified: obj.LastModified,
          cached: existsSync(cachePath(bucket, obj.Key!)),
        }))
      allObjects = allObjects.concat(page)
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined
    } while (continuationToken)

    allObjects.sort((a, b) => b.key.localeCompare(a.key))
    res.json({ objects: allObjects })
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * POST /api/sessions/s3
 * Body: { bucket: string, keys: string[] }
 *
 * Downloads + caches S3 files, then streams through them to compute initial metrics.
 * No LogRow[] array is ever stored in memory.
 */
app.post('/api/sessions/s3', async (req, res) => {
  const { bucket, keys, profile } = req.body as { bucket: string; keys: string[]; profile?: string }
  if (!bucket || !Array.isArray(keys) || keys.length === 0)
    return res.status(400).json({ error: 'Missing bucket or keys array' })

  try {
    const s3 = await s3ForBucket(bucket, profile)
    let hits = 0, misses = 0
    const filePaths: string[] = []

    for (const key of keys) {
      const p = cachePath(bucket, key)
      if (existsSync(p)) {
        hits++
        console.log(`[cache hit]  ${key}`)
      } else {
        misses++
        console.log(`[s3 fetch]   ${key}`)
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const chunks: Buffer[] = []
        for await (const chunk of result.Body as AsyncIterable<Buffer>) chunks.push(chunk)
        const text = gunzipSync(Buffer.concat(chunks)).toString('utf-8')
        writeCache(bucket, key, text)
        console.log(`[cache save] ${key}`)
      }
      filePaths.push(p)
    }

    const computed = computeFromFilePaths(filePaths, [], null, null, 'all', '', '')
    if (computed.rowCount === 0)
      return res.status(422).json({ error: 'No data rows found in selected files.' })

    const sessionId = randomUUID()
    sessions.set(sessionId, {
      filePaths,
      fileName: `s3://${bucket} (${keys.length} file${keys.length !== 1 ? 's' : ''})`,
      rowCount: computed.rowCount,
      dataMin: computed.dataMin,
      dataMax: computed.dataMax,
      lastAccess: Date.now(),
    })
    console.log(`[session new] ${sessionId}  rows=${computed.rowCount}  hits=${hits}  misses=${misses}`)

    const response: SessionData = {
      sessionId,
      fileName: sessions.get(sessionId)!.fileName,
      rowCount: computed.rowCount,
      dataMin: computed.dataMin,
      dataMax: computed.dataMax,
      tableMetrics: computed.tableMetrics,
      filteredMetrics: computed.filteredMetrics,
      points: computed.points,
      keys: computed.keys,
      cacheStats: { hits, misses },
    }
    res.json(response)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * POST /api/sessions/upload
 * Body: raw file bytes (text/plain or gzip)
 * Header: X-Filename
 *
 * Writes decompressed content to disk cache, then streams it for initial metrics.
 */
app.post('/api/sessions/upload',
  express.raw({ type: '*/*', limit: '500mb' }),
  (req, res) => {
    try {
      const buf = req.body as Buffer
      const isGzip = buf[0] === 0x1f && buf[1] === 0x8b
      const text = isGzip ? gunzipSync(buf).toString('utf-8') : buf.toString('utf-8')

      const sessionId = randomUUID()
      const uploadDir = join(CACHE_DIR, 'uploads')
      mkdirSync(uploadDir, { recursive: true })
      const filePath = join(uploadDir, `${sessionId}.log`)
      writeFileSync(filePath, text, 'utf-8')

      const computed = computeFromFilePaths([filePath], [], null, null, 'all', '', '')
      if (computed.rowCount === 0)
        return res.status(422).json({ error: 'No data rows found in file.' })

      const fileName = (req.headers['x-filename'] as string) || 'uploaded.log'
      sessions.set(sessionId, {
        filePaths: [filePath],
        fileName,
        rowCount: computed.rowCount,
        dataMin: computed.dataMin,
        dataMax: computed.dataMax,
        lastAccess: Date.now(),
      })
      console.log(`[session new] ${sessionId}  rows=${computed.rowCount}  file=${fileName}`)

      const response: SessionData = {
        sessionId, fileName,
        rowCount: computed.rowCount,
        dataMin: computed.dataMin,
        dataMax: computed.dataMax,
        tableMetrics: computed.tableMetrics,
        filteredMetrics: computed.filteredMetrics,
        points: computed.points,
        keys: computed.keys,
      }
      res.json(response)
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  }
)

/**
 * POST /api/sessions/:id/query
 * Body: { dateRangeStart?, dateRangeEnd?, filters, dimension }
 */
/**
 * GET /api/sessions/:id
 * Fetches base session metadata + baseline (unfiltered) metrics — used to
 * resume a session from a shared/bookmarked URL without re-uploading files.
 */
app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found or expired.' })

  session.lastAccess = Date.now()
  const computed = computeFromFilePaths(session.filePaths, [], null, null, 'all', session.dataMin, session.dataMax)

  const response: SessionData = {
    sessionId: req.params.id,
    fileName: session.fileName,
    rowCount: session.rowCount,
    dataMin: session.dataMin,
    dataMax: session.dataMax,
    tableMetrics: computed.tableMetrics,
    filteredMetrics: computed.filteredMetrics,
    points: computed.points,
    keys: computed.keys,
  }
  res.json(response)
})

app.post('/api/sessions/:id/query', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found or expired. Please reload your files.' })

  session.lastAccess = Date.now()

  const { dateRangeStart, dateRangeEnd, filters, dimension } = req.body as {
    dateRangeStart?: string
    dateRangeEnd?: string
    filters: ActiveFilter[]
    dimension: string
  }

  const start = dateRangeStart ? new Date(dateRangeStart) : null
  const end   = dateRangeEnd   ? new Date(dateRangeEnd)   : null

  const computed = computeFromFilePaths(
    session.filePaths,
    filters ?? [],
    start,
    end,
    dimension ?? 'all',
    session.dataMin,
    session.dataMax,
  )

  const result: QueryResult = {
    tableMetrics: computed.tableMetrics,
    filteredMetrics: computed.filteredMetrics,
    points: computed.points,
    keys: computed.keys,
  }
  res.json(result)
})

// ── WAF session endpoints ─────────────────────────────────────────────────────

/**
 * POST /api/waf-sessions/s3
 * Body: { bucket: string, keys: string[] }
 */
app.post('/api/waf-sessions/s3', async (req, res) => {
  const { bucket, keys, profile } = req.body as { bucket: string; keys: string[]; profile?: string }
  if (!bucket || !Array.isArray(keys) || keys.length === 0)
    return res.status(400).json({ error: 'Missing bucket or keys array' })

  try {
    const s3 = await s3ForBucket(bucket, profile)
    let hits = 0, misses = 0
    const filePaths: string[] = []

    for (const key of keys) {
      const p = cachePath(bucket, key)
      if (existsSync(p)) {
        hits++; console.log(`[waf cache hit]  ${key}`)
      } else {
        misses++; console.log(`[waf s3 fetch]   ${key}`)
        const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const chunks: Buffer[] = []
        for await (const chunk of result.Body as AsyncIterable<Buffer>) chunks.push(chunk)
        const text = gunzipSync(Buffer.concat(chunks)).toString('utf-8')
        writeCache(bucket, key, text)
        console.log(`[waf cache save] ${key}`)
      }
      filePaths.push(p)
    }

    const computed = computeWafFromFilePaths(filePaths, [], null, null, 'action', '', '')
    if (computed.rowCount === 0)
      return res.status(422).json({ error: 'No WAF log entries found in selected files.' })

    const sessionId = randomUUID()
    const fileName = `s3://${bucket} (${keys.length} file${keys.length !== 1 ? 's' : ''})`
    wafSessions.set(sessionId, { filePaths, fileName, rowCount: computed.rowCount, dataMin: computed.dataMin, dataMax: computed.dataMax, lastAccess: Date.now() })
    console.log(`[waf session new] ${sessionId}  rows=${computed.rowCount}  hits=${hits}  misses=${misses}`)

    const response: WafSessionData = { sessionId, fileName, rowCount: computed.rowCount, dataMin: computed.dataMin, dataMax: computed.dataMax, tableMetrics: computed.tableMetrics, filteredMetrics: computed.filteredMetrics, points: computed.points, keys: computed.keys, cacheStats: { hits, misses } }
    res.json(response)
  } catch (err: unknown) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
  }
})

/**
 * POST /api/waf-sessions/upload
 * Body: raw file bytes (text or gzip)
 * Header: X-Filename
 */
app.post('/api/waf-sessions/upload',
  express.raw({ type: '*/*', limit: '500mb' }),
  (req, res) => {
    try {
      const buf = req.body as Buffer
      const isGzip = buf[0] === 0x1f && buf[1] === 0x8b
      const text = isGzip ? gunzipSync(buf).toString('utf-8') : buf.toString('utf-8')

      const sessionId = randomUUID()
      const uploadDir = join(CACHE_DIR, 'waf-uploads')
      mkdirSync(uploadDir, { recursive: true })
      const filePath = join(uploadDir, `${sessionId}.log`)
      writeFileSync(filePath, text, 'utf-8')

      const computed = computeWafFromFilePaths([filePath], [], null, null, 'action', '', '')
      if (computed.rowCount === 0)
        return res.status(422).json({ error: 'No WAF log entries found in file.' })

      const fileName = (req.headers['x-filename'] as string) || 'uploaded.log'
      wafSessions.set(sessionId, { filePaths: [filePath], fileName, rowCount: computed.rowCount, dataMin: computed.dataMin, dataMax: computed.dataMax, lastAccess: Date.now() })
      console.log(`[waf session new] ${sessionId}  rows=${computed.rowCount}  file=${fileName}`)

      const response: WafSessionData = { sessionId, fileName, rowCount: computed.rowCount, dataMin: computed.dataMin, dataMax: computed.dataMax, tableMetrics: computed.tableMetrics, filteredMetrics: computed.filteredMetrics, points: computed.points, keys: computed.keys }
      res.json(response)
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    }
  }
)

/**
 * POST /api/waf-sessions/:id/query
 * Body: { dateRangeStart?, dateRangeEnd?, filters, dimension }
 */
/**
 * GET /api/waf-sessions/:id
 * Fetches base WAF session metadata + baseline (unfiltered) metrics — used
 * to resume a session from a shared/bookmarked URL without re-uploading files.
 */
app.get('/api/waf-sessions/:id', (req, res) => {
  const session = wafSessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found or expired.' })

  session.lastAccess = Date.now()
  const computed = computeWafFromFilePaths(session.filePaths, [], null, null, 'action', session.dataMin, session.dataMax)

  const response: WafSessionData = {
    sessionId: req.params.id,
    fileName: session.fileName,
    rowCount: session.rowCount,
    dataMin: session.dataMin,
    dataMax: session.dataMax,
    tableMetrics: computed.tableMetrics,
    filteredMetrics: computed.filteredMetrics,
    points: computed.points,
    keys: computed.keys,
  }
  res.json(response)
})

app.post('/api/waf-sessions/:id/query', (req, res) => {
  const session = wafSessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found or expired. Please reload your files.' })

  session.lastAccess = Date.now()

  const { dateRangeStart, dateRangeEnd, filters, dimension } = req.body as {
    dateRangeStart?: string; dateRangeEnd?: string; filters: ActiveFilter[]; dimension: string
  }

  const computed = computeWafFromFilePaths(
    session.filePaths, filters ?? [],
    dateRangeStart ? new Date(dateRangeStart) : null,
    dateRangeEnd   ? new Date(dateRangeEnd)   : null,
    dimension ?? 'action', session.dataMin, session.dataMax,
  )

  const result: WafQueryResult = { tableMetrics: computed.tableMetrics, filteredMetrics: computed.filteredMetrics, points: computed.points, keys: computed.keys }
  res.json(result)
})

// ── Row-level fetch (CloudFront) ──────────────────────────────────────────────
const CF_ROW_CAP = 10_000

function fetchCfRows(
  filePaths: string[],
  filters: ActiveFilter[],
  dateRangeStart: Date | null,
  dateRangeEnd: Date | null,
  page: number,
  pageSize: number
): RowsResult {
  const minTs = dateRangeStart ? dateRangeStart.getTime() : -Infinity
  const maxTs = dateRangeEnd   ? dateRangeEnd.getTime()   : Infinity

  const cfState = newCfLineState()
  const allRows: CfLogRow[] = []

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue
    const content = readFileSync(filePath, 'utf-8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue

      const get = cfLineGetter(line, cfState)
      if (!get) continue

      const date = get('date'), time = get('time')
      if (!date || date === '-' || !time || time === '-') continue
      const ts = new Date(`${date}T${time}Z`).getTime()
      if (isNaN(ts) || ts < minTs || ts > maxTs) continue

      const country   = get('c-country') || 'Unknown'
      const refHost   = getRefererHost(get('cs(Referer)'))
      const host      = get('cs(Host)') || 'Unknown'
      const path      = get('cs-uri-stem') || '/'
      const rawQuery  = get('cs-uri-query')
      const queryParams = (rawQuery && rawQuery !== '-') ? rawQuery : 'None'
      const fullPath  = queryParams !== 'None' ? `${path}?${queryParams}` : path
      const status    = get('sc-status') || 'Unknown'
      const cache     = get('x-edge-result-type') || 'Unknown'
      const protocol  = get('cs-protocol-version') || 'Unknown'
      const dc        = get('x-edge-location') || 'Unknown'
      const uaStr     = get('cs(User-Agent)')
      const ua        = parseUserAgent(uaStr)
      const decodedUA = decodeUserAgent(uaStr)
      const ip        = get('c-ip') || 'Unknown'
      const method    = get('cs-method') || 'Unknown'
      const bytesRaw  = parseInt(get('sc-bytes'), 10)
      const bytes     = isNaN(bytesRaw) ? 0 : bytesRaw

      let passes = true
      for (const f of filters) {
        let val: string
        if      (f.field === 'referer-host') val = refHost
        else if (f.field === 'browser')      val = ua.browser
        else if (f.field === 'os')           val = ua.os
        else if (f.field === 'device')       val = ua.device
        else if (f.field === 'userAgent')    val = decodedUA
        else if (f.field === 'full-path')    val = fullPath
        else                                 val = get(f.field) || 'Unknown'
        if (!matchesOp(val, f.type, f.value)) { passes = false; break }
      }
      if (!passes) continue

      if (allRows.length < CF_ROW_CAP) {
        allRows.push({ ts, timestamp: `${date} ${time}`, ip, country, method, host, path,
          queryParams, fullPath,
          status, bytes, cacheStatus: cache, refererHost: refHost,
          browser: ua.browser, os: ua.os, device: ua.device, dataCenter: dc, protocol, userAgent: decodedUA })
      }
    }
  }

  allRows.sort((a, b) => b.ts - a.ts)
  const total = allRows.length
  const rows  = allRows.slice(page * pageSize, (page + 1) * pageSize)
  return { rows, total, page, pageSize }
}

/**
 * POST /api/sessions/:id/rows
 * Body: { filters, dateRangeStart?, dateRangeEnd?, page, pageSize }
 */
app.post('/api/sessions/:id/rows', (req, res) => {
  const session = sessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found or expired.' })
  session.lastAccess = Date.now()
  const { filters = [], dateRangeStart, dateRangeEnd, page = 0, pageSize = 10 } = req.body as {
    filters?: ActiveFilter[]; dateRangeStart?: string; dateRangeEnd?: string; page?: number; pageSize?: number
  }
  const result = fetchCfRows(
    session.filePaths, filters,
    dateRangeStart ? new Date(dateRangeStart) : null,
    dateRangeEnd   ? new Date(dateRangeEnd)   : null,
    page, pageSize
  )
  res.json(result)
})

// ── Row-level fetch (WAF) ─────────────────────────────────────────────────────
const WAF_ROW_CAP = 10_000

function fetchWafRows(
  filePaths: string[],
  filters: ActiveFilter[],
  dateRangeStart: Date | null,
  dateRangeEnd: Date | null,
  page: number,
  pageSize: number
): WafRowsResult {
  const minTs = dateRangeStart ? dateRangeStart.getTime() : -Infinity
  const maxTs = dateRangeEnd   ? dateRangeEnd.getTime()   : Infinity
  const allRows: WafLogRow[] = []

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) continue
    const content = readFileSync(filePath, 'utf-8')
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let entry: Record<string, any>
      try { entry = JSON.parse(line) } catch { continue }

      const ts: number = entry.timestamp
      if (!ts || isNaN(ts) || ts < minTs || ts > maxTs) continue

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req: Record<string, any>    = entry.httpRequest ?? {}
      const action: string              = entry.action ?? 'UNKNOWN'
      const terminatingRule: string     = entry.terminatingRuleId ?? 'Unknown'
      const terminatingRuleType: string = entry.terminatingRuleType ?? 'Unknown'
      const country: string             = req.country ?? 'Unknown'
      const clientIp: string            = req.clientIp ?? 'Unknown'
      const uri: string                 = req.uri ?? '/'
      const host: string                = req.host
        ?? (req.headers ?? []).find((h: { name: string }) => h.name === 'host')?.value
        ?? 'Unknown'
      const httpMethod: string  = req.httpMethod ?? 'Unknown'
      const httpVersion: string = req.httpVersion ?? 'Unknown'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const userAgent: string = (req.headers ?? []).find((h: any) => h.name?.toLowerCase() === 'user-agent')?.value ?? 'Unknown'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const labels: string[]       = (entry.labels ?? []).map((l: any) => l.name as string).filter(Boolean)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchedGroups: string[]= (entry.ruleGroupList ?? []).filter((rg: any) =>
        rg.terminatingRule || (rg.nonTerminatingMatchingRules ?? []).length > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ).map((rg: any) => rg.ruleGroupId as string)
      const ja3: string = entry.ja3Fingerprint ?? '-'
      const ja4: string = entry.ja4Fingerprint ?? '-'

      let passes = true
      for (const f of filters) {
        const isLbl = f.field === 'label', isRG = f.field === 'ruleGroup'
        if (isLbl || isRG) {
          if (!arrayMatchesOp(isLbl ? labels : matchedGroups, f.type, f.value)) { passes = false; break }
        } else {
          let val: string
          switch (f.field) {
            case 'action':              val = action; break
            case 'country':             val = country; break
            case 'clientIp':            val = clientIp; break
            case 'uri':                 val = uri; break
            case 'host':                val = host; break
            case 'method':              val = httpMethod; break
            case 'httpVersion':         val = httpVersion; break
            case 'terminatingRule':     val = terminatingRule; break
            case 'terminatingRuleType': val = terminatingRuleType; break
            case 'ja3':                 val = ja3; break
            case 'ja4':                 val = ja4; break
            case 'userAgent':           val = userAgent; break
            default:                    val = 'Unknown'
          }
          if (!matchesOp(val, f.type, f.value)) { passes = false; break }
        }
      }
      if (!passes) continue

      if (allRows.length < WAF_ROW_CAP) {
        const d = new Date(ts)
        allRows.push({
          ts,
          timestamp: d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 19),
          action, clientIp, country, host, uri, method: httpMethod,
          httpVersion, terminatingRule, terminatingRuleType, labels, ja3, ja4, userAgent,
        })
      }
    }
  }

  allRows.sort((a, b) => b.ts - a.ts)
  const total = allRows.length
  const rows  = allRows.slice(page * pageSize, (page + 1) * pageSize)
  return { rows, total, page, pageSize }
}

/**
 * POST /api/waf-sessions/:id/rows
 * Body: { filters, dateRangeStart?, dateRangeEnd?, page, pageSize }
 */
app.post('/api/waf-sessions/:id/rows', (req, res) => {
  const session = wafSessions.get(req.params.id)
  if (!session) return res.status(404).json({ error: 'Session not found or expired.' })
  session.lastAccess = Date.now()
  const { filters = [], dateRangeStart, dateRangeEnd, page = 0, pageSize = 10 } = req.body as {
    filters?: ActiveFilter[]; dateRangeStart?: string; dateRangeEnd?: string; page?: number; pageSize?: number
  }
  const result = fetchWafRows(
    session.filePaths, filters,
    dateRangeStart ? new Date(dateRangeStart) : null,
    dateRangeEnd   ? new Date(dateRangeEnd)   : null,
    page, pageSize
  )
  res.json(result)
})

// ── Static file serving (production) ─────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const distPath = join(process.cwd(), 'dist')
  app.use(express.static(distPath))
  app.get('*', (_req, res) => res.sendFile(join(distPath, 'index.html')))
}

const PORT = parseInt(process.env.PORT ?? '3001', 10)
app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}  (region: ${process.env.AWS_REGION ?? 'ap-southeast-1'})`)
})
