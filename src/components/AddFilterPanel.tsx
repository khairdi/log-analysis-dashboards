import { useState, useEffect, useRef } from 'react'
import type { FilterOperator } from '../types'
import { OPERATOR_LABELS } from '../types'

export interface FilterField {
  field: string
  label: string
}

const OPERATORS: FilterOperator[] = [
  'eq', 'neq',
  'contains', 'not_contains',
  'starts_with', 'not_starts_with',
  'ends_with', 'not_ends_with',
  'in', 'not_in',
]

interface Props {
  fields: FilterField[]
  onApply: (field: string, fieldLabel: string, value: string, type: FilterOperator) => void
  onClose: () => void
}

export default function AddFilterPanel({ fields, onApply, onClose }: Props) {
  const [selectedField, setSelectedField] = useState(fields[0]?.field ?? '')
  const [operator, setOperator] = useState<FilterOperator>('eq')
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const fieldDef = fields.find(f => f.field === selectedField)

  const handleApply = () => {
    if (!value.trim() || !selectedField) return
    onApply(selectedField, fieldDef?.label ?? selectedField, value.trim(), operator)
    setValue('')
    onClose()
  }

  return (
    <div className="bg-white border border-gray-200 rounded-xl shadow-xl p-5 w-full">
      <div className="text-sm font-semibold text-gray-700 mb-4">Add filter</div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Field */}
        <select
          value={selectedField}
          onChange={e => setSelectedField(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          {fields.map(f => (
            <option key={f.field} value={f.field}>{f.label}</option>
          ))}
        </select>

        {/* Operator */}
        <select
          value={operator}
          onChange={e => setOperator(e.target.value as FilterOperator)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        >
          {OPERATORS.map(op => (
            <option key={op} value={op}>{OPERATOR_LABELS[op]}</option>
          ))}
        </select>

        {/* Value */}
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') handleApply(); if (e.key === 'Escape') onClose() }}
          placeholder={operator === 'in' || operator === 'not_in' ? 'value1, value2, …' : 'Value…'}
          className="flex-1 min-w-[160px] border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button
          onClick={onClose}
          className="px-4 py-2 text-sm text-gray-600 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleApply}
          disabled={!value.trim()}
          className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-medium"
        >
          Apply
        </button>
      </div>
    </div>
  )
}
