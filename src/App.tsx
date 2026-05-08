import { useState } from 'react'
import type { SessionData } from './types'
import type { WafSessionData } from './waf/types'
import FilePicker from './components/FilePicker'
import Dashboard from './components/Dashboard'
import WafFilePicker from './waf/WafFilePicker'
import WafDashboard from './waf/WafDashboard'

type AppMode = null | 'cf' | 'waf'

export default function App() {
  const [mode, setMode] = useState<AppMode>(null)
  const [cfSession, setCfSession] = useState<SessionData | null>(null)
  const [wafSession, setWafSession] = useState<WafSessionData | null>(null)

  if (mode === 'cf') {
    if (!cfSession) return <FilePicker onSession={setCfSession} />
    return <Dashboard session={cfSession} onReset={() => { setCfSession(null); setMode(null) }} />
  }

  if (mode === 'waf') {
    if (!wafSession) return <WafFilePicker onSession={setWafSession} />
    return <WafDashboard session={wafSession} onReset={() => { setWafSession(null); setMode(null) }} />
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-8">
      <div className="max-w-2xl w-full">
        <div className="text-center mb-10">
          <h1 className="text-3xl font-light text-gray-800 tracking-tight mb-2">AWS Log Analytics</h1>
          <p className="text-gray-500 text-sm">Choose a log type to analyse</p>
        </div>

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
