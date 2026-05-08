import { useCallback, useRef, useState } from 'react'
import type { SessionData } from '../types'
import S3Picker from './S3Picker'

interface Props {
  onSession: (s: SessionData) => void
}

type Tab = 'local' | 's3'

export default function FilePicker({ onSession }: Props) {
  const [tab, setTab] = useState<Tab>('local')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const uploadFile = useCallback(async (file: File) => {
    setLoading(true)
    setError('')
    try {
      const resp = await fetch('/api/sessions/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': file.name,
        },
        body: file,
      })
      const data = await resp.json()
      if (!resp.ok) throw new Error(data.error ?? resp.statusText)
      onSession(data as SessionData)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err))
    }
    setLoading(false)
  }, [onSession])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const file = e.dataTransfer.files[0]
    if (file) uploadFile(file)
  }, [uploadFile])

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) uploadFile(file)
  }, [uploadFile])

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-8">
      <div className="max-w-xl w-full">
        <div className="mb-6 text-center">
          <div className="flex items-center justify-center gap-2 mb-2">
            <div className="w-8 h-8 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold text-xs">CF</div>
            <span className="text-2xl font-light text-gray-800 tracking-tight">CloudFront Analytics</span>
          </div>
          <p className="text-gray-500 text-sm">Load a CloudFront access log to visualise traffic analytics</p>
        </div>

        <div className="bg-white border border-gray-200 rounded-xl shadow-sm overflow-hidden">
          <div className="flex border-b border-gray-200">
            {(['local', 's3'] as Tab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                  tab === t
                    ? 'text-blue-600 border-b-2 border-blue-600 -mb-px'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {t === 'local' ? 'Local file' : 'AWS S3'}
              </button>
            ))}
          </div>

          <div className="p-6">
            {tab === 'local' ? (
              <>
                <div
                  className={`border-2 border-dashed rounded-lg p-12 text-center cursor-pointer transition-all ${
                    loading
                      ? 'border-blue-300 bg-blue-50 cursor-wait'
                      : 'border-gray-300 hover:border-blue-400 hover:bg-gray-50'
                  }`}
                  onDrop={!loading ? handleDrop : undefined}
                  onDragOver={e => e.preventDefault()}
                  onClick={!loading ? () => inputRef.current?.click() : undefined}
                >
                  {loading ? (
                    <>
                      <svg className="animate-spin h-8 w-8 mx-auto mb-2 text-blue-400" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      <div className="text-gray-500 text-sm">Uploading and parsing…</div>
                    </>
                  ) : (
                    <>
                      <div className="text-gray-300 mb-3">
                        <svg className="h-10 w-10 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>
                      </div>
                      <div className="text-gray-700 font-medium mb-1">Drop a log file here</div>
                      <div className="text-gray-400 text-sm">or click to browse</div>
                      <div className="mt-3 text-xs text-gray-400">CloudFront W3C access log · .log / .gz</div>
                    </>
                  )}
                </div>

                {error && (
                  <div className="mt-3 px-4 py-2.5 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
                    {error}
                  </div>
                )}

                <input ref={inputRef} type="file" accept=".log,.txt,.gz" className="hidden" onChange={handleChange} />
              </>
            ) : (
              <S3Picker onSession={onSession} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
