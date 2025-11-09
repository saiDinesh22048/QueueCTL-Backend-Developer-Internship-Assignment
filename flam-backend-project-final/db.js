
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import crypto from 'crypto';

const DB_PATH = './queue.db';

class Database {
  constructor() {
    this.db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        console.error('Error opening database:', err);
      } else {
        this.init();
      }
    });
    this.allAsync = promisify(this.db.all.bind(this.db));
    this.getAsync = promisify(this.db.get.bind(this.db));
    this.runAsync = promisify(this.db.run.bind(this.db));
    this.execAsync = promisify(this.db.exec.bind(this.db));
  }

  init() {
    const initSQL = `
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;  -- Retry locks for 5s

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        command TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        next_attempt_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO config (key, value) VALUES ('max_retries', '3');
      INSERT OR IGNORE INTO config (key, value) VALUES ('backoff_base', '2');

      CREATE TABLE IF NOT EXISTS workers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pid INTEGER NOT NULL,
        started_at TEXT NOT NULL
      );
    `;
    this.execAsync(initSQL).catch(console.error);
  }

  async getConfig(key) {
    const row = await this.getAsync('SELECT value FROM config WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  async setConfig(key, value) {
    await this.runAsync('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)', [key, value]);
  }

  async enqueueJob(jobData) {
    const now = new Date().toISOString();
    const id = jobData.id || crypto.randomUUID();
    if (!jobData.id) jobData.id = id;
    jobData.state = jobData.state || 'pending';
    jobData.attempts = jobData.attempts || 0;
    jobData.max_retries = jobData.max_retries || parseInt(await this.getConfig('max_retries'));
    jobData.created_at = jobData.created_at || now;
    jobData.updated_at = jobData.updated_at || now;
    jobData.next_attempt_at = jobData.next_attempt_at || now;

    try {
      await this.runAsync(
        `INSERT INTO jobs (id, command, state, attempts, max_retries, created_at, updated_at, next_attempt_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          jobData.id,
          jobData.command,
          jobData.state,
          jobData.attempts,
          jobData.max_retries,
          jobData.created_at,
          jobData.updated_at,
          jobData.next_attempt_at
        ]
      );
      return id;
    } catch (err) {
      if (err.message.includes('UNIQUE constraint failed')) {
        throw new Error(`Job ID ${id} already exists`);
      }
      throw err;
    }
  }

  async getJob(jobId) {
    const row = await this.getAsync(
      'SELECT id, command, state, attempts, max_retries, created_at, updated_at, next_attempt_at FROM jobs WHERE id = ?',
      [jobId]
    );
    return row ? {
      id: row.id,
      command: row.command,
      state: row.state,
      attempts: row.attempts,
      max_retries: row.max_retries,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_attempt_at: row.next_attempt_at
    } : null;
  }

  async updateJob(jobId, updates) {
    const now = new Date().toISOString();
    const setClause = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    const values = [...Object.values(updates), now, jobId];
    await this.runAsync(
      `UPDATE jobs SET ${setClause}, updated_at = ? WHERE id = ?`,
      values
    );
  }

  async listJobs(state = null) {
    let query = 'SELECT id, command, state, attempts, max_retries, created_at, updated_at, next_attempt_at FROM jobs';
    const params = [];
    if (state) {
      query += ' WHERE state = ?';
      params.push(state);
    }
    query += ' ORDER BY created_at DESC';
    const rows = await this.allAsync(query, params);
    return rows.map(row => ({
      id: row.id,
      command: row.command,
      state: row.state,
      attempts: row.attempts,
      max_retries: row.max_retries,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_attempt_at: row.next_attempt_at
    }));
  }

  async getStatus() {
    const states = ['pending', 'processing', 'completed', 'failed', 'dead'];
    const counts = {};
    for (const state of states) {
      const row = await this.getAsync('SELECT COUNT(*) as count FROM jobs WHERE state = ?', [state]);
      counts[state] = row ? row.count : 0;
    }

    const rows = await this.allAsync('SELECT pid FROM workers');
    const pids = rows.map(r => r.pid).filter(pid => pid > 0);
    let activeWorkers = 0;
    for (const pid of pids) {
      try {
        process.kill(pid, 0);
        activeWorkers++;
      } catch {}
    }
    counts.active_workers = activeWorkers;

    return counts;
  }

  async startWorkers(count) {
    const { spawn } = await import('child_process');
    const pids = [];
    const now = new Date().toISOString();

    for (let i = 0; i < count; i++) {
      const worker = spawn('node', ['worker.js'], { stdio: 'inherit' });
      pids.push(worker.pid);
      await this.runAsync('INSERT INTO workers (pid, started_at) VALUES (?, ?)', [worker.pid, now]);
      worker.unref();
    }
    return pids;
  }

  async stopWorkers() {
    const rows = await this.allAsync('SELECT pid FROM workers');
    const pids = rows.map(r => r.pid).filter(pid => pid > 0);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (err) {
      }
    }

  }

  async dlqList() {
    return this.listJobs('dead');
  }

  async dlqRetry(jobId) {
    const job = await this.getJob(jobId);
    if (!job || job.state !== 'dead') {
      throw new Error(`Job ${jobId} not in DLQ`);
    }
    const now = new Date().toISOString();
    await this.updateJob(jobId, { state: 'pending', attempts: 0, next_attempt_at: now });
  }


  async acquireJob(now) {
    try {
      await this.runAsync('BEGIN IMMEDIATE');
      const row = await this.getAsync(
        'SELECT id FROM jobs WHERE (state = "pending" OR state = "failed") AND next_attempt_at <= ? LIMIT 1',
        [now]
      );
      if (!row) {
        await this.runAsync('ROLLBACK');
        return null;
      }
      await this.runAsync('UPDATE jobs SET state = "processing" WHERE id = ?', [row.id]);
      await this.runAsync('COMMIT');
      return row.id;
    } catch (err) {
      try {
        await this.runAsync('ROLLBACK');
      } catch {}
      throw err;
    }
  }

  close() {
    this.db.close();
  }
}

export default new Database();