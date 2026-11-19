import { useEffect, useRef, useState } from 'react'
import { supabase } from './supabaseClient'
import ListSidebar from './components/ListSidebar'
import ListView from './components/ListView'
import {
  toggleWithCascade,
  moveEntry as moveEntryInTree,
  filterOutSubtree as filterOutEntrySubtree,
} from './entryTree'
import {
  moveList as moveListInTree,
  filterOutSubtree as filterOutListSubtree,
  getDescendantIds as getListDescendantIds,
  type DropZone,
} from './listTree'
import { nextPosition } from './tree'
import { isResetDue, performReset } from './resetEngine'
import type { Entry, EntryCompletion, TodoList } from './types'

const PAGE_SIZE = 1000 // Supabase returns at most 1,000 rows per request, so big reads are paged
const HISTORY_CYCLES = 14 // reset columns the History grid shows
const ID_CHUNK = 50 // ids per `.in(...)` filter, to keep request URLs short

const SAVE_FAILED = "Couldn't save. Try again."
const LOAD_FAILED = "Couldn't load. Try again."
const SIGNED_OUT = 'Signed out. Log in from MMX Settings.'

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

// A write counts as saved only if the server reports the expected number of changed rows.
// (With row-level security and no session, an update succeeds but changes zero rows.)
function saved(res: { data: unknown; error: unknown }, expected = 1): boolean {
  return !res.error && Array.isArray(res.data) && res.data.length === expected
}

// Every row of a table, paged. Order has tie-breakers so paging and reloads are stable.
async function fetchAllRows<T>(table: 'todo_lists' | 'todo_entries'): Promise<{ data: T[]; ok: boolean }> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order('position', { ascending: true })
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) {
      console.error(`Loading ${table} failed:`, error)
      return { data: out, ok: false }
    }
    out.push(...((data ?? []) as T[]))
    if (!data || data.length < PAGE_SIZE) break
  }
  return { data: out, ok: true }
}

// The newest HISTORY_CYCLES reset batches for these entries (newest first, so old rows can never
// crowd out new ones). Rows of one reset share the same recorded_at.
async function fetchHistory(entryIds: string[]): Promise<{ rows: EntryCompletion[]; ok: boolean }> {
  const all: EntryCompletion[] = []
  for (const ids of chunk(entryIds, ID_CHUNK)) {
    const seen = new Set<string>()
    const kept: EntryCompletion[] = []
    scan: for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('todo_entry_completions')
        .select('*')
        .in('entry_id', ids)
        .order('recorded_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + PAGE_SIZE - 1)
      if (error) {
        console.error('Loading history failed:', error)
        return { rows: [], ok: false }
      }
      for (const row of (data ?? []) as EntryCompletion[]) {
        if (!seen.has(row.recorded_at)) {
          if (seen.size >= HISTORY_CYCLES) break scan
          seen.add(row.recorded_at)
        }
        kept.push(row)
      }
      if (!data || data.length < PAGE_SIZE) break
    }
    all.push(...kept)
  }
  return { rows: all, ok: true }
}

type ResetOutcome = 'done' | 'partial' | 'skipped' | 'failed'

