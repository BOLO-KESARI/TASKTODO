/**
 * scripts/db-daily-report.js
 * 
 * GitHub Actions end-of-day database health & entries reporter.
 * - Pings database and measures latency
 * - Verifies tables (todo_store, tg_chats)
 * - Fetches all tasks and compiles complete entry details
 * - Sends formatted HTML report to Telegram bot (and console)
 */

'use strict';

const { neon } = require('@neondatabase/serverless');

const DATABASE_URL = process.env.DATABASE_URL;
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPECIFIC_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Helper: send Telegram message using native fetch
async function sendTelegramMessage(token, chatId, text) {
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description || JSON.stringify(data)}`);
  }
  return data;
}

// Split long messages to respect Telegram's 4096 char limit
function chunkMessage(text, limit = 3800) {
  const chunks = [];
  const lines = text.split('\n');
  let current = '';

  for (const line of lines) {
    if ((current + '\n' + line).length > limit) {
      if (current.trim()) chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current.trim()) {
    chunks.push(current);
  }
  return chunks;
}

function formatDate(isoStr) {
  if (!isoStr) return 'No date';
  try {
    const parts = isoStr.split('-').map(Number);
    if (parts.length === 3) {
      const d = new Date(parts[0], parts[1] - 1, parts[2]);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    }
    return isoStr;
  } catch (e) {
    return isoStr;
  }
}

function timeAgo(ms) {
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

async function runReport() {
  const startTime = Date.now();
  console.log('==============================================');
  console.log('   END-OF-DAY DATABASE HEALTH & ENTRIES CHECK  ');
  console.log('==============================================');

  if (!DATABASE_URL) {
    console.error('❌ Error: DATABASE_URL environment variable is missing.');
    process.exit(1);
  }

  if (!BOT_TOKEN) {
    console.warn('⚠️ Warning: TELEGRAM_BOT_TOKEN is not set. Telegram notification will be skipped.');
  }

  const sql = neon(DATABASE_URL);
  let dbHealthy = false;
  let pingMs = 0;
  let dbVersion = 'Unknown';
  let totalTasks = 0;
  let activeTasks = [];
  let completedTasks = [];
  let lastUpdated = null;
  let subscriberChats = [];

  // 1. Health check & Ping
  try {
    const pingStart = Date.now();
    const verRes = await sql`SELECT version(), NOW() as current_time`;
    pingMs = Date.now() - pingStart;
    dbHealthy = true;
    dbVersion = verRes[0]?.version?.split(' ')?.[0] || 'PostgreSQL';
    console.log(`✅ Database connection successful! (Ping latency: ${pingMs}ms)`);
  } catch (err) {
    console.error('❌ Database health check failed:', err.message);
    const failureMsg = `🚨 <b>DATABASE ALERT: UNHEALTHY / DOWN</b>\n\n` +
      `• <b>Time:</b> ${new Date().toISOString()}\n` +
      `• <b>Status:</b> ❌ Unhealthy\n` +
      `• <b>Error:</b> <code>${err.message}</code>\n\n` +
      `Immediate attention recommended!`;
    
    if (BOT_TOKEN && SPECIFIC_CHAT_ID) {
      try {
        await sendTelegramMessage(BOT_TOKEN, SPECIFIC_CHAT_ID, failureMsg);
      } catch (tgErr) {
        console.error('Failed to send failure alert to Telegram:', tgErr.message);
      }
    }
    process.exit(1);
  }

  // 2. Query Tables & Tasks
  try {
    // Check tables
    const storeRows = await sql`
      SELECT id, updated_at, tasks 
      FROM todo_store 
      WHERE id = 'default'
    `;

    if (storeRows.length > 0) {
      lastUpdated = Number(storeRows[0].updated_at);
      const rawTasks = storeRows[0].tasks;
      const tasks = Array.isArray(rawTasks) ? rawTasks : [];
      totalTasks = tasks.length;
      activeTasks = tasks.filter(t => !t.completed);
      completedTasks = tasks.filter(t => t.completed);
    }

    // Check telegram subscribers
    try {
      const chatRows = await sql`SELECT chat_id, remind_on FROM tg_chats`;
      subscriberChats = chatRows.map(r => String(r.chat_id));
    } catch (e) {
      console.log('tg_chats table not found or empty.');
    }
  } catch (err) {
    console.error('❌ Error reading database entries:', err.message);
    process.exit(1);
  }

  // 3. Compile report
  const now = new Date();
  const dateFormatted = now.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const timeFormatted = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

  console.log(`Report Date: ${dateFormatted} at ${timeFormatted}`);
  console.log(`Total tasks in DB: ${totalTasks} (${activeTasks.length} active, ${completedTasks.length} completed)`);

  let report = `📊 <b>End of Day Database Report</b>\n`;
  report += `📅 <i>${dateFormatted} • ${timeFormatted}</i>\n\n`;

  report += `━━━━━━━━━━━━━━━━━━━━━━\n`;
  report += `🩺 <b>DATABASE HEALTH: HEALTHY</b> ✅\n`;
  report += `• <b>Status:</b> Operational\n`;
  report += `• <b>Engine:</b> Neon ${dbVersion}\n`;
  report += `• <b>Latency:</b> ${pingMs} ms\n`;
  report += `• <b>Subscribers:</b> ${subscriberChats.length} Telegram chat(s)\n`;
  if (lastUpdated) {
    report += `• <b>Last Modified:</b> ${timeAgo(lastUpdated)}\n`;
  }
  report += `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

  report += `📋 <b>SUMMARY OF ENTRIES (${totalTasks} Total)</b>\n`;
  report += `• 🟡 Active: <b>${activeTasks.length}</b>\n`;
  report += `• ✅ Completed: <b>${completedTasks.length}</b>\n\n`;

  if (activeTasks.length > 0) {
    report += `📌 <b>ACTIVE TASKS (${activeTasks.length})</b>\n`;
    activeTasks.forEach((t, i) => {
      const priIcon = t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🟢' : '🟡';
      const emoji = t.emoji || '📝';
      const due = t.dueDate ? `📅 ${formatDate(t.dueDate)}` : 'No deadline';
      const cat = t.category ? `[${t.category}]` : '';
      report += `<b>${i + 1}.</b> ${emoji} ${priIcon} <b>${escapeHtml(t.title || 'Untitled')}</b> ${cat}\n`;
      report += `    └ Due: ${due}\n`;
    });
    report += `\n`;
  }

  if (completedTasks.length > 0) {
    report += `✅ <b>COMPLETED TASKS (${completedTasks.length})</b>\n`;
    completedTasks.forEach((t, i) => {
      const emoji = t.emoji || '✔️';
      report += `<s>${i + 1}. ${emoji} ${escapeHtml(t.title || 'Untitled')}</s>\n`;
    });
    report += `\n`;
  }

  if (totalTasks === 0) {
    report += `<i>No tasks currently in the database.</i>\n\n`;
  }

  report += `⚡ <i>Automated check via GitHub Actions</i>`;

  // Output report in GitHub workflow console
  console.log('\n--- TELEGRAM REPORT PREVIEW ---');
  console.log(report.replace(/<[^>]*>/g, ''));
  console.log('-------------------------------\n');

  // 4. Send to Telegram
  if (BOT_TOKEN) {
    const recipients = new Set();
    if (SPECIFIC_CHAT_ID) {
      recipients.add(String(SPECIFIC_CHAT_ID).trim());
    }
    // Also include any chats in database if SPECIFIC_CHAT_ID is not set
    if (recipients.size === 0 && subscriberChats.length > 0) {
      subscriberChats.forEach(id => recipients.add(id));
    }

    if (recipients.size === 0) {
      console.log('⚠️ No Telegram Chat ID specified and no subscribers found in database.');
      console.log('Tip: Set TELEGRAM_CHAT_ID in GitHub Repository Secrets or send /start to your bot.');
    } else {
      const chunks = chunkMessage(report);
      for (const chatId of recipients) {
        console.log(`Sending report to Telegram chat: ${chatId} (${chunks.length} message part(s))...`);
        for (let idx = 0; idx < chunks.length; idx++) {
          try {
            await sendTelegramMessage(BOT_TOKEN, chatId, chunks[idx]);
            console.log(`Part ${idx + 1}/${chunks.length} sent successfully to ${chatId}`);
          } catch (err) {
            console.error(`Failed to send to ${chatId}:`, err.message);
          }
        }
      }
    }
  }

  console.log(`Done in ${Date.now() - startTime}ms.`);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

runReport().catch(err => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
