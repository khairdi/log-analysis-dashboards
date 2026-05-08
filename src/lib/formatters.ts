export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}k`
  return n.toString()
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(2)} GB`
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(2)} MB`
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(2)} KB`
  return `${bytes} B`
}

export function formatDate(dateStr: string, timeStr: string): string {
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
  // Parse as UTC, then display in browser local timezone
  const d = new Date(`${dateStr}T${timeStr}Z`)
  const hh = d.getHours().toString().padStart(2, '0')
  const mm = d.getMinutes().toString().padStart(2, '0')
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()} ${hh}:${mm} (${tz})`
}
