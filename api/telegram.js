// api/telegram.js
// Telegram Bot webhook handler for taskctl
// Handles: /start /list /add /done /undone /delete /upcoming /overdue /remindme /reminders /help
// All task data is stored in the same Neon Postgres table used by the website.
// Deploy on Vercel; register the webhook once with:
//   POST https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-domain>/api/telegram

'use strict';

const { neon } = require('@neondatabase/serverless');

// ── helpers ──────────────────────────────────────────────────────────────────
const sql       = () => neon(process.env.DATABASE_URL);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ROW_ID    = 'default';

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n  => String(n).padStart(2, '0');
function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function shortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── database helpers ──────────────────────────────────────────────────────────
async function ensureTable(db) {
  await db`
    CREATE TABLE IF NOT EXISTS todo_store (
      id         TEXT PRIMARY KEY,
      updated_at BIGINT NOT NULL,
      tasks      JSONB  NOT NULL
    )
  `;
  await db`
    CREATE TABLE IF NOT EXISTS tg_chats (
      chat_id   BIGINT  PRIMARY KEY,
      bound_at  BIGINT  NOT NULL DEFAULT 0,
      remind_on BOOLEAN NOT NULL DEFAULT TRUE
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
}

async function ensureChat(db, chatId) {
  await db`
    INSERT INTO tg_chats (chat_id, bound_at)
    VALUES (${chatId}, ${Date.now()})
    ON CONFLICT (chat_id) DO NOTHING
  `;
}

// ── Telegram API sender ───────────────────────────────────────────────────────
async function tgRequest(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  return res.json();
}

async function sendMessage(chatId, text, extra = {}) {
  return tgRequest('sendMessage', {
    chat_id:    chatId,
    text,
    parse_mode: 'HTML',
    ...extra
  });
}

// ── emoji auto-assign ─────────────────────────────────────────────────────────
const DEFAULT_EMOJI = '📌';
const CATEGORY_EMOJI = { Work: '💼', Study: '📚', Project: '🚀' };
const EMOJI_RULES = [
  ['💻', /\b(?:code|coding|program|bug|debug|deploy|api|frontend|backend|git)\b/i],
  ['📚', /\b(?:study|learn|exam|homework|lecture|course|revision)\b/i],
  ['🏋️', /\b(?:gym|workout|exercise|run|yoga|cardio|swim)\b/i],
  ['🛒', /\b(?:buy|shop|groceries|purchase|order)\b/i],
  ['🤝', /\b(?:meeting|standup|interview|sync|retro)\b/i],
  ['🍳', /\b(?:cook|dinner|lunch|breakfast|bake|recipe)\b/i],
  ['✉️', /\b(?:email|mail|inbox|reply)\b/i],
  ['📞', /\b(?:call|phone|ring)\b/i],
  ['💰', /\b(?:pay|bill|rent|tax|bank|insurance)\b/i],
  ['📖', /\b(?:read|book|chapter|novel)\b/i],
  ['✍️', /\b(?:write|draft|blog|essay|document|notes)\b/i],
  ['🗓️', /\b(?:plan|schedule|organize|agenda)\b/i],
  ['✈️', /\b(?:flight|travel|trip|hotel|vacation|pack)\b/i],
  ['🏥', /\b(?:doctor|dentist|appointment|medicine|hospital)\b/i],
  ['🎉', /\b(?:birthday|party|gift|celebrate|wedding)\b/i],
  ['🔧', /\b(?:fix|repair|install|maintenance)\b/i],
];
function autoEmoji(title, category) {
  for (const [e, re] of EMOJI_RULES) {
    if (re.test(title)) return e;
  }
  return CATEGORY_EMOJI[category] || DEFAULT_EMOJI;
}

// ── priority helpers ──────────────────────────────────────────────────────────
const PRI_MAP   = { h: 'high', m: 'medium', l: 'low', high: 'high', medium: 'medium', low: 'low' };
const PRI_ICON  = { high: '🔴', medium: '🟡', low: '🟢' };
const PRI_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

// ── task formatters ───────────────────────────────────────────────────────────
function taskLine(t, idx) {
  const done  = t.completed ? '✅' : '⬜';
  const pri   = PRI_ICON[t.priority] || '🟡';
  const emoji = t.emoji || '';
  const due   = t.dueDate ? ` · 📅 ${shortDate(t.dueDate)}` : '';
  const cat   = t.category ? ` · <i>${t.category}</i>` : '';
  const over  = !t.completed && t.dueDate && t.dueDate < todayStr() ? ' ⚠️' : '';
  return `${idx}. ${done} ${pri} ${emoji} <b>${t.title}</b>${due}${over}${cat}`;
}

function listMessage(tasks, header) {
  header = header || '📋 <b>Your Tasks</b>';
  if (!tasks.length) return `${header}\n\n<i>No tasks yet. Use /add &lt;task&gt; to create one!</i>`;
  const active    = tasks.filter(t => !t.completed);
  const completed = tasks.filter(t =>  t.completed);
  let out = `${header}\n\n`;
  if (active.length) {
    out += '<b>Active</b>\n';
    active.forEach(function(t, i) { out += taskLine(t, i + 1) + '\n'; });
  }
  if (completed.length) {
    if (active.length) out += '\n';
    out += '<b>Completed</b>\n';
    completed.forEach(function(t, i) { out += taskLine(t, active.length + i + 1) + '\n'; });
  }
  out += `\n<i>${active.length} active · ${completed.length} done</i>`;
  return out;
}

// ── command handlers ──────────────────────────────────────────────────────────
async function handleStart(db, chatId, firstName) {
  await ensureChat(db, chatId);
  const name = firstName ? `, ${firstName}` : '';
  return sendMessage(chatId,
    `👋 <b>Welcome to taskctl${name}!</b>\n\n` +
    `I'm synced with your taskctl website. Every task you manage here also appears on the site — and vice versa.\n\n` +
    `<b>Commands:</b>\n` +
    `/list — show all tasks\n` +
    `/add &lt;title&gt; [#high|#medium|#low] [today|tomorrow|+Nd] — add a task\n` +
    `/done &lt;number&gt; — mark a task done\n` +
    `/undone &lt;number&gt; — mark a task not done\n` +
    `/delete &lt;number&gt; — delete a task\n` +
    `/upcoming — tasks due in the next 7 days\n` +
    `/overdue — show overdue tasks\n` +
    `/reminders on|off — toggle daily reminders (sent at 08:00 UTC)\n` +
    `/help — show this message\n\n` +
    `💡 Tasks sync automatically between Telegram and the website.`
  );
}

