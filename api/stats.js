// api/stats.js
// Dashboard / analytics stats endpoint for taskctl.
// Returns aggregate counts, breakdowns, and streaks — no task content is returned.
//
// Endpoint:
//   GET /api/stats
//
// Response:
//   {
//     total, completed, active, overdue, dueToday,
//     completionRate,              // 0-100 percentage
//     byPriority: { high, medium, low },
//     byCategory: { Work: 3, Study: 1, … },
//     upcoming7:  <count due in next 7 days>,
//     recentlyCompleted: [ { id, title, emoji } ],   // last 5 completed
//     generatedAt: <unix ms>
//   }
//
// Auth: X-Todo-Password header

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

function pad(n) { return String(n).padStart(2, '0'); }

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Todo-Password');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!passwordOk(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.DATABASE_URL) return res.status(500).json({ error: 'database not connected' });

  try {
    const db   = getDb();
    const rows = await db`SELECT tasks FROM todo_store WHERE id = ${ROW_ID}`;
    const tasks = (rows.length && Array.isArray(rows[0].tasks)) ? rows[0].tasks : [];

    const today = todayStr(0);
    const in7   = todayStr(7);

    const completed = tasks.filter(t =>  t.completed);
    const active    = tasks.filter(t => !t.completed);
    const overdue   = active.filter(t => t.dueDate && t.dueDate < today);
    const dueToday  = active.filter(t => t.dueDate === today);
    const upcoming7 = active.filter(t => t.dueDate && t.dueDate > today && t.dueDate <= in7);

    const byPriority = { high: 0, medium: 0, low: 0 };
    const byCategory = {};
    for (const t of tasks) {
      const p = t.priority || 'medium';
      if (p in byPriority) byPriority[p]++;
      if (t.category) byCategory[t.category] = (byCategory[t.category] || 0) + 1;
    }

    const total          = tasks.length;
    const completionRate = total ? Math.round((completed.length / total) * 100) : 0;

    // Last 5 completed (most recently created)
    const recentlyCompleted = [...completed]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 5)
      .map(t => ({ id: t.id, title: t.title, emoji: t.emoji || '📌' }));

    return res.status(200).json({
      total,
      completed:         completed.length,
      active:            active.length,
      overdue:           overdue.length,
      dueToday:          dueToday.length,
      upcoming7:         upcoming7.length,
      completionRate,
      byPriority,
      byCategory,
      recentlyCompleted,
      generatedAt:       Date.now()
    });

  } catch (err) {
    console.error('[stats] Error:', err);
    return res.status(500).json({ error: 'server error' });
  }
};
