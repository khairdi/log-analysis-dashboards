import { useState, useRef, useEffect } from 'react'

export interface DateRange {
  start: Date
  end: Date
}

interface Props {
  value: DateRange | null
  dataMin: Date | null
  dataMax: Date | null
  onChange: (range: DateRange | null) => void
}

const PRESETS = [
  { label: 'Last 5 minutes',  minutes: 5 },
  { label: 'Last 10 minutes', minutes: 10 },
  { label: 'Last 15 minutes', minutes: 15 },
  { label: 'Last 30 minutes', minutes: 30 },
  { label: 'Last 1 hour',     minutes: 60 },
  { label: 'Last 2 hours',    minutes: 120 },
  { label: 'Last 3 hours',    minutes: 180 },
  { label: 'Last 6 hours',    minutes: 360 },
  { label: 'Last 12 hours',   minutes: 720 },
]

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function toTimeStr(d: Date) {
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
}

function applyTimeStr(d: Date, timeStr: string): Date {
  const [hh, mm] = timeStr.split(':').map(Number)
  const r = new Date(d)
  r.setHours(isNaN(hh) ? 0 : hh, isNaN(mm) ? 0 : mm, 0, 0)
  return r
}

function formatRangeLabel(range: DateRange | null): string {
  if (!range) return 'All data'
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }
  const fmt = (d: Date) => d.toLocaleString(undefined, opts)
  return `${fmt(range.start)} → ${fmt(range.end)}`
}

interface CalendarProps {
  year: number
  month: number
  selecting: 'start' | 'end'
  startDate: Date | null
  endDate: Date | null
  hoverDate: Date | null
  onDayClick: (d: Date) => void
  onDayHover: (d: Date) => void
}

