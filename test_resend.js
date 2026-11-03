require('dotenv').config();
const crypto = require('crypto');

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
    return await response.json();
  }
};

async function run() {
    // 1. Get your API key
    const user = await db.execute("SELECT api_key FROM projects LIMIT 1");
    const apiKey = user.results[0].response.result.rows[0][0].value;

    // 2. Get a notification ID from history
    const hist = await db.execute({ sql: "SELECT notification_id FROM notification_history WHERE api_key = ? LIMIT 1", args: [apiKey] });
    if (!hist.results[0].response.result.rows || hist.results[0].response.result.rows.length === 0) {
        console.log("❌ No notifications found in history.");
        return;
    }
    const notifId = hist.results[0].response.result.rows[0][0].value;

    console.log(`🔍 Testing resend for Notification ID: ${notifId}`);
    console.log(`🔑 Using API Key: ${apiKey.substring(0, 20)}...`);

    // 3. Call the Render API directly
    const res = await fetch('https://push-notification-server-5tx2.onrender.com/api/v1/notification/' + notifId + '/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sendly-key': apiKey }
    });

    const data = await res.json();
    console.log("\n📥 SERVER RESPONSE:");
    console.log(JSON.stringify(data, null, 2));
}

run().catch(console.error);
