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
| `npm run migrate:date -- --apply` | One-off: move the event date from `data` into the `date` column |
| `npm run build` | Type-check and emit to `dist/` |

`npm run backup -- <dir>` writes somewhere else. The dump holds `_meta` plus
every record of every collection, so it is a full snapshot — restoring means
replaying `create_category` + `insert_record`.

## MCP tools

`list_collections`, `find_relevant_collections`, `create_category`,
`insert_record`, `query_records`, `update_record`, `delete_record`, `ping`.

Query flow: `find_relevant_collections` first, then `query_records` on the one
or two collections it returns — never scan everything.
