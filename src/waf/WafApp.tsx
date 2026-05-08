import { useState } from 'react'
import type { WafSessionData } from './types'
import WafFilePicker from './WafFilePicker'
import WafDashboard from './WafDashboard'

export default function WafApp() {
  const [session, setSession] = useState<WafSessionData | null>(null)

  if (!session) {
    return <WafFilePicker onSession={setSession} />
  }

  return <WafDashboard session={session} onReset={() => setSession(null)} />
}