async function handleHelp(chatId) {
  return sendMessage(chatId,
    `<b>taskctl Bot Commands</b>\n\n` +
    `/list — show all tasks\n` +
    `/add &lt;title&gt; [#high|#medium|#low] [today|tomorrow|+Nd]\n` +
    `  Examples:\n` +
    `  <code>/add Buy groceries #low tomorrow</code>\n` +
    `  <code>/add Fix bug #high today</code>\n` +
    `  <code>/add Submit report +3d</code>\n` +
    `/done &lt;number&gt; — mark task done (use number from /list)\n` +
    `/undone &lt;number&gt; — mark task not done\n` +
    `/delete &lt;number&gt; — delete a task\n` +
    `/upcoming — tasks due in the next 7 days\n` +
    `/overdue — overdue active tasks\n` +
    `/reminders on|off — daily reminder at 08:00 UTC\n\n` +
    `Tasks stay in sync with the taskctl website automatically.`
  );
}

async function handleList(db, chatId) {
  const tasks = await loadTasks(db);
  return sendMessage(chatId, listMessage(tasks));
}

async function handleAdd(db, chatId, args) {
  if (!args.trim()) {
    return sendMessage(chatId, '⚠️ Please provide a task title.\n\nExample: <code>/add Buy groceries #low tomorrow</code>');
  }

  let priority = 'medium';
  let text = args.replace(/#(high|medium|low|h|m|l)\b/gi, function(_, p) {
    priority = PRI_MAP[p.toLowerCase()] || 'medium';
    return '';
  }).trim();

  let dueDate = '';
  text = text
    .replace(/\btoday\b/i, function() { dueDate = todayStr(0); return ''; })
    .replace(/\btomorrow\b/i, function() { dueDate = todayStr(1); return ''; })
    .replace(/\+(\d+)d\b/i, function(_, n) { dueDate = todayStr(parseInt(n, 10)); return ''; })
    .trim();

  if (!text) {
    return sendMessage(chatId, '⚠️ Task title cannot be empty after removing tags.');
  }

  const tasks = await loadTasks(db);
  const task = {
    id:          uid(),
    title:       text,
    completed:   false,
    priority:    priority,
    category:    '',
    dueDate:     dueDate,
    createdAt:   Date.now(),
    emoji:       autoEmoji(text, ''),
    emojiSource: 'auto',
    source:      'telegram'
  };
  tasks.push(task);
  await saveTasks(db, tasks);

  const dueStr = dueDate ? `\n📅 Due: <b>${shortDate(dueDate)}</b>` : '';
  return sendMessage(chatId,
    `✅ Task added!\n\n${task.emoji} <b>${text}</b>\n${PRI_ICON[priority]} Priority: <b>${PRI_LABEL[priority]}</b>${dueStr}`
  );
}

