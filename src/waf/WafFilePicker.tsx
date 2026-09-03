import { useCallback, useRef, useState } from 'react'
import type { WafSessionData } from './types'
import { formatBytes } from '../lib/formatters'
import WafS3Picker from './WafS3Picker'

interface Props {
  onSession: (s: WafSessionData) => void
}

type Tab = 'local' | 's3'

/** Same file dropped/picked twice should only be staged once. */
function fileKey(f: File): string {
  return `${f.name}|${f.size}|${f.lastModified}`
}

export default function WafFilePicker({ onSession }: Props) {
  const [tab, setTab] = useState<Tab>('local')
  const [files, setFiles] = useState<File[]>([])
  const [loading, setLoading] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback((list: FileList | null) => {
    if (!list || list.length === 0) return
    // Snapshot now — the caller resets the input's value, which empties its FileList
    const incoming = Array.from(list)
    setError('')
    setFiles(prev => {
      const seen = new Set(prev.map(fileKey))
      return [...prev, ...incoming.filter(f => !seen.has(fileKey(f)))]
    })
  }, [])

  const removeFile = useCallback((key: string) => {
    setFiles(prev => prev.filter(f => fileKey(f) !== key))
  }, [])

  // Files are uploaded one at a time: the server buffers each whole body in
  // memory, and sequential uploads give an honest progress count.
  const analyze = useCallback(async () => {
    if (files.length === 0) return
    setLoading(true)
    setError('')
    setProgress({ done: 0, total: files.length })
    try {
      const uploadIds: string[] = []
      for (const file of files) {
        const resp = await fetch('/api/waf-sessions/uploads', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': file.name,
          },
          body: file,
        })
        const data = await resp.json()
        if (!resp.ok) throw new Error(`${file.name}: ${data.error ?? resp.statusText}`)
        uploadIds.push(data.uploadId as string)
        setProgress(p => ({ ...p, done: p.done + 1 }))
      }

      const fileName = files.length === 1
        ? files[0].name
        : `${files[0].name} + ${files.length - 1} more`

      const resp = await fetch('/api/waf-sessions/from-uploads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadIds, fileName }),
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? resp.statusText)
      onSession(data as WafSessionData)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [files, onSession])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    addFiles(e.dataTransfer.files)
  }, [addFiles])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files)
    e.target.value = ''  // allow re-picking the same file after a removal
  }, [addFiles])

  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-8">
      <div className="max-w-xl w-full">
        <div className="mb-6 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-red-600 flex items-center justify-center text-white font-bold text-xs">WAF</div>
            <span className="text-2xl font-light text-gray-800 tracking-tight">WAF Security Analytics</span>
          </div>
          <p className="text-gray-500 text-sm">Load AWS WAF log files to visualise security analytics</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="flex border-b border-gray-200">
            {(['local', 's3'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                  tab === t
                    ? 'text-red-600 border-b-2 border-red-600 -mb-px'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t === 'local' ? 'Local files' : 'AWS S3'}
              </button>
            ))}
          </div>

          <div className="p-6">
            {tab === 'local' ? (
              <>
                <div
                  className={`border-2 border-dashed rounded-lg text-center transition-all ${
                    files.length > 0 ? 'p-6' : 'p-12'
                  } ${
                    loading
                      ? 'border-red-300 bg-red-50 cursor-wait'
                      : 'border-gray-300 hover:border-red-400 hover:bg-gray-50 cursor-pointer'
                  }`}
                  onDrop={!loading ? handleDrop : undefined}
                  onDragOver={e => e.preventDefault()}
                  onClick={!loading ? () => inputRef.current?.click() : undefined}
                >
                  {loading ? (
                    <>
                      <svg className="animate-spin h-8 w-8 mx-auto mb-2 text-red-400" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      <div className="text-gray-500 text-sm">
                        {progress.done < progress.total
                          ? `Uploading ${progress.done + 1} of ${progress.total}…`
                          : 'Parsing and computing metrics…'}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="text-gray-300 mb-3">
                        <svg className="h-10 w-10 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>
                      </div>
                      <div className="text-gray-700 font-medium mb-1">
                        {files.length > 0 ? 'Drop more WAF log files here' : 'Drop WAF log files here'}
                      </div>
                      <div className="text-gray-400 text-sm">or click to browse</div>
                      <div className="mt-3 text-xs text-gray-400">AWS WAF JSON logs · .log / .json / .gz · multiple files supported</div>
                    </>
                  )}
                </div>

                {files.length > 0 && (
                  <div className="mt-4">
                    <div className="flex items-center justify-between mb-2 text-xs text-gray-500">
                      <span>{files.length} file{files.length !== 1 ? 's' : ''} selected · {formatBytes(totalBytes)}</span>
                      {!loading && (
                        <button onClick={() => setFiles([])} className="text-gray-400 hover:text-red-600">
                          Clear all
                        </button>
                      )}
                    </div>
                    <div className="max-h-48 overflow-y-auto border border-gray-200 rounded-lg divide-y divide-gray-100">
                      {files.map(f => (
                        <div key={fileKey(f)} className="flex items-center gap-2 px-3 py-2 text-sm">
                          <span className="flex-1 truncate text-gray-700" title={f.name}>{f.name}</span>
                          <span className="text-xs text-gray-400 shrink-0">{formatBytes(f.size)}</span>
                          {!loading && (
                            <button
                              onClick={() => removeFile(fileKey(f))}
                              className="text-gray-300 hover:text-red-600 shrink-0"
                              title="Remove"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={analyze}
                      disabled={loading}
                      className="mt-3 w-full py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700 disabled:bg-gray-300"
                    >
                      {loading ? 'Loading…' : `Analyze ${files.length} file${files.length !== 1 ? 's' : ''}`}
                    </button>
                  </div>
                )}

                {error && (
                  <div className="mt-3 px-4 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <input ref={inputRef} type="file" multiple accept=".log,.json,.txt,.gz" className="hidden" onChange={handleChange} />
              </>
            ) : (
              <WafS3Picker onSession={onSession} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
