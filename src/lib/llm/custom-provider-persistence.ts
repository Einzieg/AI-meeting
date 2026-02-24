import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CustomProviderConfig, ModelInfo } from "./types";

const DB_FILE = path.join(process.cwd(), "data", "ai-meeting.db");

type SqliteDb = ReturnType<typeof Database>;

type CustomProviderRow = {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  models_json: string;
  created_at: string;
};

declare global {
  // Persist DB connection across Next.js dev hot reloads.
  // eslint-disable-next-line no-var
  var __aiMeetingCustomProvidersDb: SqliteDb | undefined;
}

function getDb(): SqliteDb {
  if (globalThis.__aiMeetingCustomProvidersDb) return globalThis.__aiMeetingCustomProvidersDb;

  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = new Database(DB_FILE);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      models_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  globalThis.__aiMeetingCustomProvidersDb = db;
  return db;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asPositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function parseModelsJson(modelsJson: string): ModelInfo[] {
  try {
    const raw = JSON.parse(modelsJson) as unknown;
    if (!Array.isArray(raw)) return [];

    const out: ModelInfo[] = [];
    for (const item of raw) {
      if (!isRecord(item)) continue;
      const id = asNonEmptyString(item.id);
      if (!id) continue;
      const name = asNonEmptyString(item.name) ?? id;
      out.push({
        id,
        name,
        context_window: asPositiveInt(item.context_window),
        max_output_tokens: asPositiveInt(item.max_output_tokens),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function rowToConfig(row: CustomProviderRow): CustomProviderConfig {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    api_key: row.api_key,
    models: parseModelsJson(row.models_json),
    created_at: row.created_at,
  };
}

export function listCustomProviderConfigs(): CustomProviderConfig[] {
  const db = getDb();
  const stmt = db.prepare<[], CustomProviderRow>(
    "SELECT id, name, base_url, api_key, models_json, created_at FROM custom_providers ORDER BY created_at DESC"
  );
  return stmt.all().map(rowToConfig);
}

export function getCustomProviderConfig(id: string): CustomProviderConfig | null {
  const db = getDb();
  const stmt = db.prepare<[string], CustomProviderRow>(
    "SELECT id, name, base_url, api_key, models_json, created_at FROM custom_providers WHERE id = ? LIMIT 1"
  );
  const row = stmt.get(id);
  return row ? rowToConfig(row) : null;
}

export function createCustomProviderConfig(config: CustomProviderConfig): void {
  const db = getDb();
  if (getCustomProviderConfig(config.id)) {
    throw new Error(`Custom provider already exists: ${config.id}`);
  }
  const stmt = db.prepare(
    "INSERT INTO custom_providers (id, name, base_url, api_key, models_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  stmt.run(
    config.id,
    config.name,
    config.base_url,
    config.api_key,
    JSON.stringify(config.models ?? []),
    config.created_at
  );
}

export function updateCustomProviderConfig(config: CustomProviderConfig): boolean {
  const db = getDb();
  const stmt = db.prepare(
    "UPDATE custom_providers SET name = ?, base_url = ?, api_key = ?, models_json = ? WHERE id = ?"
  );
  const result = stmt.run(
    config.name,
    config.base_url,
    config.api_key,
    JSON.stringify(config.models ?? []),
    config.id
  );
  return result.changes > 0;
}

export function deleteCustomProviderConfig(id: string): boolean {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM custom_providers WHERE id = ?");
  const result = stmt.run(id);
  return result.changes > 0;
}
