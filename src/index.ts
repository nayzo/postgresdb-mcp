#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import pg from "pg";
import fs from "fs";
import path from "path";

const { Pool } = pg;

interface EnvConfig {
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  schema?: string;
  ssl?: boolean;
  /** Set to false only for self-signed certificates (dev/test). Always true in production. Default: true */
  sslRejectUnauthorized?: boolean;
  protected?: boolean;
}

interface Config {
  environments: Record<string, EnvConfig>;
}

// ─── Config loading (.env) ──────────────────────────────────────────────────

function parseEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};

  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    const raw = trimmed.slice(eqIndex + 1).trim();
    // Strip optional surrounding quotes
    vars[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
  }

  return vars;
}

function buildConfigFromEnv(vars: Record<string, string>): Config {
  // Auto-discover environments by scanning for POSTGRES_{ENV}_HOST variables
  const envNames: string[] = [];

  for (const key of Object.keys(vars)) {
    const match = key.match(/^POSTGRES_([A-Z0-9]+)_HOST$/);
    if (match) envNames.push(match[1].toLowerCase());
  }

  if (envNames.length === 0) {
    throw new Error(
      "No environments found. Define at least one POSTGRES_{ENV}_HOST variable in your .env file."
    );
  }

  const environments: Record<string, EnvConfig> = {};

  for (const env of envNames) {
    const p = `POSTGRES_${env.toUpperCase()}`;
    const host = vars[`${p}_HOST`];
    const database = vars[`${p}_DATABASE`];
    const user = vars[`${p}_USER`];
    const password = vars[`${p}_PASSWORD`];

    if (!host || !database || !user || !password) {
      throw new Error(
        `Environment "${env}": missing required variable(s). Expected: ${p}_HOST, ${p}_DATABASE, ${p}_USER, ${p}_PASSWORD.`
      );
    }

    const portRaw = vars[`${p}_PORT`];
    const sslRejectRaw = vars[`${p}_SSL_REJECT_UNAUTHORIZED`];

    environments[env] = {
      host,
      port: portRaw ? parseInt(portRaw, 10) : undefined,
      database,
      user,
      password,
      schema: vars[`${p}_SCHEMA`] || undefined,
      ssl: vars[`${p}_SSL`] === "true",
      sslRejectUnauthorized: sslRejectRaw !== undefined ? sslRejectRaw !== "false" : true,
      protected: vars[`${p}_PROTECTED`] === "true",
    };
  }

  return { environments };
}

function loadConfig(): Config {
  const args = process.argv.slice(2);
  const envFlagIndex = args.indexOf("--env");

  const envFilePath =
    envFlagIndex !== -1 && args[envFlagIndex + 1]
      ? path.resolve(args[envFlagIndex + 1])
      : path.resolve(".env");

  if (!fs.existsSync(envFilePath)) {
    console.error(`[postgresdb-mcp] .env file not found: ${envFilePath}`);
    console.error(`[postgresdb-mcp] Usage: postgresdb-mcp --env /path/to/.env`);
    console.error(`[postgresdb-mcp] See .env.dist for the expected format.`);
    process.exit(1);
  }

  try {
    const vars = parseEnvFile(envFilePath);
    return buildConfigFromEnv(vars);
  } catch (err) {
    console.error(`[postgresdb-mcp] Failed to load config: ${(err as Error).message}`);
    process.exit(1);
  }
}

const CONFIG = loadConfig();
const ENV_CONFIGS = CONFIG.environments;
const ENV_NAMES = Object.keys(ENV_CONFIGS);

// ─── Connection pool ────────────────────────────────────────────────────────

const pools: Record<string, pg.Pool> = {};

function getPool(envName: string): pg.Pool {
  if (pools[envName]) return pools[envName];

  const config = ENV_CONFIGS[envName];
  if (!config) {
    throw new Error(
      `Unknown environment: "${envName}". Available: ${ENV_NAMES.join(", ")}`
    );
  }

  const pool = new Pool({
    host: config.host,
    port: config.port ?? 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: config.ssl
      ? { rejectUnauthorized: config.sslRejectUnauthorized ?? true }
      : false,
  });

  pool.on("error", (err) => {
    console.error(`[postgresdb-mcp] Pool error on "${envName}":`, err.message);
    // Remove from cache so the next request gets a fresh pool
    pool.end().catch(() => {});
    delete pools[envName];
  });

  pools[envName] = pool;
  return pool;
}

