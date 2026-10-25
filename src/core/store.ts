import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks(name TEXT PRIMARY KEY,title TEXT NOT NULL,worktree TEXT NOT NULL,base TEXT NOT NULL,accepted TEXT NOT NULL,scope TEXT NOT NULL,created REAL NOT NULL,closed REAL);
CREATE TABLE IF NOT EXISTS rounds(task TEXT NOT NULL,number INTEGER NOT NULL,before TEXT NOT NULL,after TEXT NOT NULL,units TEXT NOT NULL,summary TEXT NOT NULL,created REAL NOT NULL,PRIMARY KEY(task,number));
CREATE TABLE IF NOT EXISTS actions(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,task TEXT NOT NULL,round INTEGER NOT NULL,kind TEXT NOT NULL,changes TEXT NOT NULL,body TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,detail TEXT NOT NULL DEFAULT '{}',created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS writes(action TEXT NOT NULL,phase TEXT NOT NULL,path TEXT NOT NULL,expected BLOB,target BLOB,PRIMARY KEY(action,phase,path));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,task TEXT NOT NULL,round INTEGER,kind TEXT NOT NULL,action TEXT,body TEXT NOT NULL DEFAULT '',data TEXT NOT NULL DEFAULT '{}',created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,task TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL DEFAULT '',result TEXT NOT NULL DEFAULT '{}',created REAL NOT NULL,finished REAL);
CREATE INDEX IF NOT EXISTS actions_by_task ON actions(task,round);
CREATE INDEX IF NOT EXISTS messages_by_task ON messages(task,id);
CREATE INDEX IF NOT EXISTS jobs_by_task ON jobs(task,created);`;
const JSON_COLUMNS = new Set([
  "scope",
  "units",
  "summary",
  "changes",
  "detail",
  "data",
  "result",
]);
function row<T>(value: Record<string, unknown> | undefined): T | null {
  if (!value) return null;
  for (const key of Object.keys(value)) {
    if (JSON_COLUMNS.has(key)) value[key] = JSON.parse(value[key] as string);
    else if (value[key] instanceof Uint8Array)
      value[key] = Buffer.from(value[key]);
  }
  return value as T;
}
export class Store {
  db: DatabaseSync;
  constructor(public file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout=30000; PRAGMA journal_mode=WAL;");
    this.db.exec(SCHEMA);
  }
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  one<T>(query: string, ...args: SQLInputValue[]): T | null {
    return row<T>(this.db.prepare(query).get(...args));
  }
  all<T>(query: string, ...args: SQLInputValue[]): T[] {
    return this.db
      .prepare(query)
      .all(...args)
      .map((r) => row<T>(r)!);
  }
  execute(query: string, ...args: SQLInputValue[]) {
    return Number(this.db.prepare(query).run(...args).lastInsertRowid);
  }
  close() {
    this.db.close();
  }
}
