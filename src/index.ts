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
  /** Backward compatibility: first allowed schema when POSTGRES_{ENV}_SCHEMA is provided. */
  schema?: string;
  /** Optional schema allowlist parsed from POSTGRES_{ENV}_SCHEMA (comma-separated). */
  allowedSchemas?: string[];
  ssl?: boolean;
  /** Set to false only for self-signed certificates (dev/test). Always true in production. Default: true */
  sslRejectUnauthorized?: boolean;
  /**
   * false (default): writes completely blocked, no confirmation possible
   * true: writes allowed but require confirm_write="WRITE" to execute
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

function canonicalizeSchemaName(schemaName: string): string {
  const trimmed = schemaName.trim();
  if (!trimmed) {
    throw new Error("Schema name cannot be empty.");
  }

  const quoted = /^"([\s\S]*)"$/.exec(trimmed);
  const unquoted = quoted ? quoted[1].replace(/""/g, '"') : trimmed;
  if (!unquoted.trim()) {
    throw new Error(`Schema name cannot be empty: "${schemaName}"`);
  }

  return unquoted.toLowerCase();
}

function parseSchemaScope(raw: string | undefined, variableName: string): string[] | undefined {
  if (!raw) return undefined;

  const schemas = raw
    .split(",")
    .map((value) => canonicalizeSchemaName(value))
    .filter(Boolean);

  if (schemas.length === 0) {
    throw new Error(`${variableName} is set but no valid schema was provided.`);
  }

  return Array.from(new Set(schemas));
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
    const schemaScope = parseSchemaScope(vars[`${p}_SCHEMA`], `${p}_SCHEMA`);

    environments[env] = {
      host,
      port: portRaw ? parseInt(portRaw, 10) : undefined,
      database,
      user,
      password,
      schema: schemaScope?.[0],
      allowedSchemas: schemaScope,
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
  if (key === "write")    return `${C.yellow}write:confirmed${C.reset}`;
  return `${C.dim}${value}${C.reset}`;
}

function log(tool: string, env: string | null, details: Record<string, unknown>): void {
  const prefix   = `${C.dim}[postgresdb-mcp]${C.reset}`;
  const toolPart = `[${colorTool(tool)}]`;
  const envPart  = env ? ` [${colorEnv(env)}]` : "";

  const detailParts = Object.entries(details)
    .map(([k, v]) => {
      const colored = colorValue(k, v);
      return colored ? `${C.dim}${k}=${C.reset}${colored}` : "";
    })
    .filter(Boolean)
    .join("  ");

  console.error(`${prefix} ${toolPart}${envPart}  ${detailParts}`);
}

// ─── Connection pool ────────────────────────────────────────────────────────

const pools: Record<string, pg.Pool> = {};

function getEnvConfigOrThrow(envName: string): EnvConfig {
  const config = ENV_CONFIGS[envName];
  if (!config) {
    throw new Error(
      `Unknown environment: "${envName}". Available: ${ENV_NAMES.join(", ")}`
    );
  }

  return config;
}

function getPool(envName: string): pg.Pool {
  if (pools[envName]) return pools[envName];

  const config = getEnvConfigOrThrow(envName);

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

function getAllowedSchemas(config: EnvConfig): string[] {
  return config.allowedSchemas ?? [];
}

function resolveSchemaForTool(
  envName: string,
  config: EnvConfig,
  requestedSchema?: string
): string {
  const allowedSchemas = getAllowedSchemas(config);
  const candidate = requestedSchema ?? config.schema ?? "public";
  const normalized = canonicalizeSchemaName(candidate);

  if (allowedSchemas.length === 0) {
    return normalized;
  }

  if (!allowedSchemas.includes(normalized)) {
    throw new Error(
      `Schema "${candidate}" is not allowed on "${envName}". Allowed schemas: ${allowedSchemas.join(", ")}.`
    );
  }

  return normalized;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function buildSearchPath(allowedSchemas: string[]): string {
  const searchPath = [...allowedSchemas];
  if (!searchPath.includes("pg_catalog")) {
    searchPath.push("pg_catalog");
  }

  return searchPath.map(quoteIdentifier).join(", ");
}

const IDENTIFIER_TOKEN = "(?:\"(?:[^\"]|\"\")+\"|[A-Za-z_][A-Za-z0-9_$]*)";
const QUALIFIED_REFERENCE_TOKEN = `${IDENTIFIER_TOKEN}\\s*\\.\\s*${IDENTIFIER_TOKEN}`;

const QUALIFIED_IDENTIFIER_REGEX = new RegExp(
  `^\\s*(${IDENTIFIER_TOKEN})\\s*\\.\\s*(${IDENTIFIER_TOKEN})\\s*$`,
  "i"
);

const RELATION_QUALIFIED_REF_REGEX = new RegExp(
  `\\b(?:FROM|JOIN|UPDATE|INTO|TABLE|TRUNCATE(?:\\s+TABLE)?|ALTER\\s+TABLE|DROP\\s+TABLE|CREATE\\s+TABLE|LOCK\\s+TABLE|COMMENT\\s+ON\\s+(?:TABLE|VIEW|MATERIALIZED\\s+VIEW|SEQUENCE|INDEX|COLUMN)|REFRESH\\s+MATERIALIZED\\s+VIEW)\\s+(${QUALIFIED_REFERENCE_TOKEN})`,
  "gi"
);

const FUNCTION_QUALIFIED_REF_REGEX = new RegExp(
  `\\b(${QUALIFIED_REFERENCE_TOKEN})\\s*\\(`,
  "gi"
);

function sanitizeSqlForSchemaGuard(sql: string): string {
  let out = "";
  let i = 0;

  let inSingleQuote = false;
  let inLineComment = false;
  let blockCommentDepth = 0;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";

    if (inLineComment) {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (ch === "/" && next === "*") {
        blockCommentDepth += 1;
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "*" && next === "/") {
        blockCommentDepth -= 1;
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        out += " ".repeat(dollarTag.length);
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (inSingleQuote) {
      if (ch === "'" && next === "'") {
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      if (ch === "'") inSingleQuote = false;
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      out += "  ";
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockCommentDepth = 1;
      out += "  ";
      i += 2;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      out += " ";
      i += 1;
      continue;
    }

    if (ch === "$") {
      const taggedMatch = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/);
      const untaggedMatch = sql.slice(i).match(/^\$\$/);
      const match = taggedMatch ?? untaggedMatch;

      if (match) {
        dollarTag = match[0];
        out += " ".repeat(dollarTag.length);
        i += dollarTag.length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

function extractSchemaFromQualifiedReference(reference: string): string | null {
  const match = QUALIFIED_IDENTIFIER_REGEX.exec(reference);
  if (!match) return null;

  return canonicalizeSchemaName(match[1]);
}

function extractExplicitSchemasFromQuery(sql: string): string[] {
  const sanitized = sanitizeSqlForSchemaGuard(sql);
  const foundSchemas = new Set<string>();

  RELATION_QUALIFIED_REF_REGEX.lastIndex = 0;
  let relationMatch: RegExpExecArray | null;
  while ((relationMatch = RELATION_QUALIFIED_REF_REGEX.exec(sanitized)) !== null) {
    const schema = extractSchemaFromQualifiedReference(relationMatch[1]);
    if (schema) foundSchemas.add(schema);
  }

  FUNCTION_QUALIFIED_REF_REGEX.lastIndex = 0;
  let functionMatch: RegExpExecArray | null;
  while ((functionMatch = FUNCTION_QUALIFIED_REF_REGEX.exec(sanitized)) !== null) {
    const schema = extractSchemaFromQualifiedReference(functionMatch[1]);
    if (schema) foundSchemas.add(schema);
  }

  return Array.from(foundSchemas);
}

function assertQuerySchemaScope(envName: string, sql: string, allowedSchemas: string[]): void {
  if (allowedSchemas.length === 0) return;

  const allowedSet = new Set([...allowedSchemas, "pg_catalog", "information_schema"]);
  const explicitSchemas = extractExplicitSchemasFromQuery(sql);
  const forbidden = explicitSchemas.filter((schema) => !allowedSet.has(schema));

  if (forbidden.length > 0) {
    throw new Error(
      `Schema access denied on "${envName}". Allowed schemas: ${allowedSchemas.join(", ")}. Blocked explicit schemas: ${forbidden.join(", ")}.`
    );
  }
}

const WRITE_KEYWORDS = [
  "UPDATE", "DELETE", "INSERT", "DROP", "TRUNCATE",
  "ALTER", "CREATE", "REPLACE", "GRANT", "REVOKE",
  "MERGE", "CALL", "DO", "COPY", "COMMENT", "ANALYZE",
  "VACUUM", "REINDEX", "CLUSTER", "REFRESH", "EXECUTE", "PREPARE",
];

const READ_ONLY_STATEMENT_START = new Set([
  "SELECT",
  "WITH",
  "VALUES",
  "SHOW",
  "TABLE",
  "EXPLAIN",
]);

/**
 * Remove comments and quoted literals before inspection.
 * This prevents bypasses through strings/comments and avoids splitting on semicolons inside them.
 */
