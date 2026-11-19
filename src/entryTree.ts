import type { Entry, FlatEntry } from './types'
import { computeDropZone, compareSiblings, type DropZone } from './tree'

export { computeDropZone, type DropZone }

export function buildChildrenMap(entries: Entry[]): Map<string | null, Entry[]> {
  const map = new Map<string | null, Entry[]>()
  for (const entry of entries) {
    const key = entry.parent_entry_id
    const list = map.get(key) ?? []
    list.push(entry)
    map.set(key, list)
  }
  for (const list of map.values()) {
    list.sort(compareSiblings)
  }
  return map
}

export function flattenTree(
  entries: Entry[],
  parentId: string | null = null,
  depth = 0,
  childrenMap?: Map<string | null, Entry[]>
): FlatEntry[] {
  const map = childrenMap ?? buildChildrenMap(entries)
  const siblings = map.get(parentId) ?? []
  const result: FlatEntry[] = []

  for (const entry of siblings) {
    const children = map.get(entry.id) ?? []
    result.push({ ...entry, depth, hasChildren: children.length > 0 })
    if (children.length > 0 && !entry.collapsed) {
      result.push(...flattenTree(entries, entry.id, depth + 1, map))
    }
  }
  return result
}

export function getDescendantIds(entries: Entry[], id: string): Set<string> {
  const map = buildChildrenMap(entries)
  const result = new Set<string>()
  const walk = (parentId: string) => {
    const children = map.get(parentId) ?? []
    for (const child of children) {
      result.add(child.id)
      walk(child.id)
    }
  }
  walk(id)
  return result
}

export function getAncestorIds(entries: Entry[], id: string): string[] {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const result: string[] = []
  let current = byId.get(id)?.parent_entry_id ?? null
  while (current) {
    result.push(current)
    current = byId.get(current)?.parent_entry_id ?? null
  }
  return result
}

export function filterOutSubtree(entries: Entry[], id: string): Entry[] {
  const toRemove = getDescendantIds(entries, id)
  toRemove.add(id)
  return entries.filter((e) => !toRemove.has(e.id))
}

export function toggleWithCascade(
  entries: Entry[],
  id: string,
  done: boolean
): { entries: Entry[]; changedIds: string[] } {
  const byId = new Map(entries.map((e) => [e.id, { ...e }]))
  const changed = new Set<string>()

  const target = byId.get(id)
  if (!target) return { entries, changedIds: [] }

  if (target.done !== done) changed.add(id)
  target.done = done

  for (const descId of getDescendantIds(entries, id)) {
    const desc = byId.get(descId)!
    if (desc.done !== done) changed.add(descId)
    desc.done = done
  }

  const childrenMap = buildChildrenMap(Array.from(byId.values()))
  for (const ancestorId of getAncestorIds(entries, id)) {
    const ancestor = byId.get(ancestorId)!
    const children = childrenMap.get(ancestorId) ?? []
    const newDone = children.length > 0 && children.every((c) => byId.get(c.id)!.done)
    if (ancestor.done !== newDone) {
      changed.add(ancestorId)
      ancestor.done = newDone
    }
  }

  return {
    entries: entries.map((e) => byId.get(e.id)!),
    changedIds: Array.from(changed),
  }
}

export function moveEntry(
  entries: Entry[],
  draggedId: string,
  overId: string,
  zone: DropZone
): { entries: Entry[]; changedIds: string[] } | null {
  if (draggedId === overId) return null

  const dragged = entries.find((e) => e.id === draggedId)
  const over = entries.find((e) => e.id === overId)
  if (!dragged || !over) return null

  const descendantIds = getDescendantIds(entries, draggedId)
  if (descendantIds.has(overId)) return null

  const newParentId = zone === 'nest' ? over.id : over.parent_entry_id
  if (newParentId === draggedId) return null

  const byId = new Map(entries.map((e) => [e.id, { ...e }]))
  const changed = new Set<string>()

  const oldParentId = dragged.parent_entry_id

  const destSiblings = entries
    .filter((e) => e.parent_entry_id === newParentId && e.id !== draggedId)
    .sort(compareSiblings)

  let insertIndex: number
  if (zone === 'nest') {
    insertIndex = destSiblings.length
  } else {
    const overIndex = destSiblings.findIndex((e) => e.id === overId)
    insertIndex = zone === 'before' ? overIndex : overIndex + 1
  }
  destSiblings.splice(insertIndex, 0, dragged)

  destSiblings.forEach((sibling, index) => {
    const entry = byId.get(sibling.id)!
    if (entry.position !== index) {
      entry.position = index
      changed.add(entry.id)
    }
    if (sibling.id === draggedId && entry.parent_entry_id !== newParentId) {
      entry.parent_entry_id = newParentId
      changed.add(entry.id)
    }
  })

  if (oldParentId !== newParentId) {
    const oldSiblings = entries
      .filter((e) => e.parent_entry_id === oldParentId && e.id !== draggedId)
      .sort(compareSiblings)
    oldSiblings.forEach((sibling, index) => {
      const entry = byId.get(sibling.id)!
      if (entry.position !== index) {
        entry.position = index
        changed.add(entry.id)
      }
    })
  }

  if (zone === 'nest') {
    const target = byId.get(over.id)!
    if (target.collapsed) {
      target.collapsed = false
      changed.add(target.id)
    }
  }

  return {
    entries: entries.map((e) => byId.get(e.id)!),
    changedIds: Array.from(changed),
  }
}
