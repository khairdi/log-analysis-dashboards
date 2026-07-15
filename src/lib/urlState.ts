import type { ActiveFilter } from '../types'

export interface DashboardUrlState {
  sessionId: string | null
  mode: 'cf' | 'waf' | null
  filters: ActiveFilter[]
  dimension: string | null
  dateFrom: string | null
  dateTo: string | null
}

/** Reads the current shareable view state (session, mode, filters, dimension, date range) from the URL. */
export function parseDashboardUrl(): DashboardUrlState {
  const params = new URLSearchParams(window.location.search)
  let filters: ActiveFilter[] = []
  const raw = params.get('filters')
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) filters = parsed
    } catch {
      // malformed/tampered filters param — ignore, start with none
    }
  }
  const mode = params.get('mode')
  return {
    sessionId: params.get('session'),
    mode: mode === 'waf' || mode === 'cf' ? mode : null,
    filters,
    dimension: params.get('dimension'),
    dateFrom: params.get('from'),
    dateTo: params.get('to'),
  }
}

/** Writes the current shareable view state to the URL (replaces history entry, no back-button spam). */
export function updateDashboardUrl(state: {
  sessionId: string
  mode: 'cf' | 'waf'
  filters: ActiveFilter[]
  dimension: string
  defaultDimension: string
  dateFrom: string | null
  dateTo: string | null
}): void {
  const params = new URLSearchParams()
  params.set('session', state.sessionId)
  params.set('mode', state.mode)
  if (state.filters.length > 0) params.set('filters', JSON.stringify(state.filters))
  if (state.dimension !== state.defaultDimension) params.set('dimension', state.dimension)
  if (state.dateFrom) params.set('from', state.dateFrom)
  if (state.dateTo) params.set('to', state.dateTo)

  const qs = params.toString()
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  window.history.replaceState(null, '', url)
}

/** Clears all dashboard view-state params from the URL (used on "load another file"). */
export function clearDashboardUrl(): void {
  window.history.replaceState(null, '', window.location.pathname)
}
