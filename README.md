# To-Do Tracker (standalone, no login)

Nested lists (checkbox or recurring/resetting), nested checkbox entries with
collapsible folders, drag-and-drop reordering and re-nesting, and per-entry
completion history for recurring lists. No login — single shared dataset.
Backed by Supabase.

## Setup

1. In your Supabase project's SQL Editor, run `supabase/schema.sql`.
2. Copy `.env.example` to `.env` and fill in your Supabase project URL and
   anon key (Project Settings → API).
3. `npm install`
4. `npm run dev` to run locally, or `npm run build` to produce a `dist/`
   folder for deployment.

## Features

- **Nested lists** — any list can contain sub-lists, to any depth. Drag a
  list onto the middle of another to nest it; onto the top/bottom edge to
  reorder as a sibling. A list can hold both its own entries and sub-lists.
- **Nested entries** — same pattern within a list: entries can contain
  sub-entries, collapsible into folders. Checking a folder checks
  everything inside; checking every item inside auto-checks the folder.
- **Recurring lists** — set a list's type to "Recurring" in its ⚙ Settings
  panel (daily/weekly/monthly/custom N days). Since there's no background
  server, the reset happens the next time the app is opened after the
  interval has elapsed. Each reset logs every entry's completion state to
  history (📊 History — a grid of entries × past cycles) before clearing
  the checkboxes for the new cycle.

## Notes

- Table names are prefixed `todo_` to avoid colliding with other apps in
  the same Supabase project.
- No routing/base-path assumptions are baked in — adjust `vite.config.ts`
  (`base`) if you're deploying this under a subpath alongside your other
  apps.
