# Changelog

## [2.1.0] - 2026-03-20

### Breaking changes
- Config now loaded from a `.env` file instead of `config.json`
  - Old: `postgresdb-mcp --config /path/to/config.json`
  - New: `postgresdb-mcp --env /path/to/.env` (or `.env` in CWD by default)
- `config.json` and `config.example.json` removed: use `.env.dist` as the template

### Added
- `.env`-based configuration: environments are auto-discovered from `POSTGRES_{ENV}_HOST` variables
- `POSTGRES_{ENV}_SSL_REJECT_UNAUTHORIZED` variable (default: `true`): allows self-signed certs in dev/test without disabling cert verification in production
- Runtime config validation with clear error messages for missing or malformed fields
- Runtime parameter validation: rejects non-scalar values before they reach the database driver
- Pool auto-recovery: on a fatal pool error, the pool is torn down and recreated on the next request

### Changed
- `isDangerousQuery()` now strips SQL comments (`--`, `/* */`) before checking for write keywords, preventing comment-based bypass
- `isDangerousQuery()` now splits on `;` to catch multi-statement attacks (e.g. `SELECT 1; DELETE FROM users`)
- `isDangerousQuery()` detects write keywords inside CTEs (`WITH x AS (UPDATE ...) SELECT * FROM x`)
- Server startup logs now include a `[postgresdb-mcp]` prefix for easier filtering

### Fixed
- SSL connections previously used `rejectUnauthorized: false` unconditionally, now defaults to `true`
- Configs with wrong field types now fail at startup with a clear error instead of a cryptic driver error at query time

## [2.0.0] - 2026-02-25

### Breaking changes
- Config is now loaded from a JSON file passed via `--config /path/to/config.json`
- Credentials are no longer hardcoded

### Added
- File-based configuration: define any number of environments in a single JSON file
- Per-environment `ssl` and `protected` flags
- `confirm_write` replaces `confirm_prod_write` (now applies to any protected environment, not just prod)

### Changed
- Tool descriptions are dynamically built from the loaded config
- Default schema changed from `users` to `public` (overridable per environment in config)
- Error responses no longer include stack traces

## [1.0.0] - 2026-02-02

### Added
- Initial release
- Multi-environment PostgreSQL access (local, stg, tst, prod)
- 5 MCP tools: query, list-tables, describe-table, list-schemas, list-environments
- Connection pooling (max 5 per environment)
- SSL support for remote databases
- Write protection for production environment
