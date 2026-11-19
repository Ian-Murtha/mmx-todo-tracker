export type DropZone = 'before' | 'after' | 'nest'

export function computeDropZone(
  activeRect: { top: number; height: number },
  overRect: { top: number; height: number }
): DropZone {
  const activeCenterY = activeRect.top + activeRect.height / 2
  const relative = (activeCenterY - overRect.top) / overRect.height
  if (relative < 0.25) return 'before'
  if (relative > 0.75) return 'after'
  return 'nest'
}

// Sibling order: by position, then created_at, then id, so a tie in `position` can never flip order after a reload.
export function compareSiblings(
  a: { position: number; created_at: string; id: string },
  b: { position: number; created_at: string; id: string }
): number {
  return (
    a.position - b.position ||
    (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
}

// Position for a new sibling: one past the highest existing sibling (not the sibling count, which collides after a delete).
export function nextPosition(siblings: { position: number }[]): number {
  return siblings.reduce((max, s) => Math.max(max, s.position), -1) + 1
}