function sanitizeSqlForInspection(sql: string): string {
  let out = "";
  let i = 0;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let blockCommentDepth = 0;
  let dollarTag: string | null = null;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1] ?? "";

    if (inLineComment) {
      out += ch === "\n" ? "\n" : " ";
      if (ch === "\n") inLineComment = false;
      i += 1;
      continue;
    }

    if (blockCommentDepth > 0) {
      if (ch === "/" && next === "*") {
        blockCommentDepth += 1;
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "*" && next === "/") {
        blockCommentDepth -= 1;
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (dollarTag !== null) {
      if (sql.startsWith(dollarTag, i)) {
        out += " ".repeat(dollarTag.length);
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i += 1;
      continue;
    }

    if (inSingleQuote) {
      if (ch === "'" && next === "'") {
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      if (ch === "'") inSingleQuote = false;
      i += 1;
      continue;
    }

    if (inDoubleQuote) {
      if (ch === '"' && next === '"') {
        out += "  ";
        i += 2;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      if (ch === '"') inDoubleQuote = false;
      i += 1;
      continue;
    }

    if (ch === "-" && next === "-") {
      inLineComment = true;
      out += "  ";
      i += 2;
      continue;
    }

    if (ch === "/" && next === "*") {
      blockCommentDepth = 1;
      out += "  ";
      i += 2;
      continue;
    }

    if (ch === "'") {
      inSingleQuote = true;
      out += " ";
      i += 1;
      continue;
    }

    if (ch === '"') {
      inDoubleQuote = true;
      out += " ";
      i += 1;
      continue;
    }

    if (ch === "$") {
      const taggedMatch = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/);
      const untaggedMatch = sql.slice(i).match(/^\$\$/);
      const match = taggedMatch ?? untaggedMatch;

      if (match) {
        dollarTag = match[0];
        out += " ".repeat(dollarTag.length);
        i += dollarTag.length;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out.toUpperCase();
}

function splitSqlStatements(sql: string): string[] {
  return sql.split(";").map((stmt) => stmt.trim()).filter(Boolean);
}

function containsWriteKeyword(stmt: string): boolean {
  return WRITE_KEYWORDS.some((kw) => new RegExp(`\\b${kw}\\b`).test(stmt));
}

function isSelectIntoStatement(stmt: string): boolean {
  return /\bSELECT\b[\s\S]*\bINTO\b/.test(stmt);
}

function isDangerousStatement(stmt: string): boolean {
  const firstToken = stmt.match(/^[A-Z]+/)?.[0];
  if (!firstToken) return false;

  if (containsWriteKeyword(stmt)) return true;
  if (isSelectIntoStatement(stmt)) return true;

  // Fail closed: any statement outside the explicit read-only subset needs confirmation.
  return !READ_ONLY_STATEMENT_START.has(firstToken);
}

/**
 * Returns true if the SQL contains a write operation.
 * Handles:
 *   - Direct writes: DELETE FROM ..., UPDATE ...
 *   - Multi-statement: SELECT 1; DELETE FROM users
 *   - CTEs with embedded writes: WITH x AS (UPDATE ...) SELECT * FROM x
 *   - Comment-based bypass: -- DELETE\nSELECT ...
 *   - Payload hidden in literals/comments: PREPARE p AS 'DELETE ...'; EXECUTE p
 *   - Unknown statement types are treated as dangerous (fail closed)
 */
function isDangerousQuery(sql: string): boolean {
  const normalized = sanitizeSqlForInspection(sql);
  const statements = splitSqlStatements(normalized);
  return statements.some((stmt) => isDangerousStatement(stmt));
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

/**
 * Defense-in-depth:
 * - without explicit WRITE authorization, every query runs in a READ ONLY transaction
 * - with explicit WRITE authorization, query runs normally
 */
async function executeQueryWithSafety(
  pool: pg.Pool,
  sql: string,
  params: unknown[] | undefined,
  writeAuthorized: boolean,
  allowedSchemas: string[]
): Promise<pg.QueryResult> {
  const enforceSearchPath = allowedSchemas.length > 0;

  if (writeAuthorized && !enforceSearchPath) {
    return pool.query(sql, params as unknown[]);
  }

  const client = await pool.connect();

  try {
    await client.query(writeAuthorized ? "BEGIN" : "BEGIN READ ONLY");
    if (enforceSearchPath) {
      await client.query(`SET LOCAL search_path TO ${buildSearchPath(allowedSchemas)}`);
    }
    const result = await client.query(sql, params as unknown[]);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore rollback failures; original error is more relevant
    }
    throw error;
  } finally {
    client.release();
  }
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
- Without confirm_write="WRITE", queries run in PostgreSQL READ ONLY mode
- If POSTGRES_{ENV}_SCHEMA is set, access is restricted to those schema(s)
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
            description: `Type "WRITE" (exact, case-sensitive) to confirm a write operation on environments where writes are allowed (${confirmEnvs.join(", ") || "none"})`,
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
            description: "Schema name (default: environment scope if configured, otherwise public)",
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
            description: "Schema name (default: environment scope if configured, otherwise public)",
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
        log("list-environments", null, { count: ENV_NAMES.length, envs: ENV_NAMES.join(",") });

        const envs = ENV_NAMES.map((envName) => {
          const envConfig = ENV_CONFIGS[envName];
          const allowedSchemas = getAllowedSchemas(envConfig);

          return {
            name: envName,
            host: envConfig.host,
            database: envConfig.database,
            schema: allowedSchemas.length > 0 ? allowedSchemas.join(",") : "*",
            schemaScope: allowedSchemas.length > 0 ? allowedSchemas : ["*"],
            ssl: envConfig.ssl ?? false,
            allowWrites: envConfig.allowWrites === true ? "confirm" : "disabled",
          };
        });

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

        const envConfig = getEnvConfigOrThrow(env);
        const allowedSchemas = getAllowedSchemas(envConfig);

        if (params !== undefined) {
          const invalidIndex = params.findIndex((p) => !isValidParam(p));
          if (invalidIndex !== -1) {
            throw new Error(
              `Invalid parameter at index ${invalidIndex}: ${JSON.stringify(params[invalidIndex])}. Allowed types: string, number, boolean, null.`
            );
          }
        }

        assertQuerySchemaScope(env, sql, allowedSchemas);

        const dangerous = isDangerousQuery(sql);

        if (dangerous) {
          if (!envConfig.allowWrites) {
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
        const writeAuthorized = envConfig.allowWrites === true && confirm_write === "WRITE";
        const queryType = sanitizeSqlForInspection(sql).trim().split(/\s+/)[0] || "UNKNOWN";
        const t0 = Date.now();
        const result = await executeQueryWithSafety(
          pool,
          sql,
          params,
          writeAuthorized,
          allowedSchemas
        );
        const duration = Date.now() - t0;

        log("query", env, {
          type: queryType,
          db: envConfig.database,
          rows: result.rowCount ?? 0,
          duration: `${duration}ms`,
          ...(dangerous ? { write: true } : {}),
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  environment: env,
                  database: envConfig.database,
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
        const { env, schema: requestedSchema } = args as {
          env: string;
          schema?: string;
        };

        const envConfig = getEnvConfigOrThrow(env);
        const schema = resolveSchemaForTool(env, envConfig, requestedSchema);
        log("list-tables", env, { schema, db: envConfig.database });

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
                { environment: env, database: envConfig.database, schema, tables: result.rows },
                null,
                2
              ),
            },
          ],
        };
      }

      case "describe-table": {
        const { env, schema: requestedSchema, table } = args as {
          env: string;
          schema?: string;
          table: string;
        };

        const envConfig = getEnvConfigOrThrow(env);
        const schema = resolveSchemaForTool(env, envConfig, requestedSchema);
        log("describe-table", env, { schema, table, db: envConfig.database });

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
                { environment: env, database: envConfig.database, schema, table, columns: result.rows },
                null,
                2
              ),
            },
          ],
        };
      }

      case "list-schemas": {
        const { env } = args as { env: string };

        const envConfig = getEnvConfigOrThrow(env);
        log("list-schemas", env, { db: envConfig.database });

        const allowedSchemas = getAllowedSchemas(envConfig);
        const pool = getPool(env);
        const result = await pool.query(
          `SELECT
            schema_name,
            (SELECT COUNT(*)
             FROM information_schema.tables
             WHERE table_schema = s.schema_name
             ) AS table_count
           FROM information_schema.schemata s
           WHERE
             schema_name NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
             AND ($1::text[] IS NULL OR schema_name = ANY($1::text[]))
           ORDER BY schema_name`,
          [allowedSchemas.length > 0 ? allowedSchemas : null]
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { environment: env, database: envConfig.database, schemas: result.rows },
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
