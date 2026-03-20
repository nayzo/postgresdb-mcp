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
  /**
   * Write protection mode:
   *   true  → writes allowed but require confirm_write="WRITE" to execute
   *   false → writes completely blocked, no confirmation possible
   */
  allowWrites?: boolean;
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
      allowWrites: vars[`${p}_ALLOW_WRITES`] === "true",
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
    console.error(`${C.dim}[postgresdb-mcp]${C.reset} ${C.red}pool error${C.reset} [${colorEnv(envName)}]  ${C.dim}${err.message}${C.reset}`);
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
  const confirmEnvs = ENV_NAMES.filter((e) => ENV_CONFIGS[e].allowWrites === true);
  const blockedEnvs = ENV_NAMES.filter((e) => !ENV_CONFIGS[e].allowWrites);
  const protectionNote = [
    confirmEnvs.length > 0
      ? `\n\n⚠️ Write confirmation required on: ${confirmEnvs.join(", ")}. Pass confirm_write="WRITE" to proceed.`
      : "",
    blockedEnvs.length > 0
      ? `\n🚫 Writes completely disabled on: ${blockedEnvs.join(", ")}.`
      : "",
  ].join("");

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
            type: "string",
            description: `Type "WRITE" (exact, case-sensitive) to confirm a write operation on environments where write protection is enabled (${confirmEnvs.join(", ") || "none"})`,
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

// ─── Logging ────────────────────────────────────────────────────────────────

const C = {
  reset:  "\x1b[0m",
  dim:    "\x1b[2m",
  cyan:   "\x1b[36m",
  yellow: "\x1b[33m",
  green:  "\x1b[32m",
  red:    "\x1b[31m",
  blue:   "\x1b[34m",
  bold:   "\x1b[1m",
};

function colorEnv(env: string): string {
  return `${C.bold}${C.yellow}${env}${C.reset}`;
}

function colorTool(tool: string): string {
  return `${C.cyan}${tool}${C.reset}`;
}

function colorValue(key: string, value: unknown): string {
  if (key === "type")     return `${C.green}${value}${C.reset}`;
  if (key === "duration") return `${C.dim}${value}${C.reset}`;
  if (key === "rows")     return `${C.blue}${value} rows${C.reset}`;
  if (key === "write" && value === "confirmed") return `${C.yellow}write:confirmed${C.reset}`;
  if (key === "write" && value === "blocked")   return `${C.red}write:blocked${C.reset}`;
  if (key === "write")    return "";
  return `${C.dim}${value}${C.reset}`;
}

function log(tool: string, env: string | null, details: Record<string, unknown>): void {
  const prefix = `${C.dim}[postgresdb-mcp]${C.reset}`;
  const toolPart = `[${colorTool(tool)}]`;
  const envPart = env ? ` [${colorEnv(env)}]` : "";

  const detailParts = Object.entries(details)
    .map(([k, v]) => {
      const colored = colorValue(k, v);
      return colored ? `${C.dim}${k}=${C.reset}${colored}` : "";
    })
    .filter(Boolean)
    .join("  ");

  console.error(`${prefix} ${toolPart}${envPart}  ${detailParts}`);
}

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
        log("list-environments", null, { count: ENV_NAMES.length, envs: ENV_NAMES.join(",") });

        const envs = ENV_NAMES.map((envName) => ({
          name: envName,
          host: ENV_CONFIGS[envName].host,
          database: ENV_CONFIGS[envName].database,
          schema: ENV_CONFIGS[envName].schema ?? "public",
          ssl: ENV_CONFIGS[envName].ssl ?? false,
          allowWrites: ENV_CONFIGS[envName].allowWrites === true ? "confirm" : "disabled",
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
          confirm_write,
        } = args as {
          env: string;
          sql: string;
          params?: unknown[];
          confirm_write?: string;
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

        if (isDangerousQuery(sql)) {
          if (!envConfig.allowWrites) {
            // Write protection disabled → writes completely blocked
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      error: "WRITES DISABLED",
                      environment: env,
                      message: `Write operations are not allowed on "${env}". This feature is disabled.`,
                      hint: `Set POSTGRES_${env.toUpperCase()}_ALLOW_WRITES=true in your .env to enable write confirmation.`,
                    },
                    null,
                    2
                  ),
                },
              ],
              isError: true,
            };
          }

          // Write protection enabled → require explicit "WRITE" confirmation
          if (confirm_write !== "WRITE") {
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      error: "WRITE CONFIRMATION REQUIRED",
                      environment: env,
                      message: `Write operation detected on "${env}". You must explicitly confirm.`,
                      action: 'Pass confirm_write="WRITE" (exact, case-sensitive) to proceed.',
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
        }

        const pool = getPool(env);
        const queryType = stripSqlComments(sql).trim().split(/\s+/)[0].toUpperCase();
        const t0 = Date.now();
        const result = await pool.query(sql, params as unknown[]);
        const duration = Date.now() - t0;

        log("query", env, {
          type: queryType,
          db: ENV_CONFIGS[env].database,
          rows: result.rowCount ?? 0,
          duration: `${duration}ms`,
          ...(isDangerousQuery(sql) ? { write: ENV_CONFIGS[env].allowWrites ? "confirmed" : "blocked" } : {}),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  environment: env,
                  database: ENV_CONFIGS[env].database,
                  queryType,
                  duration: `${duration}ms`,
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

        log("list-tables", env, { schema, db: ENV_CONFIGS[env].database });

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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { environment: env, database: ENV_CONFIGS[env].database, schema, tables: result.rows },
                null,
                2
              ),
            },
          ],
        };
      }

      case "describe-table": {
        const { env, schema = "public", table } = args as {
          env: string;
          schema?: string;
          table: string;
        };

        log("describe-table", env, { schema, table, db: ENV_CONFIGS[env].database });

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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { environment: env, database: ENV_CONFIGS[env].database, schema, table, columns: result.rows },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list-schemas": {
        const { env } = args as { env: string };

        log("list-schemas", env, { db: ENV_CONFIGS[env].database });

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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { environment: env, database: ENV_CONFIGS[env].database, schemas: result.rows },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${C.dim}[postgresdb-mcp]${C.reset} [${colorTool(name)}]  ${C.red}error${C.reset}  ${C.dim}${message}${C.reset}`);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message }, null, 2),
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
  console.error(`${C.dim}[postgresdb-mcp]${C.reset} ${C.bold}${C.green}v2.1.0 started${C.reset}`);
  console.error(`${C.dim}[postgresdb-mcp]${C.reset} Environments: ${ENV_NAMES.map(colorEnv).join(`${C.dim}, ${C.reset}`)}`);
}

main().catch((error) => {
  console.error(`${C.dim}[postgresdb-mcp]${C.reset} ${C.red}fatal error${C.reset}`, error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  process.exit(0);
});