// When another device claimed a reset first it is still writing its history and clearing the checks, so
// give it a moment before reading the result back.
const SKIPPED_RESET_SETTLE_MS = 1500
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Resets one list on the server, in an order that cannot lose a cycle or log it twice:
//  1. claim the reset by moving last_reset_at, but only if it still has the value we read. If another
//     device got there first, no row changes and we skip (so two devices never both log a cycle).
//  2. write the history rows. If that fails, give the claim back so the cycle is retried later.
//  3. clear the checks. If that fails, keep the history (it is correct) and report it.
async function resetListOnServer(
  list: TodoList,
  entries: Entry[],
  now: Date
): Promise<{ outcome: ResetOutcome; updatedList: TodoList; clearedIds: string[] }> {
  const { updatedList, completions } = performReset(list, entries, now)
  const oldStamp = list.last_reset_at
  const newStamp = updatedList.last_reset_at
  const none: string[] = []

  let claimQuery = supabase.from('todo_lists').update({ last_reset_at: newStamp }).eq('id', list.id)
  claimQuery = oldStamp === null ? claimQuery.is('last_reset_at', null) : claimQuery.eq('last_reset_at', oldStamp)
  const claim = await claimQuery.select('id')
  if (claim.error) {
    console.error('Reset claim failed:', claim.error)
    return { outcome: 'failed', updatedList, clearedIds: none }
  }
  if (!claim.data || claim.data.length === 0) return { outcome: 'skipped', updatedList, clearedIds: none }

  const giveBackClaim = async () => {
    const res = await supabase
      .from('todo_lists')
      .update({ last_reset_at: oldStamp })
      .eq('id', list.id)
      .eq('last_reset_at', newStamp)
    if (res.error) console.error('Could not give back the reset claim:', res.error)
  }

  if (completions.length > 0) {
    const ins = await supabase.from('todo_entry_completions').insert(completions).select('id')
    if (ins.error || !Array.isArray(ins.data) || ins.data.length !== completions.length) {
      console.error('Writing history failed:', ins.error)
      if (!ins.error && Array.isArray(ins.data) && ins.data.length > 0) {
        await supabase.from('todo_entry_completions').delete().in('id', ins.data.map((r: { id: string }) => r.id))
      }
      await giveBackClaim()
      return { outcome: 'failed', updatedList: list, clearedIds: none }
    }
  }

  const doneIds = entries.filter((e) => e.list_id === list.id && e.done).map((e) => e.id)
  const clearedIds: string[] = []
  for (const ids of chunk(doneIds, ID_CHUNK)) {
    const clr = await supabase.from('todo_entries').update({ done: false }).in('id', ids).select('id')
    if (!saved(clr, ids.length)) {
      console.error('Clearing checks failed:', clr.error)
      return { outcome: 'partial', updatedList, clearedIds }
    }
    clearedIds.push(...ids)
  }
  return { outcome: 'done', updatedList, clearedIds }
}

