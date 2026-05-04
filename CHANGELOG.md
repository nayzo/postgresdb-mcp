# Changelog

## [Unreleased]

### Security
- Hardened write detection in `query` to prevent bypasses where writes were hidden in multi-statement payloads (e.g. `PREPARE ...; EXECUTE ...`).
- SQL safety analysis now ignores comments/quoted literals (including dollar-quoted blocks) before inspection.
- Added DB-level enforcement: queries without explicit `confirm_write="WRITE"` now run in `BEGIN READ ONLY`, blocking side-effect writes at PostgreSQL level.
- Added optional schema scope enforcement (`POSTGRES_{ENV}_SCHEMA`): explicit references to non-allowed schemas are blocked.

### Changed
- Write guard is now fail-closed: statements outside an explicit read-only subset (`SELECT`, `WITH`, `VALUES`, `SHOW`, `TABLE`, `EXPLAIN`) are treated as write-sensitive.
- `list-tables`, `describe-table`, and `list-schemas` now validate unknown environments consistently before logging/querying.
- When `POSTGRES_{ENV}_SCHEMA` is configured, `list-tables`/`describe-table` are constrained to that scope and `query` runs with `SET LOCAL search_path` for additional isolation.

## [2.1.0] - 2026-03-20

### Breaking changes
- Config now loaded from a `.env` file instead of `config.json`
  - Before: `postgresdb-mcp --config /path/to/config.json`
  - After: `postgresdb-mcp --env /path/to/.env` (or `.env` in CWD by default)
- `config.json` and `config.example.json` removed — use `.env.dist` as the template
- Write protection reworked: `protected` flag replaced by `ALLOW_WRITES`
  - Before: `protected=true` + `confirm_write=true` (boolean)
  - After: `ALLOW_WRITES=false` (default, writes blocked) or `ALLOW_WRITES=true` (writes allowed with `confirm_write="WRITE"`)
- `confirm_write` parameter changed from boolean to string — must equal `"WRITE"` (exact, case-sensitive)

### Added
- `.env`-based configuration: environments auto-discovered from `POSTGRES_{ENV}_HOST` variables, order preserved
- `POSTGRES_{ENV}_ALLOW_WRITES` flag (default: `false`):
  - `false`: writes immediately rejected, no confirmation shown
  - `true`: writes allowed, require `confirm_write="WRITE"` to execute
- `POSTGRES_{ENV}_SSL_REJECT_UNAUTHORIZED` (default: `true`): certificate verification, set to `false` only for self-signed certs
- Runtime config validation at startup with clear error messages for missing fields
- Runtime parameter type validation: rejects non-scalar values before reaching the database driver
- Pool auto-recovery: on fatal pool error, pool is removed from cache and recreated on next request
- Per-request colored terminal logs: env in bold yellow, tool in cyan, query type in green, rows in blue, duration dimmed, errors in red
- All tool responses now include `environment` and `database` context
- `query` response includes `queryType` and `duration`
- `list-tables` response key renamed to `tables`
- `describe-table` response key renamed to `columns`
- `list-schemas` response key renamed to `schemas`
- `list-environments` exposes `allowWrites` status (`"confirm"` or `"disabled"`) per environment

### Changed
- `isDangerousQuery()` now strips SQL comments (`--`, `/* */`) before checking for write keywords
- `isDangerousQuery()` splits on `;` to detect multi-statement attacks (e.g. `SELECT 1; DELETE FROM users`)
- `isDangerousQuery()` detects write keywords inside CTEs (`WITH x AS (UPDATE ...) SELECT * FROM x`)
- `isDangerousQuery()` result cached per request to avoid double computation
- Color/logging helpers moved before pool initialization in source for clarity

### Fixed
- SSL previously used `rejectUnauthorized: false` unconditionally — now defaults to `true`
- `write:blocked` log entry was dead code — removed (blocked writes return early before reaching the log)

## [2.0.0] - 2026-02-25

### Breaking changes
- Config now loaded from a JSON file via `--config /path/to/config.json`
- Credentials no longer hardcoded

### Added
- File-based configuration: any number of environments in a single JSON file
- Per-environment `ssl` and `protected` flags
- `confirm_write` replaces `confirm_prod_write`

### Changed
- Tool descriptions dynamically built from loaded config
- Default schema changed from `users` to `public`
- Error responses no longer include stack traces

## [1.0.0] - 2026-02-02

### Added
- Initial release
- Multi-environment PostgreSQL access (local, stg, tst, prod)
- 5 MCP tools: query, list-tables, describe-table, list-schemas, list-environments
- Connection pooling (max 5 per environment)
- SSL support for remote databases
- Write protection for production environment
