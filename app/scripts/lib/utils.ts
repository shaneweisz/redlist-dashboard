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

// =============================================================================
// WHERE THINGS ARE
// =============================================================================

/**
 * One sync's files: app/data/sync, unless the pipeline points a builder at its
 * own output (PIPELINE_DATA_DIR). Laid out as src/lib/data/sync-layout.ts says.
 */
export const DATA_DIR = process.env.PIPELINE_DATA_DIR ?? path.join(__dirname, "..", "..", "data", "sync");
/** The searchable narratives, built per Red List release (scripts/narratives/). */
export const NARRATIVES_DIR = path.join(__dirname, "..", "..", "data", "narratives");
