import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Dialect = "sqlite" | "postgres" | "mysql";

export interface Queryable {
  readonly dialect: Dialect;
  exec(sql: string): Promise<void>;
  get<T>(sql: string, params?: unknown[]): Promise<T | undefined>;
  all<T>(sql: string, params?: unknown[]): Promise<T[]>;
  run(sql: string, params?: unknown[]): Promise<number>;
  close(): Promise<void>;
}

export async function openSqlite(path: string): Promise<Queryable> {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return {
    dialect: "sqlite",
    async exec(sql: string) {
      db.exec(sql);
    },
    async get<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).get(...(params as SQLInputValue[])) as T | undefined;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as SQLInputValue[])) as unknown as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      return Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes);
    },
    async close() {
      db.close();
    },
  };
}

export async function openPostgres(url: string): Promise<Queryable> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    dialect: "postgres",
    async exec(sql: string) {
      await client.query(toPostgres(sql));
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(toPostgres(sql), params);
      return result.rows[0] as T | undefined;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const result = await client.query(toPostgres(sql), params);
      return result.rows as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      const result = await client.query(toPostgres(sql), params);
      return result.rowCount ?? 0;
    },
    async close() {
      await client.end();
    },
  };
}

export async function openMysql(url: string): Promise<Queryable> {
  const mysql = await import("mysql2/promise");
  const connection = await mysql.createConnection(url);
  return {
    dialect: "mysql",
    async exec(sql: string) {
      await connection.query(sql);
    },
    async get<T>(sql: string, params: unknown[] = []) {
      const [rows] = await connection.query(sql, params);
      return ((rows as T[])[0] ?? undefined) as T | undefined;
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const [rows] = await connection.query(sql, params);
      return rows as T[];
    },
    async run(sql: string, params: unknown[] = []) {
      const [result] = await connection.query(sql, params);
      return Number((result as { affectedRows?: number }).affectedRows ?? 0);
    },
    async close() {
      await connection.end();
    },
  };
}

export function toPostgres(sql: string): string {
  let index = 0;
  return sql.replaceAll("?", () => `$${++index}`);
}