function Calendar({ year, month, selecting, startDate, endDate, hoverDate, onDayClick, onDayHover }: CalendarProps) {
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December']
  const days = daysInMonth(year, month)
  const firstDow = new Date(year, month, 1).getDay()
  const cells: (number | null)[] = Array(firstDow).fill(null)
  for (let i = 1; i <= days; i++) cells.push(i)

  const rangeEnd = selecting === 'end' && hoverDate ? hoverDate : endDate

  return (
    <div className="select-none">
      <div className="text-xs font-semibold text-gray-700 text-center mb-2">{monthNames[month]} {year}</div>
      <div className="grid grid-cols-7 gap-px text-center mb-1">
        {['Su','Mo','Tu','We','Th','Fr','Sa'].map(d => (
          <div key={d} className="text-[10px] text-gray-400 font-medium py-0.5">{d}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {cells.map((day, i) => {
          if (!day) return <div key={`e-${i}`} />
          const date = new Date(year, month, day)
          const isStart = startDate ? sameDay(date, startDate) : false
          const isEnd = rangeEnd ? sameDay(date, rangeEnd) : false
          const inRange = startDate && rangeEnd
            ? date > startOfDay(startDate) && date < startOfDay(rangeEnd)
            : false
          const isEdge = isStart || isEnd
          return (
            <button
              key={day}
              onClick={() => onDayClick(date)}
              onMouseEnter={() => onDayHover(date)}
              className={`
                relative py-1 text-xs rounded transition-colors
                ${isEdge ? 'bg-blue-600 text-white font-semibold' : ''}
                ${inRange && !isEdge ? 'bg-blue-100 text-blue-800 rounded-none' : ''}
                ${!isEdge && !inRange ? 'text-gray-700 hover:bg-gray-100' : ''}
              `}
            >
              {day}
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default function DateRangePicker({ value, dataMax, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const now = dataMax ?? new Date()

  // Local picker state (not committed until Apply)
  const [startDate, setStartDate] = useState<Date | null>(value?.start ?? null)
  const [endDate, setEndDate] = useState<Date | null>(value?.end ?? null)
  const [startTime, setStartTime] = useState(value ? toTimeStr(value.start) : '00:00')
  const [endTime, setEndTime] = useState(value ? toTimeStr(value.end) : toTimeStr(now))
  const [selecting, setSelecting] = useState<'start' | 'end'>('start')
  const [hoverDate, setHoverDate] = useState<Date | null>(null)

  const [leftYear, setLeftYear] = useState(now.getFullYear())
  const [leftMonth, setLeftMonth] = useState(now.getMonth() === 0 ? 11 : now.getMonth() - 1)
  const [leftYearRef] = useState(() => now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear())

  const rightYear = leftMonth === 11 ? leftYear + 1 : leftYear
  const rightMonth = (leftMonth + 1) % 12

  // Sync left calendar year when month wraps
  useEffect(() => {
    if (leftMonth === 11) setLeftYear(leftYearRef)
  }, [leftMonth, leftYearRef])

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClickOutside)
    return () => document.removeEventListener('mousedown', onClickOutside)
  }, [open])

  function openPicker() {
    // Reset local state from current value
    setStartDate(value?.start ?? null)
    setEndDate(value?.end ?? null)
    setStartTime(value ? toTimeStr(value.start) : '00:00')
    setEndTime(value ? toTimeStr(value.end) : toTimeStr(now))
    setSelecting('start')
    setHoverDate(null)
    setOpen(true)
  }

  function handleDayClick(d: Date) {
    if (selecting === 'start') {
      setStartDate(d)
      setEndDate(null)
      setSelecting('end')
    } else {
      if (startDate && d < startDate) {
        // swap
        setEndDate(startDate)
        setEndTime(startTime)
        setStartDate(d)
        setStartTime('00:00')
        setSelecting('start')
      } else {
        setEndDate(d)
        setSelecting('start')
      }
    }
  }

  function handlePreset(minutes: number) {
    const end = new Date(now)
    const start = new Date(now.getTime() - minutes * 60_000)
    setStartDate(start)
    setEndDate(end)
    setStartTime(toTimeStr(start))
    setEndTime(toTimeStr(end))
    setSelecting('start')
  }

  function handleToday() {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(now)
    setStartDate(start)
    setEndDate(end)
    setStartTime('00:00')
    setEndTime(toTimeStr(end))
    setSelecting('start')
  }

  function handleApply() {
    if (!startDate || !endDate) {
      onChange(null)
    } else {
      onChange({
        start: applyTimeStr(startDate, startTime),
        end: applyTimeStr(endDate, endTime),
      })
    }
    setOpen(false)
  }

  function handleClear() {
    onChange(null)
    setOpen(false)
  }

  function prevMonth() {
    if (leftMonth === 0) { setLeftYear(y => y - 1); setLeftMonth(11) }
    else setLeftMonth(m => m - 1)
  }

  function nextMonth() {
    if (leftMonth === 11) { setLeftYear(y => y + 1); setLeftMonth(0) }
    else setLeftMonth(m => m + 1)
  }

  return (
    <div className="relative" ref={ref}>
      {/* Trigger button */}
      <button
        onClick={openPicker}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 text-xs text-gray-700 font-medium transition-colors shadow-sm"
      >
        <svg className="w-3.5 h-3.5 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
          <line x1="16" y1="2" x2="16" y2="6" />
          <line x1="8" y1="2" x2="8" y2="6" />
          <line x1="3" y1="10" x2="21" y2="10" />
        </svg>
        <span className="max-w-[22rem] truncate">{formatRangeLabel(value)}</span>
        <svg className="w-3 h-3 text-gray-400 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Popover */}
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 bg-white border border-gray-200 rounded-xl shadow-xl flex"
          style={{ minWidth: 680 }}
        >
          {/* Left sidebar: presets */}
          <div className="w-44 border-r border-gray-100 py-3 shrink-0">
            <div className="px-3 mb-2 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Quick select</div>
            {PRESETS.map(p => (
              <button
                key={p.minutes}
                onClick={() => handlePreset(p.minutes)}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors"
              >
                {p.label}
              </button>
            ))}
            <button
              onClick={handleToday}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-700 hover:bg-blue-50 hover:text-blue-700 transition-colors"
            >
              Today
            </button>
            <div className="mx-3 my-2 border-t border-gray-100" />
            <button
              onClick={handleClear}
              className="w-full text-left px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50 hover:text-gray-800 transition-colors"
            >
              All data (no filter)
            </button>
          </div>

          {/* Right: calendar + time inputs */}
          <div className="flex-1 p-4">
            {/* Selection hint */}
            <div className="text-xs text-gray-500 mb-3">
              {selecting === 'start' ? 'Click to select start date' : 'Click to select end date'}
            </div>

            {/* Month nav + calendars */}
            <div className="flex items-start gap-4">
              <button onClick={prevMonth} className="p-1 rounded hover:bg-gray-100 text-gray-500 mt-4 shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M15 18l-6-6 6-6" /></svg>
              </button>
              <div className="flex gap-6 flex-1">
                <div className="flex-1">
                  <Calendar
                    year={leftYear} month={leftMonth}
                    selecting={selecting}
                    startDate={startDate} endDate={endDate} hoverDate={hoverDate}
                    onDayClick={handleDayClick}
                    onDayHover={setHoverDate}
                  />
                </div>
                <div className="flex-1">
                  <Calendar
                    year={rightYear} month={rightMonth}
                    selecting={selecting}
                    startDate={startDate} endDate={endDate} hoverDate={hoverDate}
                    onDayClick={handleDayClick}
                    onDayHover={setHoverDate}
                  />
                </div>
              </div>
              <button onClick={nextMonth} className="p-1 rounded hover:bg-gray-100 text-gray-500 mt-4 shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path d="M9 18l6-6-6-6" /></svg>
              </button>
            </div>

            {/* Time inputs */}
            <div className="mt-4 flex items-center gap-3 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500 font-medium w-10">Start</span>
                <input
                  type="time"
                  value={startTime}
                  onChange={e => setStartTime(e.target.value)}
                  className="border border-gray-300 rounded-md px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-300"
                />
              </div>
              <span className="text-gray-400">→</span>
              <div className="flex items-center gap-1.5">
                <span className="text-gray-500 font-medium w-8">End</span>
                <input
                  type="time"
                  value={endTime}
                  onChange={e => setEndTime(e.target.value)}
                  className="border border-gray-300 rounded-md px-2 py-1 text-xs font-mono focus:outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-300"
                />
              </div>
            </div>

            {/* Selected range preview */}
            {startDate && endDate && (
              <div className="mt-2 text-[10px] text-gray-400">
                {applyTimeStr(startDate, startTime).toLocaleString()} → {applyTimeStr(endDate, endTime).toLocaleString()}
              </div>
            )}

            {/* Actions */}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-800 font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleApply}
                disabled={!startDate || !endDate}
                className="px-4 py-1.5 text-xs bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
