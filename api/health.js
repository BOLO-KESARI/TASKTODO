// api/health.js
// Health check endpoint for taskctl.
// Returns the overall status of the service (database connectivity, env-var presence).
// Useful for uptime monitors (UptimeRobot, BetterStack, etc.)
//
// Endpoint:
//   GET /api/health
//
// Response:
//   200 { status: "ok",      db: true,  envOk: true,  latencyMs: 12, ts: 1715000000000 }
//   503 { status: "degraded", db: false, envOk: true, error: "...",  ts: ... }
//
// No auth required — this is intentionally public.

'use strict';

const { neon } = require('@neondatabase/serverless');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

  if (req.method === 'OPTIONS' || req.method === 'HEAD') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const envOk = !!(process.env.DATABASE_URL && process.env.TELEGRAM_BOT_TOKEN);
  const checks = {
    db:            false,
    telegram:      !!process.env.TELEGRAM_BOT_TOKEN,
    cronSecret:    !!process.env.CRON_SECRET,
    webhookSecret: !!process.env.TELEGRAM_WEBHOOK_SECRET
  };

  let dbError    = null;
  let latencyMs  = null;

  // Ping the database
  if (process.env.DATABASE_URL) {
    const t0 = Date.now();
    try {
      const db = neon(process.env.DATABASE_URL);
      await db`SELECT 1`;
      checks.db  = true;
      latencyMs  = Date.now() - t0;
    } catch (err) {
      dbError   = err.message;
      latencyMs = Date.now() - t0;
    }
  }

  const allOk = checks.db && envOk;
  const body  = {
    status:    allOk ? 'ok' : 'degraded',
    checks,
    latencyMs,
    ts:        Date.now(),
    ...(dbError ? { dbError } : {})
  };

  return res.status(allOk ? 200 : 503).json(body);
};
