#!/usr/bin/env node
// scripts/diagnose.js
// Run this to diagnose why the bot is not responding.
// Usage: node scripts/diagnose.js https://your-project.vercel.app
'use strict';

const TOKEN       = '7887030703:AAFaQr02plI_tPul8Dnw7s9HU1yQkUawy6M';
const DEPLOY_URL  = process.argv[2] || '';

(async () => {
  console.log('\n=== taskctl Bot Diagnostics ===\n');

  // 1. Check bot token is valid
  console.log('1. Checking bot token with Telegram...');
  try {
    const r    = await fetch(`https://api.telegram.org/bot${TOKEN}/getMe`);
    const data = await r.json();
    if (data.ok) {
      console.log(`   ✅ Bot is valid: @${data.result.username} (${data.result.first_name})`);
    } else {
      console.log(`   ❌ Invalid token: ${data.description}`);
      process.exit(1);
    }
  } catch (e) {
    console.log(`   ❌ Network error: ${e.message}`);
    process.exit(1);
  }

  // 2. Check current webhook status
  console.log('\n2. Checking registered webhook...');
  try {
    const r    = await fetch(`https://api.telegram.org/bot${TOKEN}/getWebhookInfo`);
    const data = await r.json();
    const info = data.result;
    if (!info.url) {
      console.log('   ❌ NO WEBHOOK REGISTERED — this is why the bot is silent!');
      console.log('   → Run:  node scripts/setup-webhook.js https://your-project.vercel.app');
    } else {
      console.log(`   ✅ Webhook URL: ${info.url}`);
      console.log(`   Pending updates: ${info.pending_update_count}`);
      if (info.last_error_message) {
        console.log(`   ⚠️  Last error: ${info.last_error_message}`);
        console.log(`   ⚠️  Error time: ${new Date(info.last_error_date * 1000).toISOString()}`);
      } else {
        console.log('   No recent errors reported by Telegram.');
      }
    }
  } catch (e) {
    console.log(`   ❌ Network error: ${e.message}`);
  }

  // 3. Test the deployed /api/telegram endpoint (if URL provided)
  if (DEPLOY_URL) {
    const endpoint = DEPLOY_URL.replace(/\/$/, '') + '/api/telegram';
    console.log(`\n3. Testing deployed endpoint: ${endpoint}`);
    try {
      // Send a GET — should get 405 Method Not Allowed (proves the function is live)
      const r = await fetch(endpoint, { method: 'GET' });
      if (r.status === 405) {
        console.log('   ✅ Endpoint is alive (returned 405 for GET — correct behaviour)');
      } else if (r.status === 404) {
        console.log('   ❌ 404 — endpoint not found. Did the Vercel deployment succeed?');
        console.log('   → Check your Vercel dashboard for deployment errors.');
      } else {
        const body = await r.text();
        console.log(`   ⚠️  Unexpected status ${r.status}: ${body.slice(0, 200)}`);
      }
    } catch (e) {
      console.log(`   ❌ Could not reach endpoint: ${e.message}`);
    }
  } else {
    console.log('\n3. Skipped endpoint test (no URL given). Re-run with your Vercel URL:');
    console.log('   node scripts/diagnose.js https://your-project.vercel.app');
  }

  console.log('\n=== Next Steps ===');
  console.log('If webhook is missing, register it:');
  console.log('  node scripts/setup-webhook.js https://your-project.vercel.app\n');
  console.log('If webhook exists but errors are shown, check Vercel logs:');
  console.log('  vercel logs --follow\n');
  console.log('Make sure these env vars are set in Vercel dashboard:');
  console.log('  DATABASE_URL, TELEGRAM_BOT_TOKEN\n');
})();