async function handleDone(db, chatId, args, markDone) {
  const num = parseInt(args.trim(), 10);
  if (!num || num < 1) {
    return sendMessage(chatId, `⚠️ Please provide a task number from /list.\nExample: <code>/${markDone ? 'done' : 'undone'} 2</code>`);
  }
  const tasks = await loadTasks(db);
  const active    = tasks.filter(function(t) { return !t.completed; });
  const completed = tasks.filter(function(t) { return  t.completed; });
  const ordered   = active.concat(completed);
  const task = ordered[num - 1];
  if (!task) {
    return sendMessage(chatId, `⚠️ Task #${num} not found. Use /list to see task numbers.`);
  }
  task.completed = markDone;
  await saveTasks(db, tasks);
  const icon = markDone ? '✅' : '⬜';
  return sendMessage(chatId,
    `${icon} Task marked as <b>${markDone ? 'done' : 'not done'}</b>:\n${task.emoji || '📌'} <b>${task.title}</b>`
  );
}

async function handleDelete(db, chatId, args) {
  const num = parseInt(args.trim(), 10);
  if (!num || num < 1) {
    return sendMessage(chatId, '⚠️ Please provide a task number from /list.\nExample: <code>/delete 3</code>');
  }
  const tasks = await loadTasks(db);
  const active    = tasks.filter(function(t) { return !t.completed; });
  const completed = tasks.filter(function(t) { return  t.completed; });
  const ordered   = active.concat(completed);
  const task = ordered[num - 1];
  if (!task) {
    return sendMessage(chatId, `⚠️ Task #${num} not found. Use /list to see task numbers.`);
  }
  const newTasks = tasks.filter(function(t) { return t.id !== task.id; });
  await saveTasks(db, newTasks);
  return sendMessage(chatId,
    `🗑️ Deleted: ${task.emoji || '📌'} <b>${task.title}</b>`
  );
}

async function handleUpcoming(db, chatId) {
  const tasks = await loadTasks(db);
  const today  = todayStr(0);
  const in7    = todayStr(7);
  const upcoming = tasks.filter(function(t) {
    return !t.completed && t.dueDate && t.dueDate >= today && t.dueDate <= in7;
  });
  if (!upcoming.length) {
    return sendMessage(chatId, '📅 No upcoming tasks due in the next 7 days.');
  }
  upcoming.sort(function(a, b) { return a.dueDate.localeCompare(b.dueDate); });
  let out = '📅 <b>Upcoming (next 7 days)</b>\n\n';
  upcoming.forEach(function(t, i) { out += taskLine(t, i + 1) + '\n'; });
  return sendMessage(chatId, out);
}

