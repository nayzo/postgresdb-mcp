# postgresdb-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives any MCP-compatible AI assistant direct access to PostgreSQL databases across multiple environments.

## Features

- **Multi-environment** — connect to any number of databases (local, tst, stg, preprod, prod…) from a single config file
- **Write protection** — mark environments as `protected` to require explicit confirmation before any write operation
- **5 tools** — query, list-tables, describe-table, list-schemas, list-environments
- **Connection pooling** — up to 5 connections per environment, with automatic pool recovery on error
- **Parameterized queries** — safe execution with `$1`, `$2` … placeholders
- **SSL support** — configurable per environment with certificate verification control

## Installation

```bash
git clone https://github.com/yourusername/postgresdb-mcp.git
cd postgresdb-mcp
npm install
npm run build
```

## Configuration

Copy the example config and fill in your database credentials:

```bash
cp config.example.json config.json
```

Edit `config.json` with your environments. You can define as many as needed — the environment names are free-form (anything works: `local`, `tst`, `stg`, `preprod`, `prod`, `replica`, etc.):

```json
{
  "environments": {
    "local": {
      "host": "localhost",
      "port": 5432,
      "database": "mydb",
      "user": "postgres",
      "password": "postgres",
      "schema": "public"
    },
    "stg": {
      "host": "your-staging-cluster.cluster-xxxx.region.rds.amazonaws.com",
      "port": 5432,
      "database": "stg_mydb",
      "user": "stg_user",
      "password": "your-staging-password",
      "schema": "public",
      "ssl": true,
      "sslRejectUnauthorized": false
    },
    "prod": {
      "host": "your-prod-cluster.cluster-xxxx.region.rds.amazonaws.com",
      "port": 5432,
      "database": "prod_mydb",
      "user": "prod_user",
      "password": "your-prod-password",
      "schema": "public",
      "ssl": true,
      "protected": true
    }
  }
}
```

**Config options per environment:**

| Field | Required | Default | Description |
|---|---|---|---|
| `host` | yes | — | PostgreSQL host |
| `port` | no | `5432` | PostgreSQL port |
| `database` | yes | — | Database name |
| `user` | yes | — | Database user |
| `password` | yes | — | Database password |
| `schema` | no | `public` | Default schema for queries |
| `ssl` | no | `false` | Enable SSL (recommended for remote DBs) |
| `sslRejectUnauthorized` | no | `true` | Verify SSL certificate. Set to `false` only for self-signed certs (dev/test) — **never disable in production** |
| `protected` | no | `false` | Require `confirm_write=true` for write operations |

> `config.json` is listed in `.gitignore` — your credentials stay local and are never committed.

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
        "--config",
        "/absolute/path/to/your/config.json"
      ]
    }
  }
}
```

Restart Claude Desktop after editing.

### Claude CLI

```bash
claude mcp add postgresdb -- node /absolute/path/to/dist/index.js --config /absolute/path/to/config.json
```

### Other MCP clients

Start the server manually — it communicates over stdio:

```bash
node /absolute/path/to/postgresdb-mcp/dist/index.js --config /absolute/path/to/your/config.json
```

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

Environments marked with `"protected": true` will block any write operation (`UPDATE`, `DELETE`, `INSERT`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `REPLACE`, `GRANT`, `REVOKE`) unless `confirm_write=true` is explicitly passed by the AI.

The check is applied after stripping SQL comments and handles multi-statement queries and CTEs containing embedded writes.

This prevents accidental data modifications in sensitive environments such as pre-production and production.

## Development

```bash
npm run build   # compile TypeScript
npm run watch   # watch mode
```

**Requirements:** Node.js >= 18

## License

MIT