// ─── Query safety ───────────────────────────────────────────────────────────

const WRITE_KEYWORDS = [
  "UPDATE", "DELETE", "INSERT", "DROP", "TRUNCATE",
  "ALTER", "CREATE", "REPLACE", "GRANT", "REVOKE",
];

/** Strip SQL single-line (--) and multi-line (/* *\/) comments. */
function stripSqlComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

/**
 * Returns true if the SQL contains a write operation.
 * Handles:
 *   - Direct writes: DELETE FROM ..., UPDATE ...
 *   - Multi-statement: SELECT 1; DELETE FROM users
 *   - CTEs with embedded writes: WITH x AS (UPDATE ...) SELECT * FROM x
 *   - Comment-based bypass: -- DELETE\nSELECT ...
 */
function isDangerousQuery(sql: string): boolean {
  const normalized = stripSqlComments(sql).toUpperCase();

  // Split on semicolons to catch multi-statement attacks
  const statements = normalized.split(";").map((s) => s.trim()).filter(Boolean);

  return statements.some((stmt) => {
    // Direct write at statement start: "DELETE ...", "UPDATE ...", etc.
    if (WRITE_KEYWORDS.some((kw) => new RegExp(`^${kw}(\\s|$)`).test(stmt))) {
      return true;
    }

    // CTE containing a write: "WITH x AS (UPDATE ...) SELECT ..."
    if (/^WITH[\s(]/.test(stmt)) {
      return WRITE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(stmt));
    }

    return false;
  });
}

