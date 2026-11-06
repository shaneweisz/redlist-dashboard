/**
 * The Red List database, opened read-only.
 *
 * It is a colleague's, and the login we have can write to it, so Postgres
 * won't stop a mistaken write: every session is opened with
 * default_transaction_read_only=on, and checked before it is used. The sync
 * reads it through DuckDB with the same settings (core/build-assessments.ts).
 * DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD in app/.env.local.
 */

import { Client } from "pg";

export async function connectRedListDb(): Promise<Client> {
  const db = new Client({
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: "-c default_transaction_read_only=on -c statement_timeout=600000",
  });
  await db.connect();
  const { rows } = await db.query("SELECT current_setting('default_transaction_read_only') AS ro");
  if (rows[0]?.ro !== "on") {
    await db.end();
    throw new Error("The Red List session is not read-only; refusing to continue.");
  }
  return db;
}
