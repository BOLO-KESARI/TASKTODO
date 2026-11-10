// api/keys.js
// API Key management backend for taskctl
// Stores named developer API keys in Neon Postgres.
// Keys are hashed (SHA-256) before storage — the plaintext is returned ONCE at creation time only.
//
// Endpoints:
//   GET    /api/keys             — list all keys (name, prefix, createdAt) — plaintext never returned
//   POST   /api/keys             — create a new key — returns { id, name, key } once only
//   DELETE /api/keys?id=<id>     — revoke a key by id
//
// Auth: master password via X-Todo-Password header (same as /api/tasks)
//
// Key validation helper: exported as module.exports.verifyKey(rawKey, db) for use in other routes.

'use strict';

const { neon } = require('@neondatabase/serverless');

// ── helpers ───────────────────────────────────────────────────────────────────
function getDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');
  return neon(process.env.DATABASE_URL);
}

function passwordOk(req) {
  const expected = process.env.TODO_PASSWORD;
  if (!expected) return true; // no master password → open
  return String(req.headers['x-todo-password'] || '') === expected;
}

/** SHA-256 of a string, returned as lowercase hex. Works in Node ≥ 18 (Web Crypto API). */
async function sha256(str) {
  const enc  = new TextEncoder().encode(str);
  const buf  = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Generate a cryptographically random API key: tsk_<64 hex chars> */
function generateRawKey() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return 'tsk_' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Short ID: timestamp base-36 + 4 random chars */
function shortId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ── schema ────────────────────────────────────────────────────────────────────
async function ensureTable(db) {
  await db`
    CREATE TABLE IF NOT EXISTS api_keys (
      id          TEXT    PRIMARY KEY,
      name        TEXT    NOT NULL,
      key_hash    TEXT    NOT NULL UNIQUE,
      key_prefix  TEXT    NOT NULL,
      created_at  BIGINT  NOT NULL,
      last_used   BIGINT
    )
  `;
}

// ── exported helper: verify a raw key (used by other API routes) ──────────────
/**
 * Returns true if the raw key matches a stored api_keys row.
 * Usage in another route:
 *   const { verifyKey } = require('./keys');
 *   if (!(await verifyKey(rawKey, db))) return res.status(401).json({ error: 'unauthorized' });
 */
async function verifyKey(rawKey, db) {
  if (!rawKey || !rawKey.startsWith('tsk_')) return false;
  const hash = await sha256(rawKey);
  const rows = await db`SELECT id FROM api_keys WHERE key_hash = ${hash} LIMIT 1`;
  if (!rows.length) return false;
  // Update last_used asynchronously (don't block the response)
  db`UPDATE api_keys SET last_used = ${Date.now()} WHERE key_hash = ${hash}`.catch(() => {});
  return true;
}

// ── main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Todo-Password');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!passwordOk(req))        return res.status(401).json({ error: 'unauthorized' });

  let db;
  try {
    db = getDb();
  } catch {
    return res.status(500).json({ error: 'DATABASE_URL not configured' });
  }

  try {
    await ensureTable(db);

    // ── GET /api/keys — list all keys (safe fields only) ──────────────────────
    if (req.method === 'GET') {
      const rows = await db`
        SELECT id, name, key_prefix, created_at, last_used
        FROM   api_keys
        ORDER  BY created_at DESC
      `;
      return res.status(200).json({
        keys: rows.map(r => ({
          id:         r.id,
          name:       r.name,
          prefix:     r.key_prefix,   // e.g. "tsk_a1b2c3…" (first 16 chars)
          createdAt:  Number(r.created_at),
          lastUsed:   r.last_used ? Number(r.last_used) : null
        }))
      });
    }

    // ── POST /api/keys — create a new key ─────────────────────────────────────
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const name = String(body.name || '').trim();
      if (!name) return res.status(400).json({ error: 'name is required' });
      if (name.length > 80) return res.status(400).json({ error: 'name too long (max 80 chars)' });

      const rawKey   = generateRawKey();
      const hash     = await sha256(rawKey);
      const prefix   = rawKey.slice(0, 16) + '…';
      const id       = shortId();
      const now      = Date.now();

      await db`
        INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at)
        VALUES (${id}, ${name}, ${hash}, ${prefix}, ${now})
      `;

      return res.status(201).json({
        id,
        name,
        prefix,
        createdAt: now,
        // Returned once only — never stored in plaintext
        key: rawKey
      });
    }

    // ── DELETE /api/keys?id=<id> — revoke a key ───────────────────────────────
    if (req.method === 'DELETE') {
      const id = String(req.query?.id || '').trim();
      if (!id) return res.status(400).json({ error: 'id query param required' });

      const result = await db`DELETE FROM api_keys WHERE id = ${id} RETURNING id`;
      if (!result.length) return res.status(404).json({ error: 'key not found' });
      return res.status(200).json({ ok: true, revoked: id });
    }

    res.setHeader('Allow', 'GET, POST, DELETE, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });

  } catch (err) {
    console.error('[keys] Error:', err);
    return res.status(500).json({ error: 'server error' });
  }
};

// Export verifyKey for use in other routes
module.exports.verifyKey = verifyKey;
