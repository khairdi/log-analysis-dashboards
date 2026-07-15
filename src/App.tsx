import { useEffect, useState } from 'react'
import type { SessionData } from './types'
import type { WafSessionData } from './waf/types'
import FilePicker from './components/FilePicker'
import Dashboard from './components/Dashboard'
import WafFilePicker from './waf/WafFilePicker'
import WafDashboard from './waf/WafDashboard'
import { parseDashboardUrl, clearDashboardUrl } from './lib/urlState'

type AppMode = null | 'cf' | 'waf'

export default function App() {
  const [mode, setMode] = useState<AppMode>(null)
  const [cfSession, setCfSession] = useState<SessionData | null>(null)
  const [wafSession, setWafSession] = useState<WafSessionData | null>(null)
  const [resuming, setResuming] = useState(true)
  const [resumeError, setResumeError] = useState('')

  // On load, a shared/bookmarked URL (?session=...&mode=...) resumes that session directly
  // instead of showing the file picker — as long as it hasn't expired server-side.
  useEffect(() => {
    const url = parseDashboardUrl()
    if (!url.sessionId || !url.mode) { setResuming(false); return }

    const endpoint = url.mode === 'cf' ? `/api/sessions/${url.sessionId}` : `/api/waf-sessions/${url.sessionId}`
    fetch(endpoint)
      .then(r => {
        if (!r.ok) throw new Error('expired')
        return r.json()
      })
      .then(data => {
        if (url.mode === 'cf') setCfSession(data as SessionData)
        else setWafSession(data as WafSessionData)
        setMode(url.mode)
      })
      .catch(() => {
        clearDashboardUrl()
        setResumeError('That shared link has expired or the session is no longer available — please reload your files.')
      })
      .finally(() => setResuming(false))
  }, [])

  if (resuming) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <svg className="animate-spin h-4 w-4 text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          Restoring shared view…
        </div>
      </div>
    )
  }

  if (mode === 'cf') {
    if (!cfSession) return <FilePicker onSession={setCfSession} />
    return <Dashboard session={cfSession} onReset={() => { clearDashboardUrl(); setCfSession(null); setMode(null) }} />
  }

  if (mode === 'waf') {
    if (!wafSession) return <WafFilePicker onSession={setWafSession} />
    return <WafDashboard session={wafSession} onReset={() => { clearDashboardUrl(); setWafSession(null); setMode(null) }} />
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-8">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-light text-gray-800 tracking-tight mb-2">AWS Log Analytics</h1>
          <p className="text-gray-500 text-sm">Choose a log type to analyse</p>
        </div>

        {resumeError && (
          <div className="mb-6 px-4 py-2.5 rounded-lg bg-yellow-50 border border-yellow-200 text-sm text-yellow-800">
            {resumeError}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <button
            onClick={() => setMode('cf')}
            className="bg-white border border-gray-200 rounded-xl shadow-sm p-8 text-left hover:border-orange-300 hover:shadow-md transition-all"
          >
            <div className="w-10 h-10 rounded-full bg-orange-500 flex items-center justify-center text-white font-bold text-sm mb-4">CF</div>
            <div className="text-lg font-semibold text-gray-900 mb-1">CloudFront Analytics</div>
            <p className="text-sm text-gray-500">Analyse CloudFront CDN access logs — traffic, bandwidth, cache performance, top paths and countries.</p>
            <div className="mt-4 text-xs text-gray-400">W3C tab-delimited · .log / .gz</div>
          </button>

          <button
            onClick={() => setMode('waf')}
            className="bg-white border border-gray-200 rounded-xl shadow-sm p-8 text-left hover:border-red-300 hover:shadow-md transition-all"
          >
            <div className="w-10 h-10 rounded-full bg-red-600 flex items-center justify-center text-white font-bold text-sm mb-4">WAF</div>
            <div className="text-lg font-semibold text-gray-900 mb-1">WAF Security Analytics</div>
            <p className="text-sm text-gray-500">Analyse AWS WAF firewall logs — actions, rule matches, blocked IPs, labels and JA3/JA4 fingerprints.</p>
            <div className="mt-4 text-xs text-gray-400">JSON per line · .log / .json / .gz</div>
          </button>
        </div>
      </div>
    </div>
  )
}