async function handleOverdue(db, chatId) {
  const tasks = await loadTasks(db);
  const today   = todayStr(0);
  const overdue = tasks.filter(function(t) {
    return !t.completed && t.dueDate && t.dueDate < today;
  });
  if (!overdue.length) {
    return sendMessage(chatId, '🎉 No overdue tasks!');
  }
  overdue.sort(function(a, b) { return a.dueDate.localeCompare(b.dueDate); });
  let out = '⚠️ <b>Overdue Tasks</b>\n\n';
  overdue.forEach(function(t, i) { out += taskLine(t, i + 1) + '\n'; });
  return sendMessage(chatId, out);
}

// /remindme is retired on the Hobby plan — redirect users to /reminders
async function handleRemindMe(chatId) {
  return sendMessage(chatId,
    `⏰ Daily reminders are sent at <b>08:00 UTC</b> every morning.\n\n` +
    `Use /reminders on to enable them, or /reminders off to disable.`
  );
}

async function handleReminders(db, chatId, args) {
  const val = args.trim().toLowerCase();
  if (val !== 'on' && val !== 'off') {
    return sendMessage(chatId,
      '⚠️ Usage: <code>/reminders on</code> or <code>/reminders off</code>\n\n' +
      'Reminders are sent at <b>08:00 UTC</b> every morning.'
    );
  }
  const on = val === 'on';
  await db`
    INSERT INTO tg_chats (chat_id, bound_at, remind_on)
    VALUES (${chatId}, ${Date.now()}, ${on})
    ON CONFLICT (chat_id) DO UPDATE SET remind_on = ${on}
  `;
  return sendMessage(chatId,
    on
      ? '🔔 Daily reminders <b>enabled</b>.\nYou\'ll get a task digest every morning at <b>08:00 UTC</b>.'
      : '🔕 Daily reminders <b>disabled</b>. Send /reminders on to re-enable.'
  );
}

// ── main handler ──────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const header = req.headers['x-telegram-bot-api-secret-token'];
    if (header !== secret) return res.status(403).json({ error: 'forbidden' });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method not allowed' });
  }

  const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  if (!update || !update.message) return res.status(200).json({ ok: true });

  const msg    = update.message;
  const chatId = msg.chat.id;
  const text   = (msg.text || '').trim();
  const from   = msg.from || {};

  if (!text.startsWith('/')) return res.status(200).json({ ok: true });

  if (!process.env.DATABASE_URL || !BOT_TOKEN) {
    await sendMessage(chatId, '⚠️ Bot is not fully configured. Please contact the admin.');
    return res.status(200).json({ ok: true });
  }

  const db = sql();
  try {
    await ensureTable(db);

    const parts  = text.split(/\s+/);
    const rawCmd = parts[0];
    const args   = parts.slice(1).join(' ');
    const cmd    = rawCmd.split('@')[0].toLowerCase();

    switch (cmd) {
      case '/start':     await handleStart(db, chatId, from.first_name); break;
      case '/help':      await handleHelp(chatId); break;
      case '/list':      await handleList(db, chatId); break;
      case '/add':       await handleAdd(db, chatId, args); break;
      case '/done':      await handleDone(db, chatId, args, true); break;
      case '/undone':    await handleDone(db, chatId, args, false); break;
      case '/delete':
      case '/del':       await handleDelete(db, chatId, args); break;
      case '/upcoming':  await handleUpcoming(db, chatId); break;
      case '/overdue':   await handleOverdue(db, chatId); break;
      case '/remindme':  await handleRemindMe(chatId); break;  // retired — 08:00 UTC fixed
      case '/reminders': await handleReminders(db, chatId, args); break;
      default:
        await sendMessage(chatId, `❓ Unknown command: <code>${cmd}</code>\n\nUse /help to see all commands.`);
    }
  } catch (err) {
    console.error('[telegram] Error:', err);
    try { await sendMessage(chatId, '⚠️ An error occurred. Please try again.'); } catch (_) { /* swallow */ }
  }

  return res.status(200).json({ ok: true });
};
