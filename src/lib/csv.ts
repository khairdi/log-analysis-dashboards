import type { MetricEntry } from '../types'

const MAX_EXPORT_ROWS = 500

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function downloadCsv(filename: string, rows: string[][]): void {
  const csv = rows.map(r => r.map(csvCell).join(',')).join('\r\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

function slugify(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
}

/** Exports up to the top 500 rows of a metric breakdown (value/count/percentage) as CSV. */
export function exportMetricEntriesCsv(title: string, valueHeader: string, entries: MetricEntry[]): void {
  const rows: string[][] = [[valueHeader, 'Count', 'Percentage']]
  for (const e of entries.slice(0, MAX_EXPORT_ROWS)) {
    rows.push([e.value, String(e.count), `${e.percentage.toFixed(2)}%`])
  }
  downloadCsv(`${slugify(title)}.csv`, rows)
}
