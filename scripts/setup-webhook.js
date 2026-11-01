#!/usr/bin/env node
// scripts/setup-webhook.js
// One-time helper: registers your Vercel deployment URL as the Telegram webhook.
//
// Usage:
//   TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<secret> \
//     node scripts/setup-webhook.js https://your-project.vercel.app

'use strict';

const url    = process.argv[2];
const token  = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET || '';

if (!url || !token) {
  console.error('Usage: TELEGRAM_BOT_TOKEN=<token> node scripts/setup-webhook.js https://your-app.vercel.app');
  process.exit(1);
}

const webhookUrl = `${url.replace(/\/$/, '')}/api/telegram`;
const apiUrl = `https://api.telegram.org/bot${token}/setWebhook`;

const body = {
  url: webhookUrl,
  allowed_updates: ['message'],
  drop_pending_updates: true
};
if (secret) body.secret_token = secret;

(async () => {
  console.log(`\nRegistering webhook: ${webhookUrl}\n`);
  const res  = await fetch(apiUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body)
  });
  const data = await res.json();
  if (data.ok) {
    console.log('✅ Webhook registered successfully!');
    console.log(`   URL: ${webhookUrl}`);
    if (secret) console.log('   Secret: set');
  } else {
    console.error('❌ Telegram returned an error:');
    console.error(data);
    process.exit(1);
  }

  // Also verify with getWebhookInfo
  const info = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  const infoData = await info.json();
  console.log('\nWebhook info:');
  console.log(JSON.stringify(infoData.result, null, 2));
})();
