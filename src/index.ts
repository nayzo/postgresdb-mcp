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
  protected?: boolean;
}

interface Config {
  environments: Record<string, EnvConfig>;
}

function loadConfig(): Config {
  const args = process.argv.slice(2);
  const configIndex = args.indexOf("--config");

  if (configIndex === -1 || !args[configIndex + 1]) {
    console.error("Usage: postgresdb-mcp --config /path/to/config.json");
    console.error("See config.example.json for the expected format.");
    process.exit(1);
  }

  const configPath = path.resolve(args[configIndex + 1]);

  if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    process.exit(1);
  }

  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as Config;

    if (!config.environments || typeof config.environments !== "object") {
      throw new Error('Config must have an "environments" object.');
    }

    return config;
  } catch (err) {
    console.error(`Failed to load config: ${(err as Error).message}`);
    process.exit(1);
  }
}

const CONFIG = loadConfig();
const ENV_CONFIGS = CONFIG.environments;
const ENV_NAMES = Object.keys(ENV_CONFIGS);

const pools: Record<string, pg.Pool> = {};

const WRITE_KEYWORDS = [
  "UPDATE", "DELETE", "INSERT", "DROP", "TRUNCATE",
  "ALTER", "CREATE", "REPLACE", "GRANT", "REVOKE",
];

function isDangerousQuery(sql: string): boolean {
  const normalized = sql.trim().toUpperCase();
  return WRITE_KEYWORDS.some(
    (kw) =>
      normalized.startsWith(kw) ||
      new RegExp(`^(WITH[\\s\\S]*?)?\\s*${kw}\\s`, "i").test(normalized)
  );
}

function getPool(envName: string): pg.Pool {
  if (pools[envName]) return pools[envName];

  const config = ENV_CONFIGS[envName];
  if (!config) {
    throw new Error(
      `Unknown environment: "${envName}". Available: ${ENV_NAMES.join(", ")}`
    );
  }

  pools[envName] = new Pool({
    host: config.host,
    port: config.port ?? 5432,
    database: config.database,
    user: config.user,
    password: config.password,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
  });

  pools[envName].on("error", (err) => {
    console.error(`Pool error (${envName}):`, err.message);
  });

  return pools[envName];
}

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
- Use parameterized queries for user-provided values${protectionNote}`,
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
            description: "Optional parameters for parameterized queries",
            items: { type: ["string", "number", "boolean", "null"] },
          },
          confirm_write: {
            type: "boolean",
            description: `Required to execute write operations on protected environments (${protectedEnvs.join(", ") || "none"})`,
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

const server = new Server(
  { name: "postgresdb-mcp", version: "2.0.0" },
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`PostgreSQL MCP Server v2.0.0 started`);
  console.error(`Environments: ${ENV_NAMES.join(", ")}`);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

process.on("SIGINT", async () => {
  await Promise.all(Object.values(pools).map((p) => p.end()));
  process.exit(0);
});
