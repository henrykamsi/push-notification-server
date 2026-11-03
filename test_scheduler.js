require('dotenv').config();
const webpush = require('web-push');
const crypto = require('crypto');

// Initialize VAPID
webpush.setVapidDetails(
  `mailto:kamsih924@gmail.com`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Turso DB connection
const db = {
  async execute(query) {
    let sql = typeof query === "string" ? query : query.sql;
    let args = (query.args || []).map(val => {
        if (typeof val === "number") return { type: "float", value: val };
        if (val === null) return { type: "null" };
        return { type: "text", value: String(val) };
    });
    let baseUrl = process.env.TURSO_URL.replace(/\/$/, '').replace('libsql://', 'https://');
    const response = await fetch(`${baseUrl}/v2/pipeline`, {
      method: "POST", headers: { "Authorization": `Bearer ${process.env.TURSO_AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args } }, { type: "close" }] })
    });
    const data = await response.json();
    const resObj = data.results[0].response.result;
    const cols = (resObj.cols || []).map(c => c.name);
    const rows = (resObj.rows || []).map(row => {
      const rowObj = {};
      row.forEach((cell, idx) => { rowObj[cols[idx]] = cell ? cell.value : null; });
      return rowObj;
    });
    return { rows };
  }
};

async function runTest() {
  console.log('🔍 1. Fetching ALL scheduled notifications...');
  const scheduled = await db.execute("SELECT id, api_key, title, message, notification_id, scheduled_for FROM notification_history WHERE status = 'scheduled'");
  
  if (scheduled.rows.length === 0) {
      console.log('❌ NO scheduled notifications found in the database. Please create one in the dashboard first.');
      return;
  }

  const notif = scheduled.rows[0];
  console.log(`✅ Found: "${notif.title}" scheduled for: ${notif.scheduled_for}`);
  console.log(`🕒 Current Local Time: ${new Date().toString()}`);
  console.log(`🕒 Current UTC Time:   ${new Date().toISOString()}`);

  console.log(`\n🔍 2. Checking Subscribers for API Key: ${notif.api_key.substring(0, 20)}...`);
  const subs = await db.execute({ sql: 'SELECT endpoint, p256dh, auth FROM subscribers WHERE api_key = ?', args: [notif.api_key] });
  
  if (subs.rows.length === 0) {
      console.log('❌ NO subscribers found for this app. Make sure you are subscribed on your phone.');
      return;
  }
  console.log(`✅ Found ${subs.rows.length} subscriber(s). Sending test push NOW...`);

  console.log(`\n🔍 3. Sending Push...`);
  const payload = JSON.stringify({
      title: "🔥 TEST: " + notif.title,
      body: notif.message,
      data: { notification_id: notif.notification_id }
  });

  let successCount = 0;
  for (const sub of subs.rows) {
      try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
          successCount++;
          console.log('✅ Push sent successfully to endpoint:', sub.endpoint.substring(0, 30) + '...');
      } catch (err) {
          console.log('❌ PUSH FAILED! Error:', err.message, 'Status:', err.statusCode);
      }
  }

  if (successCount > 0) {
      console.log(`\n🎉 4. SUCCESS! Updating database status to "sent"...`);
      await db.execute({ sql: "UPDATE notification_history SET status = 'sent', sent_at = datetime('now') WHERE id = ?", args: [notif.id] });
      console.log('✅ Database updated. Test complete.');
  } else {
      console.log('\n❌ All pushes failed. Check the error above.');
  }
}

runTest().catch(console.error);