export default function App() {
  const [lists, setLists] = useState<TodoList[]>([])
  const [entries, setEntries] = useState<Entry[]>([])
  const [history, setHistory] = useState<{ listId: string; rows: EntryCompletion[] } | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [selectedListId, setSelectedListId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [signedOut, setSignedOut] = useState(false)

  const entriesRef = useRef<Entry[]>([])
  entriesRef.current = entries
  const signedOutRef = useRef(false)
  const resetBusyRef = useRef(false)

  // A failed write shows plain words (the server's text goes to the console). When the login is gone the
  // permanent "Signed out" banner already says why, so no second message.
  const fail = (raw?: unknown) => {
    if (raw) console.error('Save failed:', raw)
    if (!signedOutRef.current) setError(SAVE_FAILED)
  }

  // Watch the login: edits against a signed-out session change nothing and give no error.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        signedOutRef.current = true
        setSignedOut(true)
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
        signedOutRef.current = false
        setSignedOut(false)
      }
    })
    return () => data.subscription.unsubscribe()
  }, [])

  // Load everything on mount, running any due resets along the way.
  useEffect(() => {
    const loadAll = async () => {
      const [listsRes, entriesRes] = await Promise.all([
        fetchAllRows<TodoList>('todo_lists'),
        fetchAllRows<Entry>('todo_entries'),
      ])
      const loadedOk = listsRes.ok && entriesRes.ok
      if (!loadedOk) setError(LOAD_FAILED)

      let currentLists = listsRes.data
      let currentEntries = entriesRes.data

      // Resets only run on a complete, successful load: with part of the data missing they would
      // clear checks and log history from a wrong picture.
      if (loadedOk) {
        const now = new Date()
        const dueLists = currentLists.filter((l) => isResetDue(l, now))
        let skipped = false
        let failed = false
        for (const list of dueLists) {
          const result = await resetListOnServer(list, currentEntries, now)
          if (result.outcome === 'skipped') {
            skipped = true
            continue
          }
          if (result.outcome === 'failed') {
            failed = true
            continue
          }
          if (result.outcome === 'partial') failed = true
          const cleared = new Set(result.clearedIds)
          currentLists = currentLists.map((l) => (l.id === list.id ? result.updatedList : l))
          currentEntries = currentEntries.map((e) => (cleared.has(e.id) ? { ...e, done: false } : e))
        }
        if (skipped) {
          // Another device reset a list first; take its result instead of our older copy.
          await sleep(SKIPPED_RESET_SETTLE_MS)
          const [l2, e2] = await Promise.all([
            fetchAllRows<TodoList>('todo_lists'),
            fetchAllRows<Entry>('todo_entries'),
          ])
          if (l2.ok && e2.ok) {
            currentLists = l2.data
            currentEntries = e2.data
          }
        }
        if (failed) setError(SAVE_FAILED)
      }

      setLists(currentLists)
      setEntries(currentEntries)
      if (currentLists.length > 0) {
        const firstTopLevel = currentLists.find((l) => !l.parent_list_id) ?? currentLists[0]
        setSelectedListId(firstTopLevel.id)
      }
      setLoading(false)
    }
    loadAll()
  }, [])

  // History: load when the selected list changes or after a reset, not on every entry change. A response
  // for a list that is no longer selected is ignored.
  const selectedList = lists.find((l) => l.id === selectedListId) ?? null
  const selectedIsRecurring = selectedList?.list_type === 'recurring'
  useEffect(() => {
    if (loading || !selectedListId || !selectedIsRecurring) return
    const entryIds = entriesRef.current.filter((e) => e.list_id === selectedListId).map((e) => e.id)
    if (entryIds.length === 0) return
    let cancelled = false
    fetchHistory(entryIds).then(({ rows, ok }) => {
      if (cancelled) return
      if (!ok) setError(LOAD_FAILED)
      else setHistory({ listId: selectedListId, rows })
    })
    return () => {
      cancelled = true
    }
  }, [loading, selectedListId, selectedIsRecurring, historyVersion])
  const completions = history && history.listId === selectedListId ? history.rows : []

  // --- Lists ---------------------------------------------------------

  const createList = async (title: string, parentId: string | null = null) => {
    const position = nextPosition(lists.filter((l) => l.parent_list_id === parentId))
    const { data, error } = await supabase
      .from('todo_lists')
      .insert({ title, parent_list_id: parentId, position })
      .select()
      .single()

    if (error) return fail(error)
    if (data) {
      setLists((prev) => [...prev, data])
      setSelectedListId(data.id)
    }
  }

  const renameList = async (id: string, title: string) => {
    const res = await supabase.from('todo_lists').update({ title }).eq('id', id).select('id')
    if (!saved(res)) return fail(res.error)
    setLists((prev) => prev.map((l) => (l.id === id ? { ...l, title } : l)))
  }

  const deleteList = async (id: string) => {
    const removedIds = getListDescendantIds(lists, id)
    removedIds.add(id)

    // The database cascades to sub-lists, their entries and history (checked Nov 19, 2026).
    const res = await supabase.from('todo_lists').delete().eq('id', id).select('id')
    if (!saved(res)) return fail(res.error)

    setLists((prev) => filterOutListSubtree(prev, id))
    setEntries((prev) => prev.filter((e) => !removedIds.has(e.list_id)))

    if (selectedListId && removedIds.has(selectedListId)) {
      const remaining = lists.filter((l) => !removedIds.has(l.id))
      setSelectedListId(remaining[0]?.id ?? null)
    }
  }

  const toggleListCollapsed = async (id: string, collapsed: boolean) => {
    const res = await supabase.from('todo_lists').update({ collapsed }).eq('id', id).select('id')
    if (!saved(res)) return fail(res.error)
    setLists((prev) => prev.map((l) => (l.id === id ? { ...l, collapsed } : l)))
  }

  const moveList = async (draggedId: string, overId: string, zone: DropZone) => {
    const result = moveListInTree(lists, draggedId, overId, zone)
    if (!result) return
    const before = lists
    const fields: (keyof TodoList)[] = ['parent_list_id', 'position', 'collapsed']
    setLists(result.lists)
    const failedIds = await persistListChanges(result.lists, result.changedIds, fields)
    if (failedIds.length > 0) {
      const failedSet = new Set(failedIds)
      const old = new Map(before.map((l) => [l.id, l]))
      setLists((prev) =>
        prev.map((l) => {
          if (!failedSet.has(l.id)) return l
          const restored = { ...l }
          for (const f of fields) (restored as Record<string, unknown>)[f] = old.get(l.id)![f]
          return restored
        })
      )
      fail()
    }
  }

  // Returns true if saved; on failure the screen keeps the old value and a message is shown.
  const updateListSettings = async (id: string, patch: Partial<TodoList>): Promise<boolean> => {
    const res = await supabase.from('todo_lists').update(patch).eq('id', id).select('id')
    if (!saved(res)) {
      fail(res.error)
      return false
    }
    setLists((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
    return true
  }

  const manualReset = async (list: TodoList) => {
    if (resetBusyRef.current) return
    resetBusyRef.current = true
    try {
      const result = await resetListOnServer(list, entriesRef.current, new Date())
      if (result.outcome === 'skipped') {
        // Our copy of the list was out of date (another device reset it). Show what is saved.
        await sleep(SKIPPED_RESET_SETTLE_MS)
        const [l2, e2] = await Promise.all([
          fetchAllRows<TodoList>('todo_lists'),
          fetchAllRows<Entry>('todo_entries'),
        ])
        if (l2.ok && e2.ok) {
          setLists(l2.data)
          setEntries(e2.data)
          setHistoryVersion((v) => v + 1)
        }
        setError('This list was already reset on another device.')
        return
      }
      if (result.outcome === 'failed') return fail()
      const cleared = new Set(result.clearedIds)
      setLists((prev) => prev.map((l) => (l.id === list.id ? result.updatedList : l)))
      setEntries((prev) => prev.map((e) => (cleared.has(e.id) ? { ...e, done: false } : e)))
      setHistoryVersion((v) => v + 1)
      if (result.outcome === 'partial') setError("Couldn't clear every check. Untick the rest or try again.")
    } finally {
      resetBusyRef.current = false
    }
  }

  // Saves each changed row; returns the ids that did not save.
  const persistListChanges = async (
    updated: TodoList[],
    changedIds: string[],
    fields: (keyof TodoList)[]
  ): Promise<string[]> => {
    if (changedIds.length === 0) return []
    const byId = new Map(updated.map((l) => [l.id, l]))
    const results = await Promise.all(
      changedIds.map(async (id) => {
        const list = byId.get(id)!
        const patch: Record<string, unknown> = {}
        for (const field of fields) patch[field] = list[field]
        const res = await supabase.from('todo_lists').update(patch).eq('id', id).select('id')
        if (res.error) console.error('Saving list change failed:', res.error)
        return saved(res) ? null : id
      })
    )
    return results.filter((id): id is string => id !== null)
  }

  // --- Entries ---------------------------------------------------------

  const addEntry = async (content: string, parentId: string | null = null) => {
    if (!selectedListId) return
    const position = nextPosition(
      entries.filter((e) => e.list_id === selectedListId && e.parent_entry_id === parentId)
    )
    const { data, error } = await supabase
      .from('todo_entries')
      .insert({
        list_id: selectedListId,
        parent_entry_id: parentId,
        content,
        position,
      })
      .select()
      .single()

    if (error) return fail(error)
    if (data) setEntries((prev) => [...prev, data])
  }

  const toggleEntry = async (id: string, done: boolean) => {
    const before = entries
    const { entries: updated, changedIds } = toggleWithCascade(entries, id, done)
    setEntries(updated)
    const failedIds = await persistEntryChanges(updated, changedIds, ['done'])
    if (failedIds.length > 0) {
      revertEntries(before, failedIds, ['done'])
      fail()
    }
  }

  // Returns true if saved, so the text box can put the old text back when it was not.
  const editEntry = async (id: string, content: string): Promise<boolean> => {
    const res = await supabase.from('todo_entries').update({ content }).eq('id', id).select('id')
    if (!saved(res)) {
      fail(res.error)
      return false
    }
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, content } : e)))
    return true
  }

  const deleteEntry = async (id: string) => {
    // The database cascades to sub-items and history (checked Nov 19, 2026).
    const res = await supabase.from('todo_entries').delete().eq('id', id).select('id')
    if (!saved(res)) return fail(res.error)
    setEntries((prev) => filterOutEntrySubtree(prev, id))
  }

  const toggleEntryCollapsed = async (id: string, collapsed: boolean) => {
    const res = await supabase.from('todo_entries').update({ collapsed }).eq('id', id).select('id')
    if (!saved(res)) return fail(res.error)
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, collapsed } : e)))
  }

  const moveEntry = async (draggedId: string, overId: string, zone: DropZone) => {
    const result = moveEntryInTree(entries, draggedId, overId, zone)
    if (!result) return
    const before = entries
    const fields: (keyof Entry)[] = ['parent_entry_id', 'position', 'collapsed']
    setEntries(result.entries)
    const failedIds = await persistEntryChanges(result.entries, result.changedIds, fields)
    if (failedIds.length > 0) {
      revertEntries(before, failedIds, fields)
      fail()
    }
  }

  // Puts the given fields of the given entries back to their earlier values.
  const revertEntries = (before: Entry[], ids: string[], fields: (keyof Entry)[]) => {
    const idSet = new Set(ids)
    const old = new Map(before.map((e) => [e.id, e]))
    setEntries((prev) =>
      prev.map((e) => {
        if (!idSet.has(e.id)) return e
        const restored = { ...e }
        for (const f of fields) (restored as Record<string, unknown>)[f] = old.get(e.id)![f]
        return restored
      })
    )
  }

  // Saves each changed row; returns the ids that did not save.
  const persistEntryChanges = async (
    updated: Entry[],
    changedIds: string[],
    fields: (keyof Entry)[]
  ): Promise<string[]> => {
    if (changedIds.length === 0) return []
    const byId = new Map(updated.map((e) => [e.id, e]))
    const results = await Promise.all(
      changedIds.map(async (id) => {
        const entry = byId.get(id)!
        const patch: Record<string, unknown> = {}
        for (const field of fields) patch[field] = entry[field]
        const res = await supabase.from('todo_entries').update(patch).eq('id', id).select('id')
        if (res.error) console.error('Saving entry change failed:', res.error)
        return saved(res) ? null : id
      })
    )
    return results.filter((id): id is string => id !== null)
  }

  const selectedListEntries = selectedListId
    ? entries.filter((e) => e.list_id === selectedListId)
    : []

  if (loading) return <div className="center-message">Loading…</div>

  return (
    <div className="app">
      <div className="banners">
        {signedOut && <div className="signed-out-banner">{SIGNED_OUT}</div>}
        {error && (
          <div className="error-banner" onClick={() => setError(null)}>
            {error} (tap to dismiss)
          </div>
        )}
      </div>
      <ListSidebar
        lists={lists}
        selectedListId={selectedListId}
        onSelect={setSelectedListId}
        onCreate={createList}
        onRename={renameList}
        onDelete={deleteList}
        onToggleCollapsed={toggleListCollapsed}
        onMove={moveList}
      />
      <main className="main-content">
        {selectedList ? (
          <ListView
            list={selectedList}
            entries={selectedListEntries}
            completions={completions}
            onAddEntry={addEntry}
            onToggleEntry={toggleEntry}
            onEditEntry={editEntry}
            onDeleteEntry={deleteEntry}
            onToggleCollapsedEntry={toggleEntryCollapsed}
            onMoveEntry={moveEntry}
            onUpdateListSettings={updateListSettings}
            onManualReset={manualReset}
          />
        ) : (
          <div className="center-message">
            Create a list on the left to get started.
          </div>
        )}
      </main>
    </div>
  )
}