/** Runtime validation for query parameters. */
function isValidParam(v: unknown): v is string | number | boolean | null {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

// ─── MCP tools ──────────────────────────────────────────────────────────────

function buildTools(): Tool[] {
  const envEnum = ENV_NAMES;
  const envDescription = envEnum.join(", ");
  const protectedEnvs = ENV_NAMES.filter((e) => ENV_CONFIGS[e].protected);
  const protectionNote =
    protectedEnvs.length > 0
      ? `\n\n⚠️ Protected environments: ${protectedEnvs.join(", ")}. Write operations require confirm_write=true.`
      : "";

  return [
    {
      name: "query",
      description: `Execute a SQL query on a PostgreSQL database.

- Always use schema-qualified table names (e.g., schema.table_name)
- Prefer SELECT queries; use write operations with care
- Use parameterized queries ($1, $2 …) for user-provided values${protectionNote}`,
      inputSchema: {
        type: "object",
        properties: {
          env: {
            type: "string",
            description: `Target environment (${envDescription})`,
            enum: envEnum,
          },
          sql: {
            type: "string",
            description: "SQL query to execute",
          },
          params: {
            type: "array",
            description: "Optional parameters for parameterized queries ($1, $2 …)",
            items: { type: ["string", "number", "boolean", "null"] },
          },
          confirm_write: {
            type: "boolean",
            description: `Set to true to confirm write operations on protected environments (${protectedEnvs.join(", ") || "none"})`,
            default: false,
          },
        },
        required: ["env", "sql"],
      },
    },
    {
      name: "list-tables",
      description: "List all tables in a schema",
      inputSchema: {
        type: "object",
        properties: {
          env: {
            type: "string",
            description: `Environment (${envDescription})`,
            enum: envEnum,
          },
          schema: {
            type: "string",
            description: "Schema name (default: public)",
            default: "public",
          },
        },
        required: ["env"],
      },
    },
    {
      name: "describe-table",
      description:
        "Get the structure of a table (columns, types, nullability, defaults)",
      inputSchema: {
        type: "object",
        properties: {
          env: {
            type: "string",
            description: `Environment (${envDescription})`,
            enum: envEnum,
          },
          table: {
            type: "string",
            description: "Table name",
          },
          schema: {
            type: "string",
            description: "Schema name (default: public)",
            default: "public",
          },
        },
        required: ["env", "table"],
      },
    },
    {
      name: "list-schemas",
      description: "List all user-defined schemas in the database",
      inputSchema: {
        type: "object",
        properties: {
          env: {
            type: "string",
            description: `Environment (${envDescription})`,
            enum: envEnum,
          },
        },
        required: ["env"],
      },
    },
    {
      name: "list-environments",
      description: "List all configured database environments",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];
}

const TOOLS = buildTools();

// ─── MCP server ─────────────────────────────────────────────────────────────

const server = new Server(
  { name: "postgresdb-mcp", version: "2.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list-environments": {
        const envs = ENV_NAMES.map((envName) => ({
          name: envName,
          host: ENV_CONFIGS[envName].host,
          database: ENV_CONFIGS[envName].database,
          schema: ENV_CONFIGS[envName].schema ?? "public",
          ssl: ENV_CONFIGS[envName].ssl ?? false,
          protected: ENV_CONFIGS[envName].protected ?? false,
        }));

        return {
          content: [{ type: "text", text: JSON.stringify(envs, null, 2) }],
        };
      }

      case "query": {
        const {
          env,
          sql,
          params,
          confirm_write = false,
        } = args as {
          env: string;
          sql: string;
          params?: unknown[];
          confirm_write?: boolean;
        };

        const envConfig = ENV_CONFIGS[env];
        if (!envConfig) {
          throw new Error(
            `Unknown environment: "${env}". Available: ${ENV_NAMES.join(", ")}`
          );
        }

        if (params !== undefined) {
          const invalidIndex = params.findIndex((p) => !isValidParam(p));
          if (invalidIndex !== -1) {
            throw new Error(
              `Invalid parameter at index ${invalidIndex}: ${JSON.stringify(params[invalidIndex])}. Allowed types: string, number, boolean, null.`
            );
          }
        }

        if (envConfig.protected && isDangerousQuery(sql) && !confirm_write) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    error: "WRITE PROTECTION",
                    environment: env,
                    message: `Write operations on "${env}" require explicit confirmation.`,
                    solution: "Set confirm_write=true to proceed.",
                    warning: "Double-check your query before confirming.",
                  },
                  null,
                  2
                ),
              },
            ],
            isError: true,
          };
        }

        const pool = getPool(env);
        const result = await pool.query(sql, params as unknown[]);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  rowCount: result.rowCount,
                  rows: result.rows,
                  fields: result.fields.map((f) => ({
                    name: f.name,
                    dataTypeID: f.dataTypeID,
                  })),
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list-tables": {
        const { env, schema = "public" } = args as {
          env: string;
          schema?: string;
        };

        const pool = getPool(env);
        const result = await pool.query(
          `SELECT
            table_name,
            (SELECT COUNT(*)
             FROM information_schema.columns
             WHERE table_schema = $1 AND table_name = t.table_name
            ) AS column_count
          FROM information_schema.tables t
          WHERE table_schema = $1
          ORDER BY table_name`,
          [schema]
        );

        return {
          content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        };
      }

      case "describe-table": {
        const { env, schema = "public", table } = args as {
          env: string;
          schema?: string;
          table: string;
        };

        const pool = getPool(env);
        const result = await pool.query(
          `SELECT
            column_name,
            data_type,
            character_maximum_length,
            numeric_precision,
            numeric_scale,
            is_nullable,
            column_default
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position`,
          [schema, table]
        );

        return {
          content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        };
      }

      case "list-schemas": {
        const { env } = args as { env: string };

        const pool = getPool(env);
        const result = await pool.query(
          `SELECT
            schema_name,
            (SELECT COUNT(*)
             FROM information_schema.tables
             WHERE table_schema = s.schema_name
            ) AS table_count
          FROM information_schema.schemata s
          WHERE schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
          ORDER BY schema_name`
        );

        return {
          content: [{ type: "text", text: JSON.stringify(result.rows, null, 2) }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { error: error instanceof Error ? error.message : String(error) },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }
});

// ─── Startup & shutdown ──────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[postgresdb-mcp] v2.1.0 started`);
  console.error(`[postgresdb-mcp] Environments: ${ENV_NAMES.join(", ")}`);
}

main().catch((error) => {
  console.error("[postgresdb-mcp] Fatal error:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  process.exit(0);
});
