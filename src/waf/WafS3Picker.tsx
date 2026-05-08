import { useState, useCallback, useRef } from 'react'
import { TIME_RANGE_OPTIONS } from '../lib/metrics'
import type { TimeRange } from '../lib/metrics'
import type { WafSessionData } from './types'

interface FileObject {
  key: string
  size: number
  lastModified?: string
  cached?: boolean
}

interface DateInfo {
  bucket: string
  prefix: string
  mode: 'hierarchical' | 'folders' | 'flat'
  dates: string[]
}

function autoSelectKeys(files: FileObject[], range: TimeRange): string[] {
  if (range === 'all') return files.map(f => f.key)
  const maxTs = files.reduce((max, f) => {
    if (!f.lastModified) return max
    const t = new Date(f.lastModified).getTime()
    return t > max ? t : max
  }, 0)
  const ref = maxTs > 0 ? maxTs : Date.now()
  let minTs: number
  if (range === 'today') {
    const d = new Date(ref)
    minTs = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  } else if (range.endsWith('m')) {
    minTs = ref - parseInt(range) * 60_000
  } else {
    minTs = ref - parseInt(range) * 3_600_000
  }
  const recent = files.filter(f => f.lastModified && new Date(f.lastModified).getTime() >= minTs)
  return recent.length > 0 ? recent.map(f => f.key) : files.slice(0, 1).map(f => f.key)
}

interface Props {
  onSession: (s: WafSessionData) => void
}

