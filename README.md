# postgresdb-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server that gives Claude direct access to PostgreSQL databases across multiple environments.

## Features

- **Multi-environment** — connect to any number of databases (local, staging, prod…) from a single config file
- **Write protection** — mark environments as `protected` to require explicit confirmation before any write operation
- **5 tools** — query, list-tables, describe-table, list-schemas, list-environments
- **Connection pooling** — up to 5 connections per environment, with SSL support for remote databases
- **Parameterized queries** — safe execution with user-provided values

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
    "prod": {
      "host": "your-cluster.rds.amazonaws.com",
      "port": 5432,
      "database": "prod_mydb",
      "user": "prod_user",
      "password": "your-password",
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
| `schema` | no | `public` | Default schema |
| `ssl` | no | `false` | Enable SSL (recommended for remote DBs) |
| `protected` | no | `false` | Require `confirm_write=true` for write operations |

> `config.json` is in `.gitignore` — your credentials stay local.

## Claude Desktop setup

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

## Claude CLI setup

```bash
claude mcp add postgresdb -- node /absolute/path/to/dist/index.js --config /absolute/path/to/config.json
```

## Available tools

### `query`
Execute a SQL query on a target environment.

```
Run: SELECT COUNT(*) FROM users.orders WHERE status = 'pending' on staging
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
Describe the users table in the public schema on staging
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

Environments marked with `"protected": true` will block any write operation (`UPDATE`, `DELETE`, `INSERT`, `DROP`, `TRUNCATE`, `ALTER`, `CREATE`, `REPLACE`, `GRANT`, `REVOKE`) unless Claude explicitly passes `confirm_write=true`.

This prevents accidental data modifications in production.

## Development

```bash
npm run build   # compile TypeScript
npm run watch   # watch mode
```

## License

MIT
