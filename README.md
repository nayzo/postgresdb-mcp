# postgresdb-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives any MCP-compatible AI assistant direct access to PostgreSQL databases across multiple environments.

## Features

- **Multi-environment**: connect to any number of databases (local, tst, stg, preprod, prod…) from a single `.env` file
- **Write protection**: mark environments as `protected` to require explicit confirmation before any write operation
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

# Staging
POSTGRES_STG_HOST=your-env-host
POSTGRES_STG_DATABASE=stg_mydb
POSTGRES_STG_USER=stg_user
POSTGRES_STG_PASSWORD=your-stg-password
POSTGRES_STG_SSL=true
POSTGRES_STG_SSL_REJECT_UNAUTHORIZED=false

# Production
POSTGRES_PROD_HOST=your-env-host
POSTGRES_PROD_DATABASE=prod_mydb
POSTGRES_PROD_USER=prod_user
POSTGRES_PROD_PASSWORD=your-prod-password
POSTGRES_PROD_SSL=true
POSTGRES_PROD_WRITE_PROTECTION=true
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
| `SSL_REJECT_UNAUTHORIZED` | no | `true` | Verify SSL certificate. Set to `false` only for self-signed certs (dev/test), never in production |
| `WRITE_PROTECTION` | no | `false` | `true`: writes require `confirm_write="WRITE"` to execute. `false` (default): writes are completely blocked, no confirmation shown |

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
Execute a SQL query on a target environment.

```
Run: SELECT COUNT(*) FROM users.orders WHERE status = 'pending' on stg
```

Write operations on `protected` environments are blocked unless `confirm_write=true` is passed.

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

Every environment has one of two write modes, controlled by `POSTGRES_{ENV}_WRITE_PROTECTION`:

| Mode | Config | Behaviour |
|---|---|---|
| **Disabled** (default) | `WRITE_PROTECTION=false` or not set | Write operations (`UPDATE`, `DELETE`, `INSERT`, `DROP`…) are immediately rejected. No confirmation prompt is shown. |
| **Confirmation** | `WRITE_PROTECTION=true` | Write operations are blocked until the AI explicitly passes `confirm_write="WRITE"` (exact string, case-sensitive). |

The check is applied after stripping SQL comments and handles multi-statement queries and CTEs containing embedded writes.

**Recommendation:** set `WRITE_PROTECTION=true` on any environment you want to protect but still be able to write to (preprod, prod). Leave it unset on environments where writes should never happen from the AI (read-only replicas, analytics DBs).

## Development

```bash
npm run build   # compile TypeScript
npm run watch   # watch mode
```

**Requirements:** Node.js >= 18

## License

MIT
