import { useDraggable, useDroppable } from '@dnd-kit/core'
import { useEffect, useState } from 'react'
import type { FlatEntry } from '../types'

interface Props {
  entry: FlatEntry
  onToggle: (id: string, done: boolean) => void
  onEdit: (id: string, content: string) => Promise<boolean>
  onDelete: (id: string) => void
  onToggleCollapsed: (id: string, collapsed: boolean) => void
  onAddChild: (parentId: string) => void
  activeDropZone: 'before' | 'after' | 'nest' | null
  isDropTarget: boolean
}

export default function EntryRow({
  entry,
  onToggle,
  onEdit,
  onDelete,
  onToggleCollapsed,
  onAddChild,
  activeDropZone,
  isDropTarget,
}: Props) {
  const [text, setText] = useState(entry.content)

  // Follow the saved text (for example after a reload or a change from another device).
  useEffect(() => {
    setText(entry.content)
  }, [entry.content])

  const { attributes, listeners, setNodeRef: setDragRef, isDragging } =
    useDraggable({ id: entry.id })
  const { setNodeRef: setDropRef } = useDroppable({ id: entry.id })

  const setRefs = (node: HTMLElement | null) => {
    setDragRef(node)
    setDropRef(node)
  }

  return (
    <div
      ref={setRefs}
      className={[
        'entry-row',
        isDragging ? 'dragging' : '',
        isDropTarget && activeDropZone === 'nest' ? 'drop-nest' : '',
        isDropTarget && activeDropZone === 'before' ? 'drop-before' : '',
        isDropTarget && activeDropZone === 'after' ? 'drop-after' : '',
      ].join(' ')}
      style={{ marginLeft: entry.depth * 24 }}
    >
      <span className="drag-handle" {...attributes} {...listeners}>
        ⠿
      </span>

      {entry.hasChildren ? (
        <button
          className="chevron-btn"
          onClick={() => onToggleCollapsed(entry.id, !entry.collapsed)}
          title={entry.collapsed ? 'Expand' : 'Collapse'}
        >
          {entry.collapsed ? '▸' : '▾'}
        </button>
      ) : (
        <span className="chevron-spacer" />
      )}

      <input
        type="checkbox"
        checked={entry.done}
        onChange={(e) => onToggle(entry.id, e.target.checked)}
      />
      <input
        className={`entry-text ${entry.done ? 'done' : ''}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={async () => {
          const trimmed = text.trim()
          // Blank text is never saved, so put the saved text back instead of leaving an empty box.
          if (!trimmed) {
            setText(entry.content)
            return
          }
          if (trimmed === entry.content) {
            setText(entry.content)
            return
          }
          const ok = await onEdit(entry.id, trimmed)
          if (!ok) setText(entry.content) // not saved: show what is actually saved
        }}
      />
      <button
        className="add-child-btn"
        title="Add sub-item"
        onClick={() => onAddChild(entry.id)}
      >
        +
      </button>
      <button className="delete-btn" onClick={() => onDelete(entry.id)}>
        ✕
      </button>
    </div>
  )
}
