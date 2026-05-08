import { useState, useCallback, useRef } from 'react'
import { TIME_RANGE_OPTIONS } from '../lib/metrics'
import type { TimeRange } from '../lib/metrics'
import type { SessionData } from '../types'

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

  // Use the newest file's lastModified as the reference so that historical
  // dates work correctly (not just "last N hours from right now").
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
  onSession: (s: SessionData) => void
}

function formatSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KB`
  return `${bytes} B`
}

export default function S3Picker({ onSession }: Props) {
  const [uri, setUri] = useState('')
  const [browseError, setBrowseError] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const [dateInfo, setDateInfo] = useState<DateInfo | null>(null)
  const [selectedDate, setSelectedDate] = useState('')
  const [files, setFiles] = useState<FileObject[]>([])
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set())
  const [autoSelectRange, setAutoSelectRange] = useState<TimeRange>('1')
  const [loadingFiles, setLoadingFiles] = useState(false)
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState('')
  const [loadError, setLoadError] = useState('')
  const [cacheStats, setCacheStats] = useState<{ hits: number; misses: number } | null>(null)
  // keep a ref so fetchFiles closure can read the latest range without re-creating the function
  const autoSelectRangeRef = useRef(autoSelectRange)

  const handleBrowse = useCallback(async () => {
    if (!uri.trim()) return
    setBrowseError('')
    setDateInfo(null)
    setSelectedDate('')
    setFiles([])
    setCheckedKeys(new Set())
    setLoadError('')
    setBrowsing(true)
    try {
      const resp = await fetch(`/api/s3/dates?uri=${encodeURIComponent(uri.trim())}`)
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? resp.statusText)
      setDateInfo(data)
      setSelectedDate(data.dates[0])
      // auto-load file list for the latest date
      await fetchFiles(data, data.dates[0])
    } catch (err: unknown) {
      setBrowseError(err instanceof Error ? err.message : String(err))
    }
    setBrowsing(false)
  }, [uri]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchFiles = useCallback(async (info: DateInfo, date: string) => {
    setLoadingFiles(true)
    setFiles([])
    setCheckedKeys(new Set())
    setLoadError('')
    try {
      const params = new URLSearchParams({ bucket: info.bucket, prefix: info.prefix, date, mode: info.mode })
      const resp = await fetch(`/api/s3/files?${params}`)
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? resp.statusText)
      const objs: FileObject[] = data.objects
      setFiles(objs)
      setCheckedKeys(new Set(autoSelectKeys(objs, autoSelectRangeRef.current as TimeRange)))
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
    setLoadingFiles(false)
  }, [])

  const handleDateSelect = useCallback((date: string) => {
    if (!dateInfo) return
    setSelectedDate(date)
    fetchFiles(dateInfo, date)
  }, [dateInfo, fetchFiles])

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

  const selectedFiles = files.filter(f => checkedKeys.has(f.key))
  const selectedBytes = selectedFiles.reduce((s, f) => s + f.size, 0)

  const handleLoad = useCallback(async () => {
    if (!dateInfo || selectedFiles.length === 0) return
    setLoading(true)
    setLoadError('')
    setCacheStats(null)
    setProgress(`Loading ${selectedFiles.length} file${selectedFiles.length > 1 ? 's' : ''}…`)
    try {
      const resp = await fetch('/api/sessions/s3', {
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

  const allChecked = files.length > 0 && checkedKeys.size === files.length
  const someChecked = checkedKeys.size > 0 && checkedKeys.size < files.length

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
            placeholder="s3://my-bucket/AWSLogs/…/CloudFront/…/DistributionId/"
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-300 font-mono"
          />
          <button
            onClick={handleBrowse}
            disabled={browsing || !uri.trim()}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
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
              onClick={() => {
                const v = opt.value as TimeRange
                autoSelectRangeRef.current = v
                setAutoSelectRange(v)
                if (files.length > 0) setCheckedKeys(new Set(autoSelectKeys(files, v)))
              }}
              className={`px-2.5 py-1 text-xs font-medium rounded-md border transition-colors ${
                autoSelectRange === opt.value
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-white border-gray-300 text-gray-600 hover:border-blue-400 hover:text-blue-600'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-gray-400">Pre-checks files uploaded within this window. You can still adjust manually.</p>
      </div>

      {/* Date list + file list side-by-side once dates are loaded */}
      {dateInfo && (
        <div className="flex gap-3">
          {/* Dates */}
          <div className="w-36 shrink-0">
            <div className="text-xs font-medium text-gray-500 mb-1.5 uppercase tracking-wide">Date</div>
            <div className="border border-gray-200 rounded-lg overflow-hidden overflow-y-auto max-h-64">
              {dateInfo.dates.map((date, i) => (
                <button
                  key={date}
                  onClick={() => handleDateSelect(date)}
                  className={`w-full text-left px-3 py-2 text-xs border-b border-gray-100 last:border-b-0 flex items-center justify-between gap-1 transition-colors ${
                    selectedDate === date
                      ? 'bg-blue-50 text-blue-800 font-semibold'
                      : 'hover:bg-gray-50 text-gray-700'
                  }`}
                >
                  <span>{date}</span>
                  {i === 0 && <span className="text-green-600 font-bold">●</span>}
                </button>
              ))}
            </div>
          </div>

          {/* File list with checkboxes */}
          <div className="flex-1 min-w-0">
            <div className="text-xs font-medium text-gray-500 mb-1.5 uppercase tracking-wide">
              Files {files.length > 0 && <span className="text-gray-400 font-normal">({files.length})</span>}
            </div>

            {loadingFiles ? (
              <div className="border border-gray-200 rounded-lg px-3 py-4 text-xs text-gray-400 text-center">
                Loading…
              </div>
            ) : files.length === 0 ? (
              <div className="border border-gray-200 rounded-lg px-3 py-4 text-xs text-gray-400 text-center">
                No .gz files found
              </div>
            ) : (
              <div className="border border-gray-200 rounded-lg overflow-hidden">
                {/* Select all header */}
                <div className="flex items-center gap-2.5 px-3 py-2 bg-gray-50 border-b border-gray-200">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    ref={el => { if (el) el.indeterminate = someChecked }}
                    onChange={toggleAll}
                    className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 cursor-pointer"
                  />
                  <span className="text-xs text-gray-500 flex-1">
                    {checkedKeys.size === 0
                      ? 'Select all'
                      : `${checkedKeys.size} of ${files.length} selected · ${formatSize(selectedBytes)}`}
                  </span>
                  {files.some(f => f.cached) && (
                    <button
                      onClick={() => setCheckedKeys(new Set(files.filter(f => f.cached).map(f => f.key)))}
                      title="Select only cached files"
                      className="text-[10px] text-green-700 bg-green-50 border border-green-200 px-1.5 py-0.5 rounded font-medium hover:bg-green-100 hover:border-green-300 transition-colors cursor-pointer"
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
                        className={`flex items-center gap-2.5 px-3 py-2 border-b border-gray-50 last:border-b-0 cursor-pointer transition-colors ${
                          checked ? 'bg-blue-50/50' : 'hover:bg-gray-50'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleFile(f.key)}
                          className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 cursor-pointer shrink-0"
                        />
                        <span
                          className="text-xs font-mono text-gray-700 truncate flex-1"
                          title={f.key}
                        >
                          {name}
                        </span>
                        {f.cached
                          ? (
                            <span
                              title="Already downloaded — will load from local cache"
                              className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-50 text-green-700 border border-green-200"
                            >
                              <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                              cached
                            </span>
                          )
                          : (
                            <span className="shrink-0 w-[52px]" />
                          )
                        }
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

      {/* Error + Load button */}
      {loadError && <p className="text-xs text-red-600">{loadError}</p>}

      {dateInfo && (
        loading ? (
          <div className="flex items-center gap-2 text-sm text-blue-600">
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
              className="w-full py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
                  <span className="inline-flex items-center gap-1 text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded-full">
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
