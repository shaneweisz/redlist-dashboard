/**
 * Shared utilities for sync scripts.
 *
 * - Environment loading
 * - JSONL logging
 * - CSV read/write
 * - Concurrency helpers
 */

import * as fs from "fs";
import * as path from "path";

// =============================================================================
// ENV LOADING
// =============================================================================

export function loadEnvFiles(): void {
  const dirs = [
    path.join(__dirname, "..", "..", ".."),
    path.join(__dirname, "..", ".."),
  ];
  for (const dir of dirs) {
    for (const file of [".env", ".env.local"]) {
      loadEnvFile(path.join(dir, file));
    }
  }
}

function loadEnvFile(filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const withoutExport = trimmed.replace(/^export\s+/, "");
        const [key, ...valueParts] = withoutExport.split("=");
        const value = valueParts.join("=").replace(/^["']|["']$/g, "");
        if (key && value) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // File doesn't exist, skip
  }
}

// =============================================================================
// JSONL LOGGING
// =============================================================================

export class SyncLogger {
  private stream: fs.WriteStream | null;
  private counts: Record<string, number> = {};

  constructor(scriptName: string, logsDir?: string) {
    const dir = logsDir || path.join(__dirname, "..", "..", "logs");
    fs.mkdirSync(dir, { recursive: true });

    const ts = new Date().toISOString().replace(/:/g, "-").replace(/\.\d+Z$/, "Z");
    const filename = `${ts}_${scriptName}.jsonl`;
    this.stream = fs.createWriteStream(path.join(dir, filename), { flags: "a" });
  }

  static noop(): SyncLogger {
    const logger = Object.create(SyncLogger.prototype) as SyncLogger;
    logger.stream = null;
    logger.counts = {};
    return logger;
  }

  log(event: string, data: Record<string, unknown>): void {
    this.counts[event] = (this.counts[event] || 0) + 1;
    if (!this.stream) return;
    const entry = {
      ts: new Date().toISOString(),
      event,
      ...data,
    };
    this.stream.write(JSON.stringify(entry) + "\n");
  }

  getCounts(): Record<string, number> {
    return { ...this.counts };
  }

  close(): void {
    this.stream?.end();
  }
}

// =============================================================================
// CONCURRENCY & UTILITY HELPERS
// =============================================================================

export async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

export function toTitleCase(s: string): string {
  return s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// =============================================================================
// CSV UTILITIES
// =============================================================================

/**
 * One sync's files: app/data/sync, unless the pipeline points a builder at its
 * own output (PIPELINE_DATA_DIR). Laid out as src/lib/data/sync-layout.ts says.
 */
export const DATA_DIR = process.env.PIPELINE_DATA_DIR ?? path.join(__dirname, "..", "..", "data", "sync");
/** The searchable narratives, built per Red List release (scripts/narratives/). */
export const NARRATIVES_DIR = path.join(__dirname, "..", "..", "data", "narratives");
export const REDLIST_DIR = path.join(DATA_DIR, "redlist");
export const GBIF_DIR = path.join(DATA_DIR, "gbif");

/**
 * Quoting for DuckDB's read_csv, matching what writeCsv below emits.
 *
 * Pass this rather than letting auto-detection guess. It samples 20,480 rows and
 * infers quote='' if it sees none, which is a coin flip on a file whose only
 * quoted rows are rare: flowering_plants.csv has 231,000 rows and exactly two
 * containing a comma inside a vernacular name ("Barun, Banny"). The sample
 * missed both, quoting was inferred off, and the row split into ten fields —
 * surfacing as a type error on a column four positions away, an hour and a half
 * into a sync.
 */
export const CSV_QUOTING = `quote='"', escape='"'`;

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

export function writeCsv(
  rows: Record<string, string | number | null | undefined>[],
  columns: string[],
  outputPath: string
): void {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const header = columns.join(",");
  const lines = rows.map((row) =>
    columns.map((col) => {
      const val = row[col];
      if (val === null || val === undefined || val === "") return "";
      return csvEscape(String(val));
    }).join(",")
  );
  fs.writeFileSync(outputPath, header + "\n" + lines.join("\n") + "\n");
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

export function readCsv<T>(
  inputPath: string,
  parse: (row: Record<string, string>) => T
): T[] {
  const content = fs.readFileSync(inputPath, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];

  const headers = parseCsvLine(lines[0]);
  const results: T[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? "";
    }
    results.push(parse(row));
  }

  return results;
}
