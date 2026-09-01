# Doppelgänger

Personal schemaless lifelog DB + MCP server. See `doppelganger-spec.md` for detailed spec.

## Directory Structure
```
doppelganger/
├── AGENTS.md
├── doppelganger-spec.md
├── .mcp.json              # MCP server config, auto-loaded by Codex for this project
├── .env                    # not committed
├── .env.example
├── .gitignore
├── src/
│   ├── index.ts             # MCP server entrypoint
│   ├── tools/                # one file per tool group (insert.ts, query.ts, meta.ts, ...)
│   ├── db.ts                  # Turso(libSQL) client + schema helpers
│   └── utils/
│       └── date.ts            # date normalization logic
├── scripts/
│   └── backup.ts               # SQL dump / JSON export
├── package.json
├── tsconfig.json
└── .Codex/
    └── commands/
        └── new-issue.md         # /new-issue — creates a properly formatted GitHub issue
```

## Project Nature
- Single-user personal project only. Do not consider multi-user support, auth, or productization.
- Purpose: let AI query this DB for real data instead of relying on memory across conversations.

## Stack
- Node.js + TypeScript
- `@modelcontextprotocol/sdk` (stdio transport)
- Turso (libSQL, SQLite-based), `@libsql/client` driver
- `zod` for tool input validation
- `dotenv` for managing `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`

## Core Design Principles
1. **Separate tables by category.** One table per category (`meals`, `workout`, ...), not one table with a `category` column. The number of tables can grow large (hundreds); each table can have few rows. "Collection" in the tool names means "table".
2. **Schemaless via a JSON column, with `date` promoted to a real column.** Every data table has the same fixed shape: `id INTEGER PRIMARY KEY AUTOINCREMENT`, `date TEXT NOT NULL` (when the event happened — indexed), `data TEXT` (the remaining fields as JSON), `created_at TEXT`, `updated_at TEXT` (system timestamps — recording yesterday's meal today must not collapse the two). Other per-category fields live inside `data` and are read with `json_extract(data, '$.field')` — no migrations when fields change. `insert_record` takes `date` as a required argument, normalized via `src/utils/date.ts`.
3. **The `_meta` table is the core of this system.** Every data table must be registered in `_meta` on creation with `collection_name`, `description`, `category_group`, `keywords`, and `sample_fields` (the last two stored as JSON arrays). Write `description` concretely, covering: what this records / what questions it answers / related synonyms.
4. **Always scan `_meta` first before querying.** Never scan all data tables. Narrow candidates to 1–3 via `find_relevant_collections` before calling `query_records`.
5. **Always normalize date/time to `YYYY-MM-DD HH:MM:SS` before storing.** Convert before insert; also validate format server-side.
6. **Prevent duplicate tables before creating new ones.** On `create_category`, the server checks similarity against existing `_meta` entries and returns a warning if a similar collection already exists (start with string similarity, can upgrade to embedding similarity later).
7. **Table names are a trust boundary.** They are interpolated into SQL, so always run them through `assertTableName()` in `src/db.ts` (`^[a-z][a-z0-9_]*$`, `_meta` reserved). Record values always go through bound parameters (`?`), never string concatenation.

## MCP Tools
- `find_relevant_collections(query)`
- `list_collections()`
- `create_category(collection_name, description, category_group, keywords)`
- `insert_record(collection_name, date, data)` — `date` is required and means when the event happened
- `insert_records_bulk(collection_name, records)` — same validation, one write, all-or-nothing
- `query_records(collection_name, filter, limit)`
- `get_stats(collection_name, field, agg_type, from, to, group_by)` — aggregate server-side instead of reading every row
- `search_across_tables(keyword, date_from, date_to)` — timeline across collections, bounded to 10 tables per call
- `update_record(collection_name, id, date, data)`
- `delete_record(collection_name, id)`
- `restore_record(collection_name, id)` — undoes the last update/delete from `_history`
- `suggest_merge_candidates()`

Insert paths refuse near-identical records on the same date (`force: true` overrides), the same way `create_category` refuses similar collections.
`_meta` and `_history` are reserved table names — see `assertTableName()`.

## Security
- Store `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` only in `.env`, never commit them — `.gitignore` must include `.env`

## Git Workflow

All work history lives in GitHub Issues. Commits act only as pointers to issues.

**Issues themselves must be written in Korean** (title, body, and comments). Everything else in this repo (code, comments, commit messages, this file) is in English.

### Branch Strategy
- `main` and `develop` exist but must never be moved (committed to, merged into, rebased, etc.) without explicit instruction from the user.
- For any task, create a new branch off the current `HEAD` — do not assume `develop` or `main` is checked out; branch from wherever `HEAD` currently points.
- Branch naming: `mskim/<issue-number>` (e.g. `mskim/12`).

### Commit Message Format
```
[#issue-number][type] issue title

https://github.com/<user>/<repo>/issues/<number>
```
Example:
```
[#12][feat] insert_record 날짜 포맷 정규화 추가

https://github.com/username/doppelganger/issues/12
```
- Reuse the issue title as-is for the commit title (in Korean, matching the issue) — do not write a new English description
- Body contains only the issue URL. Reasons/context/discussion go in the issue and its comments, not the commit
- type: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

### Issue Management
Keep issues as small as possible. If one issue bundles multiple tasks, tracking and review get harder — split work into separate, smaller issues.

Write issues in Korean using this template on creation:
```markdown
## 목적 / 배경
왜 필요한지

## 작업 내용
뭘 할 건지 (체크리스트로)
- [ ]
- [ ]

## 관련 tool/컬렉션
영향받는 MCP tool이나 DB 컬렉션

## 참고 사항
```
- Log decision changes or important forks in the road as comments (in Korean)
- Log problems, direction changes, or dropped/deferred work items as comments (in Korean)
- Split large-scope work into sub-issues
- Before closing, leave a final summary comment (in Korean)
- Labels/milestones: no fixed list. If a fitting label (`bug`, `feat`, `refactor`, `docs`, `chore`, `priority:high/mid/low`, etc.) or milestone doesn't exist in the repo yet, create it

### Issue Comment Format (Korean)
```
[유형] 내용
```
유형:
- `[결정변경]` — direction/approach changed mid-work
- `[문제]` — blocker, error, unexpected issue
- `[진행]` — interim progress update (only when needed)
- `[보류]` — part of the work couldn't be done or was deferred
- `[완료]` — final summary right before closing the issue

Example:
```
[결정변경] JSON 컬럼 대신 카테고리별 컬렉션 분리 방식으로 변경. 이유: 집계 쿼리가 더 명확해짐
[문제] Turso 무료 티어 월간 row read 한도에 근접. 쿼리 limit 상한 필요
[완료] insert_record에 날짜 정규화 로직 추가 완료. YYYY-MM-DD HH:MM:SS 강제 변환 확인함
```

## Implementation Order
1. Basic CRUD tools (find_relevant_collections, list_collections, create_category, insert_record, query_records, update_record, delete_record)
2. Date format normalization
3. Similar-collection warning logic in create_category
4. Auto-create indexes on frequently queried fields (`date` column index)
5. Backup script (SQL dump or JSON export)
6. suggest_merge_candidates

## Test Scenarios
1. Run locally, confirm Turso connection
2. Connect to Codex Desktop, confirm tools are exposed
3. "Log today's workout: squat 3 sets 60kg" → create_category(workout) → insert_record
4. "What should I eat today?" → find_relevant_collections → confirm only `meals` is queried
5. "I logged yesterday's sleep time wrong, fix it" → find via query_records, then update_record
6. Try creating a collection with a similar name → confirm the similar-collection warning fires
