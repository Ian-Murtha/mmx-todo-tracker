import type { Entry, TodoList } from './types'

// Resets are calendar-based, in the device's local time zone:
//   daily   -> due at 00:00 on the day after the last reset's local date
//   weekly  -> due at 00:00, 7 days after that date
//   custom  -> due at 00:00, N days after that date
//   monthly -> due at 00:00 on the same day number next month; a shorter month uses its last day
//              (Jan 31 -> Feb 28, or Feb 29 in a leap year)
// A list that missed several cycles still resets once (the check is just "now >= due").

function addDaysLocal(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

function addMonthClamped(d: Date): Date {
  const year = d.getFullYear()
  const nextMonth = d.getMonth() + 1 // 12 rolls over into January of the next year
  const lastDayOfNext = new Date(year, nextMonth + 1, 0).getDate()
  return new Date(year, nextMonth, Math.min(d.getDate(), lastDayOfNext))
}

export function computeNextResetDue(list: TodoList): Date | null {
  if (list.list_type !== 'recurring' || !list.last_reset_at || !list.reset_interval) {
    return null
  }
  const last = new Date(list.last_reset_at)
  if (Number.isNaN(last.getTime())) return null

  switch (list.reset_interval) {
    case 'daily':
      return addDaysLocal(last, 1)
    case 'weekly':
      return addDaysLocal(last, 7)
    case 'monthly':
      return addMonthClamped(last)
    case 'custom':
      return addDaysLocal(last, Math.max(1, Math.floor(Number(list.reset_n_days)) || 1))
    default:
      return null
  }
}

export function isResetDue(list: TodoList, now: Date = new Date()): boolean {
  const due = computeNextResetDue(list)
  return due !== null && now >= due
}

export function performReset(
  list: TodoList,
  entries: Entry[],
  now: Date = new Date()
): {
  updatedList: TodoList
  updatedEntries: Entry[]
  completions: { entry_id: string; done: boolean; recorded_at: string }[]
} {
  const recordedAt = now.toISOString()
  const listEntries = entries.filter((e) => e.list_id === list.id)

  const completions = listEntries.map((e) => ({
    entry_id: e.id,
    done: e.done,
    recorded_at: recordedAt,
  }))

  const updatedEntries = entries.map((e) =>
    e.list_id === list.id ? { ...e, done: false } : e
  )

  const updatedList = { ...list, last_reset_at: recordedAt }

  return { updatedList, updatedEntries, completions }
}

export function describeInterval(list: TodoList): string {
  if (list.list_type !== 'recurring') return ''
  switch (list.reset_interval) {
    case 'daily':
      return 'Resets daily'
    case 'weekly':
      return 'Resets weekly'
    case 'monthly':
      return 'Resets monthly'
    case 'custom':
      return `Resets every ${list.reset_n_days ?? '?'} days`
    default:
      return ''
  }
}
