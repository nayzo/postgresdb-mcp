# postgresdb-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives any MCP-compatible AI assistant direct access to PostgreSQL databases across multiple environments.

## Features

- **Multi-environment**: connect to any number of databases (local, tst, stg, preprod, prod…) from a single `.env` file
- **Write protection**: writes disabled by default (`ALLOW_WRITES=false`), or enabled with mandatory `"WRITE"` confirmation (`ALLOW_WRITES=true`)
- **5 tools**: query, list-tables, describe-table, list-schemas, list-environments
- **Connection pooling**: up to 5 connections per environment, with automatic pool recovery on error
- **Parameterized queries**: safe execution with `$1`, `$2` … placeholders
- **SSL support**: configurable per environment with certificate verification control

## Installation

```bash
git clone https://github.com/yourusername/postgresdb-mcp.git
cd postgresdb-mcp
npm install
npm run build
```

## Configuration

Copy the example env file and fill in your credentials:

```bash
cp .env.dist .env
```

`.env` is gitignored so your credentials stay local and are never committed.

Edit `.env` with your database credentials. Environments are auto-discovered: any `POSTGRES_{ENV}_HOST` variable defines a new environment. The order in the file is preserved.

```env
# Local
POSTGRES_LOCAL_HOST=localhost
POSTGRES_LOCAL_DATABASE=mydb
POSTGRES_LOCAL_USER=postgres
POSTGRES_LOCAL_PASSWORD=postgres
POSTGRES_LOCAL_ALLOW_WRITES=true

# Staging
POSTGRES_STG_HOST=your-env-host
POSTGRES_STG_DATABASE=stg_mydb
POSTGRES_STG_USER=stg_user
POSTGRES_STG_PASSWORD=your-stg-password
POSTGRES_STG_SSL=true
POSTGRES_STG_ALLOW_WRITES=true

# Production
POSTGRES_PROD_HOST=your-env-host
POSTGRES_PROD_DATABASE=prod_mydb
POSTGRES_PROD_USER=prod_user
POSTGRES_PROD_PASSWORD=your-prod-password
POSTGRES_PROD_SSL=true
POSTGRES_PROD_ALLOW_WRITES=true
```

**Available variables per environment** (prefix: `POSTGRES_{ENV}_`):

| Variable | Required | Default | Description |
|---|---|---|---|
| `HOST` | yes | - | PostgreSQL host |
| `PORT` | no | `5432` | PostgreSQL port |
| `DATABASE` | yes | - | Database name |
| `USER` | yes | - | Database user |
| `PASSWORD` | yes | - | Database password |
| `SCHEMA` | no | `public` | Default schema for queries |
| `SSL` | no | `false` | Enable SSL (`true`/`false`) |
| `SSL_REJECT_UNAUTHORIZED` | no | `true` | Verify SSL certificate. Default `true` — only set to `false` if your DB uses a self-signed cert and you have no other option. Never disable in production. |
| `ALLOW_WRITES` | no | `false` | `true`: writes allowed, confirmation `confirm_write="WRITE"` required. `false` or unset: writes completely blocked. The `.env.dist` template sets `true` on all environments as a recommended starting point. |

## MCP client setup

This server works with any MCP-compatible client. Below are examples for common ones.

### Claude Desktop

Add to `~/.config/Claude/claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "postgresdb": {
      "command": "node",
      "args": [
        "/absolute/path/to/postgresdb-mcp/dist/index.js",
        "--env",
        "/absolute/path/to/.env"
      ]
    }
  }
}
```

Restart Claude Desktop after editing.

### Claude CLI

```bash
claude mcp add postgresdb -- node /absolute/path/to/dist/index.js --env /absolute/path/to/.env
```

### Other MCP clients

Start the server manually, it communicates over stdio:

```bash
node /absolute/path/to/postgresdb-mcp/dist/index.js --env /absolute/path/to/.env
```

If `--env` is omitted, the server looks for a `.env` file in the current working directory.

Refer to your client's documentation for how to register an MCP server using stdio transport.

## Available tools

### `query`
Execute a SQL query on a target environment. Returns `environment`, `database`, `queryType`, `duration`, `rowCount`, `rows`, and `fields`.

```
Run: SELECT COUNT(*) FROM users.orders WHERE status = 'pending' on stg
```

Write operations are subject to the environment's write protection mode (see [Write protection](#write-protection)). To confirm a write on an environment with `ALLOW_WRITES=true`, pass `confirm_write="WRITE"`.

### `list-tables`
List all tables in a schema.

```
List all tables in the public schema on local
```

### `describe-table`
Get the full structure of a table (columns, types, nullability, defaults).

```
Describe the users table in the public schema on stg
```

### `list-schemas`
List all user-defined schemas in a database.

```
What schemas are available on prod?
```

### `list-environments`
List all configured environments (no credentials exposed).

```
What environments are configured?
```

## Write protection

Every environment has one of two write modes, controlled by `POSTGRES_{ENV}_ALLOW_WRITES`:

| Mode | Config | Behaviour |
|---|---|---|
| **Blocked** (default) | `ALLOW_WRITES=false` or not set | Writes (`UPDATE`, `DELETE`, `INSERT`, `DROP`…) are immediately rejected. No confirmation prompt is shown. |
| **Allowed with confirmation** | `ALLOW_WRITES=true` | Writes are allowed, but the AI must explicitly pass `confirm_write="WRITE"` (exact string, case-sensitive) to execute. |

The check is applied after stripping SQL comments and handles multi-statement queries and CTEs containing embedded writes.

**Recommendation:** set `ALLOW_WRITES=true` on environments where you need to write from the AI (preprod, prod) — every write will require a deliberate `"WRITE"` confirmation. Leave it unset on read-only environments (replicas, analytics DBs).

## Development

```bash
npm run build   # compile TypeScript
npm run watch   # watch mode
```

**Requirements:** Node.js >= 18

## License

MIT
