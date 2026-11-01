// api/reminders.js
// Vercel Cron Job: runs every minute, checks which Telegram chats need a
// daily reminder right now, and sends them their active task list.
//
// Vercel cron calls this endpoint automatically per vercel.json schedule.
// Secure it by checking the CRON_SECRET header Vercel sends.

'use strict';

const { neon } = require('@neondatabase/serverless');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const pad = n => String(n).padStart(2, '0');

function nowHHMM() {
  const d = new Date();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function todayStr(offsetDays) {
  offsetDays = offsetDays || 0;
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function shortDate(iso) {
  if (!iso) return '';
  const parts = iso.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2]).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const PRI_ICON = { high: '🔴', medium: '🟡', low: '🟢' };

function buildReminderMessage(tasks) {
  const today   = todayStr(0);
  const active  = tasks.filter(function(t) { return !t.completed; });
  const overdue = active.filter(function(t) { return t.dueDate && t.dueDate < today; });
  const dueToday= active.filter(function(t) { return t.dueDate === today; });

  if (!active.length) {
    return '☀️ <b>Good morning!</b>\n\nYou have no active tasks. Enjoy your day! 🎉';
  }

  let msg = `☀️ <b>Daily Task Reminder</b>\n\n`;

  if (overdue.length) {
    msg += `⚠️ <b>Overdue (${overdue.length})</b>\n`;
    overdue.slice(0, 5).forEach(function(t) {
      msg += `• ${t.emoji || '📌'} <b>${t.title}</b> · ${shortDate(t.dueDate)}\n`;
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

  const other = active.filter(function(t) {
    return !overdue.includes(t) && !dueToday.includes(t);
  });

  msg += `📋 <b>Total: ${active.length} active task${active.length !== 1 ? 's' : ''}</b>`;
  if (other.length) msg += ` (${other.length} upcoming)`;
  msg += '\n\nSend /list to see everything.';

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
  // Vercel Cron passes the CRON_SECRET as an Authorization Bearer token
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

  const currentTime = nowHHMM();
  const db = neon(process.env.DATABASE_URL);

  try {
    // Ensure tables exist
    await db`
      CREATE TABLE IF NOT EXISTS tg_chats (
        chat_id     BIGINT PRIMARY KEY,
        bound_at    BIGINT NOT NULL DEFAULT 0,
        remind_time TEXT   NOT NULL DEFAULT '08:00',
        remind_on   BOOLEAN NOT NULL DEFAULT TRUE
      )
    `;

    // Find chats whose reminder time matches current UTC HH:MM
    const chats = await db`
      SELECT chat_id, remind_time
      FROM tg_chats
      WHERE remind_on = TRUE AND remind_time = ${currentTime}
    `;

    if (!chats.length) {
      return res.status(200).json({ ok: true, sent: 0, time: currentTime });
    }

    // Load tasks once (shared for all chats — same task list)
    const rows = await db`SELECT tasks FROM todo_store WHERE id = 'default'`;
    const tasks = (rows.length && Array.isArray(rows[0].tasks)) ? rows[0].tasks : [];

    const message = buildReminderMessage(tasks);
    let sent = 0;

    for (const chat of chats) {
      try {
        await sendMessage(Number(chat.chat_id), message);
        sent++;
      } catch (err) {
        console.error(`[reminders] Failed to send to chat ${chat.chat_id}:`, err.message);
      }
    }

    return res.status(200).json({ ok: true, sent: sent, time: currentTime });
  } catch (err) {
    console.error('[reminders] Error:', err);
    return res.status(500).json({ error: 'server error' });
  }
};
