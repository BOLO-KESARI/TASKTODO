// api/task.js
// Per-task REST API for taskctl — operate on individual tasks by ID.
// Complements /api/tasks (which GET/PUTs the full list).
//
// Endpoints:
//   GET    /api/task?id=<id>     — fetch a single task by ID
//   PATCH  /api/task?id=<id>     — update specific fields of a task (partial update)
//   DELETE /api/task?id=<id>     — delete a single task by ID
//
// Auth: X-Todo-Password header (same as /api/tasks)
// All writes are atomic: read → mutate → write in a single flow.

'use strict';

const { neon } = require('@neondatabase/serverless');

const ROW_ID = 'default';

function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  return neon(process.env.DATABASE_URL);
}

function passwordOk(req) {
  const expected = process.env.TODO_PASSWORD;
  if (!expected) return true;
  return String(req.headers['x-todo-password'] || '') === expected;
}

// ── DB helpers ────────────────────────────────────────────────────────────────
async function ensureTable(db) {
  await db`
    CREATE TABLE IF NOT EXISTS todo_store (
      id         TEXT   PRIMARY KEY,
      updated_at BIGINT NOT NULL,
      tasks      JSONB  NOT NULL
    )
  `;
}

async function loadTasks(db) {
  const rows = await db`SELECT tasks FROM todo_store WHERE id = ${ROW_ID}`;
  if (!rows.length || !rows[0].tasks) return [];
  const t = rows[0].tasks;
  return Array.isArray(t) ? t : [];
}

async function saveTasks(db, tasks) {
  const updatedAt = Date.now();
  await db`
    INSERT INTO todo_store (id, updated_at, tasks)
    VALUES (${ROW_ID}, ${updatedAt}, ${JSON.stringify(tasks)}::jsonb)
    ON CONFLICT (id) DO UPDATE
      SET updated_at = EXCLUDED.updated_at,
          tasks      = EXCLUDED.tasks
  `;
  return updatedAt;
}

// ── PATCH validation: only allow safe, known fields ───────────────────────────
const PATCHABLE_FIELDS = new Set([
  'title', 'completed', 'priority', 'category', 'dueDate',
  'description', 'emoji', 'emojiSource'
]);

function sanitizePatch(body) {
  const patch = {};
  for (const [k, v] of Object.entries(body)) {
    if (!PATCHABLE_FIELDS.has(k)) continue;
    if (k === 'title'       && (typeof v !== 'string' || !v.trim())) continue;
    if (k === 'completed'   && typeof v !== 'boolean') continue;
    if (k === 'priority'    && !['high', 'medium', 'low'].includes(v)) continue;
    if (k === 'dueDate'     && v !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
    patch[k] = (k === 'title') ? v.trim() : v;
  }
  return patch;
}

// ── main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Todo-Password');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!passwordOk(req))        return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'database not connected' });

  const id = String(req.query?.id || '').trim();
  if (!id) return res.status(400).json({ error: 'id query param is required' });

  const db = getDb();
  try {
    await ensureTable(db);
    const tasks = await loadTasks(db);

    // ── GET /api/task?id=<id> ─────────────────────────────────────────────────
    if (req.method === 'GET') {
      const task = tasks.find(t => t.id === id);
      if (!task) return res.status(404).json({ error: 'task not found' });
      return res.status(200).json({ task });
    }

    // ── PATCH /api/task?id=<id> ───────────────────────────────────────────────
    if (req.method === 'PATCH') {
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return res.status(404).json({ error: 'task not found' });

      const body  = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const patch = sanitizePatch(body);

      if (!Object.keys(patch).length) {
        return res.status(400).json({ error: 'no patchable fields provided', allowed: [...PATCHABLE_FIELDS] });
      }

      tasks[idx] = { ...tasks[idx], ...patch };
      const updatedAt = await saveTasks(db, tasks);

      return res.status(200).json({ ok: true, task: tasks[idx], updatedAt });
    }

    // ── DELETE /api/task?id=<id> ──────────────────────────────────────────────
    if (req.method === 'DELETE') {
      const idx = tasks.findIndex(t => t.id === id);
      if (idx === -1) return res.status(404).json({ error: 'task not found' });

      const [removed] = tasks.splice(idx, 1);
      const updatedAt = await saveTasks(db, tasks);

      return res.status(200).json({ ok: true, deleted: removed, updatedAt });
    }

    res.setHeader('Allow', 'GET, PATCH, DELETE, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });

  } catch (err) {
    console.error('[task] Error:', err);
    return res.status(500).json({ error: 'server error' });
  }
};
