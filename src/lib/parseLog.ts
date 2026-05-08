import type { ParsedLog, LogRow } from '../types'

export function parseLog(content: string): ParsedLog {
  const lines = content.split('\n')
  let version = ''
  let fields: string[] = []
  const rows: LogRow[] = []

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    if (trimmed.startsWith('#Version:')) {
      version = trimmed.slice('#Version:'.length).trim()
    } else if (trimmed.startsWith('#Fields:') && fields.length === 0) {
      fields = trimmed.slice('#Fields:'.length).trim().split('\t')
    } else if (!trimmed.startsWith('#') && fields.length > 0) {
      const values = trimmed.split('\t')
      const row: LogRow = {}
      fields.forEach((field, i) => {
        row[field] = values[i] ?? '-'
      })
      rows.push(row)
    }
  }

  return { version, fields, rows }
}
