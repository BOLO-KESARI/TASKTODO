// api/reminders.js
// Vercel Cron Job: runs once daily at 08:00 UTC (configured in vercel.json).
// Sends an active-task summary to every Telegram chat that has reminders enabled.
// Compatible with Vercel Hobby plan (one cron execution per day).

'use strict';

const { neon } = require('@neondatabase/serverless');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const pad = n => String(n).padStart(2, '0');

function todayStr(offsetDays) {
  offsetDays = offsetDays || 0;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function shortDate(iso) {
  if (!iso) return '';
  const parts = iso.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2])
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const PRI_ICON = { high: '🔴', medium: '🟡', low: '🟢' };

function buildReminderMessage(tasks) {
  const today    = todayStr(0);
  const active   = tasks.filter(function(t) { return !t.completed; });
  const overdue  = active.filter(function(t) { return t.dueDate && t.dueDate < today; });
  const dueToday = active.filter(function(t) { return t.dueDate === today; });
  const upcoming = active.filter(function(t) { return t.dueDate && t.dueDate > today; });

  if (!active.length) {
    return '☀️ <b>Good morning!</b>\n\nYou have no active tasks. Enjoy your day! 🎉';
  }

  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  let msg = `☀️ <b>Daily Reminder — ${dateStr}</b>\n\n`;

  if (overdue.length) {
    msg += `⚠️ <b>Overdue (${overdue.length})</b>\n`;
    overdue.slice(0, 5).forEach(function(t) {
      msg += `• ${t.emoji || '📌'} <b>${t.title}</b> · was due ${shortDate(t.dueDate)}\n`;
    });
    if (overdue.length > 5) msg += `  <i>…and ${overdue.length - 5} more</i>\n`;
    msg += '\n';
  }

  if (dueToday.length) {
    msg += `📅 <b>Due Today (${dueToday.length})</b>\n`;
    dueToday.slice(0, 5).forEach(function(t) {
      const pri = PRI_ICON[t.priority] || '🟡';
      msg += `• ${t.emoji || '📌'} ${pri} <b>${t.title}</b>\n`;
    });
    if (dueToday.length > 5) msg += `  <i>…and ${dueToday.length - 5} more</i>\n`;
    msg += '\n';
  }

  if (upcoming.length) {
    msg += `🔜 <b>Upcoming (${upcoming.length})</b>\n`;
    upcoming.slice(0, 3).forEach(function(t) {
      msg += `• ${t.emoji || '📌'} <b>${t.title}</b> · 📅 ${shortDate(t.dueDate)}\n`;
    });
    if (upcoming.length > 3) msg += `  <i>…and ${upcoming.length - 3} more</i>\n`;
    msg += '\n';
  }

  msg += `<i>📋 ${active.length} active task${active.length !== 1 ? 's' : ''} total</i>\n`;
  msg += `\nSend /list to see everything · /reminders off to stop these.`;

  return msg;
}

async function sendMessage(chatId, text) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
  });
  return res.json();
}

module.exports = async function handler(req, res) {
  // Vercel Cron sends  Authorization: Bearer <CRON_SECRET>
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers['authorization'] || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }

  if (!process.env.DATABASE_URL || !BOT_TOKEN) {
    return res.status(500).json({ error: 'not configured' });
  }

  const db = neon(process.env.DATABASE_URL);

  try {
    // Ensure tg_chats table exists
    await db`
      CREATE TABLE IF NOT EXISTS tg_chats (
        chat_id  BIGINT  PRIMARY KEY,
        bound_at BIGINT  NOT NULL DEFAULT 0,
        remind_on BOOLEAN NOT NULL DEFAULT TRUE
      )
    `;

    // All chats with reminders enabled
    const chats = await db`
      SELECT chat_id FROM tg_chats WHERE remind_on = TRUE
    `;

    if (!chats.length) {
      return res.status(200).json({ ok: true, sent: 0, reason: 'no subscribers' });
    }

    // Load the shared task list once
    const rows = await db`SELECT tasks FROM todo_store WHERE id = 'default'`;
    const tasks = (rows.length && Array.isArray(rows[0].tasks)) ? rows[0].tasks : [];

    const message = buildReminderMessage(tasks);
    let sent = 0, failed = 0;

    for (const chat of chats) {
      try {
        const result = await sendMessage(Number(chat.chat_id), message);
        if (result.ok) { sent++; } else { failed++; }
      } catch (err) {
        console.error(`[reminders] Failed for chat ${chat.chat_id}:`, err.message);
        failed++;
      }
    }

    console.log(`[reminders] Sent: ${sent}, Failed: ${failed}`);
    return res.status(200).json({ ok: true, sent, failed });
  } catch (err) {
    console.error('[reminders] Error:', err);
    return res.status(500).json({ error: 'server error' });
  }
};
