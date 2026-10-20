"""SQLite state: tasks, review rounds, decisions (as an undoable action log) and agent feedback."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3

SCHEMA = '''
CREATE TABLE IF NOT EXISTS tasks(
  name TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  worktree TEXT NOT NULL,
  base TEXT NOT NULL,            -- snapshot the task started from
  accepted TEXT NOT NULL,        -- base plus every change accepted so far
  scope TEXT NOT NULL,           -- JSON {paths, ranges, sections}
  created REAL NOT NULL,
  closed REAL
);
CREATE TABLE IF NOT EXISTS rounds(
  task TEXT NOT NULL,
  number INTEGER NOT NULL,
  before TEXT NOT NULL,          -- accepted text when the round was published
  after TEXT NOT NULL,           -- snapshot of the agent's worktree
  units TEXT NOT NULL,           -- JSON list of changes
  summary TEXT NOT NULL,         -- JSON: warnings, builds
  created REAL NOT NULL,
  PRIMARY KEY(task, number)
);
CREATE TABLE IF NOT EXISTS actions(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,       -- chosen by the client, so retries are idempotent
  task TEXT NOT NULL,
  round INTEGER NOT NULL,
  kind TEXT NOT NULL,            -- accept | reject | comment
  changes TEXT NOT NULL,         -- JSON list of change ids
  body TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,          -- applying | applied | undoing | undone | failed
  detail TEXT NOT NULL DEFAULT '{}',
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS writes(  -- file writes of an action, journaled before they happen
  action TEXT NOT NULL,
  phase TEXT NOT NULL,           -- apply | undo
  path TEXT NOT NULL,
  expected BLOB,                 -- contents before the write; NULL = file absent
  target BLOB,                   -- contents after the write; NULL = file removed
  PRIMARY KEY(action, phase, path)
);
CREATE TABLE IF NOT EXISTS messages(  -- what the agent reads with `feedback`
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  round INTEGER,
  kind TEXT NOT NULL,            -- accept | reject | comment | note | undo
  action TEXT,
  body TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL DEFAULT '{}',
  created REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs(
  id TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  status TEXT NOT NULL,          -- queued | running | done | failed
  phase TEXT NOT NULL DEFAULT '',
  result TEXT NOT NULL DEFAULT '{}',
  created REAL NOT NULL,
  finished REAL
);
CREATE INDEX IF NOT EXISTS actions_by_task ON actions(task, round);
CREATE INDEX IF NOT EXISTS messages_by_task ON messages(task, id);
CREATE INDEX IF NOT EXISTS jobs_by_task ON jobs(task, created);
'''
JSON_COLUMNS = {'scope', 'units', 'summary', 'changes', 'detail', 'data', 'result'}


def row(record):
    if record is None:
        return None
    value = dict(record)
    for key in JSON_COLUMNS & value.keys():
        value[key] = json.loads(value[key])
    return value


class Store:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path, timeout=30)
        try:
            db.execute('PRAGMA journal_mode=WAL')
            db.executescript(SCHEMA)
        finally:
            db.close()

    @contextmanager
    def transaction(self):
        """One immediate transaction; committed when the block succeeds."""
        db = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        db.row_factory = sqlite3.Row
        try:
            db.execute('BEGIN IMMEDIATE')
            try:
                yield db
            except BaseException:
                db.execute('ROLLBACK')
                raise
            db.execute('COMMIT')
        finally:
            db.close()

    def one(self, query, *args):
        with self.transaction() as db:
            return row(db.execute(query, args).fetchone())

    def all(self, query, *args):
        with self.transaction() as db:
            return [row(r) for r in db.execute(query, args)]

    def execute(self, query, *args):
        with self.transaction() as db:
            return db.execute(query, args).lastrowid