function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KB`
  return `${bytes} B`
}

export default function WafS3Picker({ onSession }: Props) {
  const [uri, setUri] = useState('')
  const [browseError, setBrowseError] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [dateInfo, setDateInfo] = useState<DateInfo | null>(null)
  const [selectedDate, setSelectedDate] = useState('')

  // Hour-level selection for WAF year/month/day/hour/minute structure
  const [hours, setHours] = useState<string[]>([])
  const [checkedHours, setCheckedHours] = useState<Set<string>>(new Set())
  const [loadingHours, setLoadingHours] = useState(false)

  const [files, setFiles] = useState<FileObject[]>([])
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [autoSelectRange, setAutoSelectRange] = useState<TimeRange>('1')
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [loadError, setLoadError] = useState('')
  const [cacheStats, setCacheStats] = useState<{ hits: number; misses: number } | null>(null)
  const autoSelectRangeRef = useRef(autoSelectRange)

  // ── File fetching ─────────────────────────────────────────────────────────────

  const fetchFilesForHours = useCallback(async (
    info: DateInfo, date: string, hoursToLoad: Set<string>
  ) => {
    setLoadingFiles(true)
    setFiles([])
    setCheckedKeys(new Set())
    setLoadError('')
    try {
      let objs: FileObject[] = []

      if (hoursToLoad.size === 0) {
        // No hour subfolders — list everything under the date prefix
        const params = new URLSearchParams({ bucket: info.bucket, prefix: info.prefix, date, mode: info.mode })
        const resp = await fetch(`/api/s3/files?${params}`)
        const data = await resp.json()
        if (!resp.ok) throw new Error(data.error ?? resp.statusText)
        objs = data.objects as FileObject[]
      } else {
        // One call per checked hour, merge + deduplicate by key
        const byKey = new Map<string, FileObject>()
        for (const hour of Array.from(hoursToLoad).sort()) {
          const params = new URLSearchParams({ bucket: info.bucket, prefix: info.prefix, date, mode: info.mode, hour })
          const resp = await fetch(`/api/s3/files?${params}`)
          const data = await resp.json()
          if (resp.ok) {
            for (const f of data.objects as FileObject[]) byKey.set(f.key, f)
          }
        }
        objs = Array.from(byKey.values())
      }

      objs.sort((a, b) => b.key.localeCompare(a.key))
      setFiles(objs)
      setCheckedKeys(new Set(autoSelectKeys(objs, autoSelectRangeRef.current)))
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
    setLoadingFiles(false)
  }, [])

  // ── Hour fetching ─────────────────────────────────────────────────────────────

  // Probe for hour subfolders; auto-check latest hour; fall back gracefully
  const loadHoursForDate = useCallback(async (info: DateInfo, date: string) => {
    setLoadingHours(true)
    setHours([])
    setCheckedHours(new Set())
    setFiles([])
    setCheckedKeys(new Set())
    try {
      const params = new URLSearchParams({ bucket: info.bucket, prefix: info.prefix, date })
      const resp = await fetch(`/api/s3/hours?${params}`)
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? resp.statusText)
      const fetchedHours: string[] = data.hours ?? []
      setHours(fetchedHours)
      if (fetchedHours.length > 0) {
        const autoH = new Set([fetchedHours[0]]) // auto-check latest hour
        setCheckedHours(autoH)
        await fetchFilesForHours(info, date, autoH)
      } else {
        await fetchFilesForHours(info, date, new Set())
      }
    } catch {
      // Hour subfolders not found — fall back to listing all files under the date
      await fetchFilesForHours(info, date, new Set())
    }
    setLoadingHours(false)
  }, [fetchFilesForHours])

  // ── Browse ────────────────────────────────────────────────────────────────────

  const handleBrowse = useCallback(async () => {
    if (!uri.trim()) return
    setBrowseError('')
    setDateInfo(null)
    setSelectedDate('')
    setHours([])
    setCheckedHours(new Set())
    setFiles([])
    setCheckedKeys(new Set())
    setLoadError('')
    setBrowsing(true)
    try {
      const resp = await fetch(`/api/s3/dates?uri=${encodeURIComponent(uri.trim())}`)
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? resp.statusText)
      setDateInfo(data)
      const firstDate = data.dates[0]
      setSelectedDate(firstDate)
      if (data.mode === 'hierarchical') {
        await loadHoursForDate(data, firstDate)
      } else {
        await fetchFilesForHours(data, firstDate, new Set())
      }
    } catch (err: unknown) {
      setBrowseError(err instanceof Error ? err.message : String(err))
    }
    setBrowsing(false)
  }, [uri, loadHoursForDate, fetchFilesForHours])

  // ── Interaction ───────────────────────────────────────────────────────────────

  const handleDateSelect = useCallback((date: string) => {
    if (!dateInfo) return
    setSelectedDate(date)
    if (dateInfo.mode === 'hierarchical') {
      loadHoursForDate(dateInfo, date)
    } else {
      fetchFilesForHours(dateInfo, date, new Set())
    }
  }, [dateInfo, loadHoursForDate, fetchFilesForHours])

  const handleHourToggle = async (hour: string) => {
    if (!dateInfo || !selectedDate) return
    const next = new Set(checkedHours)
    next.has(hour) ? next.delete(hour) : next.add(hour)
    setCheckedHours(next)
    await fetchFilesForHours(dateInfo, selectedDate, next)
  }

  const toggleFile = (key: string) => {
    setCheckedKeys(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const toggleAll = () => {
    setCheckedKeys(prev => prev.size === files.length ? new Set() : new Set(files.map(f => f.key)))
  }

  const applyAutoSelect = (range: TimeRange) => {
    autoSelectRangeRef.current = range
    setAutoSelectRange(range)
    if (files.length > 0) setCheckedKeys(new Set(autoSelectKeys(files, range)))
  }

  const selectedFiles = files.filter(f => checkedKeys.has(f.key))
  const selectedBytes = selectedFiles.reduce((s, f) => s + f.size, 0)
  const allChecked = files.length > 0 && checkedKeys.size === files.length
  const someChecked = checkedKeys.size > 0 && checkedKeys.size < files.length
  const hasHours = hours.length > 0

  const handleLoad = useCallback(async () => {
    if (!dateInfo || selectedFiles.length === 0) return
    setLoading(true)
    setLoadError('')
    setCacheStats(null)
    setProgress(`Loading ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}…`)
    try {
      const resp = await fetch('/api/waf-sessions/s3', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bucket: dateInfo.bucket, keys: selectedFiles.map(f => f.key) }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? resp.statusText)
      if (data.cacheStats) setCacheStats(data.cacheStats)
      onSession(data)
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
    setProgress('')
    setLoading(false)
  }, [dateInfo, selectedFiles, onSession])

  return (
    <div className="space-y-4">

      {/* URI input */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1">S3 URI (bucket + prefix)</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={uri}
            onChange={e => setUri(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleBrowse()}
            placeholder="s3://aws-waf-logs-bucket/AWSLogs/…/WAFLogs/…/"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-red-400 focus:ring-1 focus:ring-red-300 font-mono"
          />
          <button
            onClick={handleBrowse}
            disabled={browsing || !uri.trim()}
            className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {browsing ? 'Browsing…' : 'Browse'}
          </button>
        </div>
        {browseError && <p className="mt-1.5 text-xs text-red-600">{browseError}</p>}
        <p className="mt-1 text-xs text-gray-400">
          Credentials from <code className="bg-gray-100 px-1 rounded">~/.aws</code> · region: ap-southeast-1
        </p>
      </div>

      {/* Auto-select time range */}
      <div>
        <label className="block text-xs font-medium text-gray-600 mb-1.5">Auto-select files from</label>
        <div className="flex flex-wrap gap-1">
          {TIME_RANGE_OPTIONS.map(opt => (
            <button
              key={opt.value}
              onClick={() => applyAutoSelect(opt.value as TimeRange)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                autoSelectRange === opt.value
                  ? 'bg-red-600 border-red-600 text-white'
                  : 'bg-white border-gray-300 text-gray-600 hover:border-red-400 hover:text-red-600'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-400">Pre-checks files uploaded within this window. You can still adjust manually.</p>
      </div>

      {/* Date / Hour / Files — 3-column for WAF, 2-column for flat */}
      {dateInfo && (
        <div className="flex gap-3">

          {/* Date column */}
          <div className="w-32 shrink-0">
            <div className="text-xs font-medium text-gray-500 mb-1.5 uppercase tracking-wide">Date</div>
            <div className="border border-gray-200 rounded-lg overflow-hidden overflow-y-auto max-h-64">
              {dateInfo.dates.map((date, i) => (
                <button
                  key={date}
                  onClick={() => handleDateSelect(date)}
                  className={`w-full text-left px-3 py-2 text-xs border-b border-gray-100 last:border-b-0 flex items-center justify-between gap-1 transition-colors ${
                    selectedDate === date ? 'bg-red-50 text-red-800 font-semibold' : 'hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <span>{date}</span>
                  {i === 0 && <span className="text-green-600 font-bold">●</span>}
                </button>
              ))}
            </div>
          </div>

          {/* Hour column — shown only for WAF year/month/day/hour paths */}
          {(loadingHours || hasHours) && (
            <div className="w-24 shrink-0">
              <div className="text-xs font-medium text-gray-500 mb-1.5 uppercase tracking-wide flex items-center gap-1">
                Hour <span className="text-gray-400 font-normal normal-case">(UTC)</span>
                {checkedHours.size > 0 && (
                  <span className="text-red-600 font-semibold">{checkedHours.size}</span>
                )}
              </div>
              {loadingHours ? (
                <div className="border border-gray-200 rounded-lg px-2 py-4 text-xs text-gray-400 text-center">Loading…</div>
              ) : (
                <div className="border border-gray-200 rounded-lg overflow-hidden overflow-y-auto max-h-64">
                  {hours.map(hour => {
                    const isChecked = checkedHours.has(hour)
                    return (
                      <label
                        key={hour}
                        className={`flex items-center gap-1.5 px-2.5 py-2 text-xs border-b border-gray-100 last:border-b-0 cursor-pointer select-none transition-colors ${
                          isChecked ? 'bg-red-50/70 text-red-800 font-medium' : 'hover:bg-gray-50 text-gray-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => handleHourToggle(hour)}
                          className="h-3 w-3 rounded border-gray-300 text-red-600 cursor-pointer shrink-0"
                        />
                        <span className="font-mono">{hour}:00</span>
                      </label>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {/* Files column */}
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-gray-500 mb-1.5 uppercase tracking-wide">
              Files {files.length > 0 && <span className="text-gray-400 font-normal">({files.length})</span>}
            </div>

            {loadingFiles ? (
              <div className="border border-gray-200 rounded-lg px-3 py-4 text-xs text-gray-400 text-center">
                {hasHours && checkedHours.size > 1 ? `Loading ${checkedHours.size} hours…` : 'Loading…'}
              </div>
            ) : hasHours && checkedHours.size === 0 ? (
              <div className="border border-gray-200 rounded-lg px-3 py-4 text-xs text-gray-400 text-center">
                Select one or more hours to see files
              </div>
            ) : files.length === 0 ? (
              <div className="border border-gray-200 rounded-lg px-3 py-4 text-xs text-gray-400 text-center">No .gz files found</div>
            ) : (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                {/* Select-all header */}
                <div className="flex items-center gap-2.5 px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={el => { if (el) el.indeterminate = someChecked }}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-red-600 cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 flex-1">
                    {checkedKeys.size === 0
                      ? 'Select all'
                      : `${checkedKeys.size} of ${files.length} selected · ${formatSize(selectedBytes)}`}
                  </span>
                  {files.some(f => f.cached) && (
                    <button
                      onClick={() => setCheckedKeys(new Set(files.filter(f => f.cached).map(f => f.key)))}
                      className="text-[10px] text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded font-medium hover:bg-green-100 cursor-pointer"
                    >
                      {files.filter(f => f.cached).length} cached
                    </button>
                  )}
                </div>

                {/* File rows */}
                <div className="overflow-y-auto max-h-48">
                  {files.map(f => {
                    const name = f.key.split('/').pop() ?? f.key
                    const checked = checkedKeys.has(f.key)
                    return (
                      <label
                        key={f.key}
                        className={`flex items-center gap-2.5 px-3 py-2 border-b border-gray-50 last:border-b-0 cursor-pointer transition-colors ${checked ? 'bg-red-50/50' : 'hover:bg-gray-50'}`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleFile(f.key)}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-red-600 cursor-pointer shrink-0"
                        />
                        <span className="text-xs font-mono text-gray-700 truncate flex-1" title={f.key}>{name}</span>
                        {f.cached ? (
                          <span className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-50 text-green-700 border border-green-200">
                            <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><polyline points="20 6 9 17 4 12" /></svg>
                            cached
                          </span>
                        ) : (
                          <span className="shrink-0 w-[52px]" />
                        )}
                        <span className="text-xs text-gray-400 shrink-0">{formatSize(f.size)}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {loadError && <p className="text-xs text-red-600">{loadError}</p>}

      {dateInfo && (
        loading ? (
          <div className="flex items-center gap-2 text-sm text-red-600">
            <svg className="animate-spin h-4 w-4 shrink-0" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
            {progress}
          </div>
        ) : (
          <div className="space-y-1.5">
            <button
              onClick={handleLoad}
              disabled={selectedFiles.length === 0}
              className="w-full py-2 bg-red-600 text-white text-sm font-medium rounded-lg hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {selectedFiles.length === 0
                ? 'Select files to load'
                : `Load ${selectedFiles.length} file${selectedFiles.length !== 1 ? 's' : ''} · ${formatSize(selectedBytes)}`}
            </button>
            {cacheStats && (
              <div className="flex items-center gap-2 text-xs text-gray-500 justify-center">
                {cacheStats.hits > 0 && (
                  <span className="inline-flex items-center gap-1 text-green-700 bg-green-50 border border-green-200 px-2 py-0.5 rounded-full">
                    ✓ {cacheStats.hits} from cache
                  </span>
                )}
                {cacheStats.misses > 0 && (
                  <span className="inline-flex items-center gap-1 text-red-700 bg-red-50 border border-red-200 px-2 py-0.5 rounded-full">
                    ↓ {cacheStats.misses} from S3
                  </span>
                )}
              </div>
            )}
          </div>
        )
      )}
    </div>
  )
}
