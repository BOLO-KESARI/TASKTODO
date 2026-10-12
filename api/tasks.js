// Vercel serverless function: your whole task list lives as one row
// in your Neon Postgres database. Every device that opens your site
// talks to this function; the database connection string never
// reaches the browser.
const { neon } = require('@neondatabase/serverless');

const sql = neon(process.env.DATABASE_URL);
const ROW_ID = 'default';

async function ensureTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS todo_store (
      id TEXT PRIMARY KEY,
      updated_at BIGINT NOT NULL,
      tasks JSONB NOT NULL
    )
  `;
}

function passwordOk(req) {
  const expected = process.env.TODO_PASSWORD;
  if (!expected) return true; // no password configured
  return String(req.headers['x-todo-password'] || '') === expected;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!passwordOk(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'database not connected' });

  try {
    await ensureTable();

    if (req.method === 'GET') {
      const rows = await sql`SELECT updated_at, tasks FROM todo_store WHERE id = ${ROW_ID}`;
      if (!rows.length) return res.status(200).json({ updatedAt: 0, tasks: null });
      return res.status(200).json({ updatedAt: Number(rows[0].updated_at), tasks: rows[0].tasks });
    }

    if (req.method === 'PUT') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      if (!body || !Array.isArray(body.tasks)) return res.status(400).json({ error: 'bad request' });
      const updatedAt = Number(body.updatedAt) || Date.now();
      await sql`
        INSERT INTO todo_store (id, updated_at, tasks)
        VALUES (${ROW_ID}, ${updatedAt}, ${JSON.stringify(body.tasks)}::jsonb)
        ON CONFLICT (id) DO UPDATE SET updated_at = EXCLUDED.updated_at, tasks = EXCLUDED.tasks
      `;
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, PUT');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: 'server error' });
  }
};
