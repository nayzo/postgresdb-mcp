# Changelog

## [2.0.0] - 2026-02-25

### Breaking changes
- Config is now loaded from a JSON file passed via `--config /path/to/config.json`
- Credentials are no longer hardcoded — see `config.example.json`

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
