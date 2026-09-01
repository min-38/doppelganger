# doppelganger

Personal schemaless lifelog DB exposed to AI as an MCP server.
Records go into per-category tables on Turso (libSQL); the `_meta` registry is
what makes them findable later.

## Setup

```bash
npm install
cp .env.example .env   # fill in TURSO_DATABASE_URL / TURSO_AUTH_TOKEN
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Run the MCP server over stdio |
| `npm test` | Run the self-checks (date / score / filter) |
| `npm run backup` | Export every collection to `backup/<YYYY-MM-DD>.json` |
| `npm run trim:history -- --apply` | Prune `_history` down to the newest revisions per record |
| `npm run migrate:date -- --apply` | One-off: move the event date from `data` into the `date` column |
| `npm run build` | Type-check and emit to `dist/` |

`npm run backup -- <dir>` writes somewhere else, `--no-history` leaves the
revision log out (roughly halves the dump). The dump holds `_meta` plus every
record of every collection, so it is a full snapshot — restoring means
replaying `create_category` + `insert_record`.

## MCP tools

`list_collections`, `find_relevant_collections`, `create_category`,
`insert_record`, `insert_records_bulk`, `query_records`, `get_stats`,
`search_across_tables`, `update_record`, `delete_record`, `restore_record`,
`suggest_merge_candidates`, `ping`.

Query flow: `find_relevant_collections` first, then `query_records` on the one
or two collections it returns — never scan everything. For numbers use
`get_stats` rather than reading rows; for "what happened last week" style
questions use `search_across_tables`.

`update_record` and `delete_record` snapshot the previous values into
`_history`, so `restore_record` can undo the last change to a record. Only the
newest few revisions per record are kept.

Re-importing a source that carries its own identifier? Pass `unique_by` to
`insert_records_bulk` — unchanged records are then skipped entirely instead of
being rewritten.
