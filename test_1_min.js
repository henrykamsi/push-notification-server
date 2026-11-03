require('dotenv').config();

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
  const user = await db.execute("SELECT api_key FROM projects LIMIT 1");
  const apiKey = user.results[0].response.result.rows[0][0].value;

  // Calculate time exactly 1 minute from now in UTC
  const now = new Date();
  const future = new Date(now.getTime() + 60 * 1000); // +1 minute
  
  const utcString = future.getUTCFullYear() + '-' + 
                    String(future.getUTCMonth() + 1).padStart(2, '0') + '-' + 
                    String(future.getUTCDate()).padStart(2, '0') + ' ' + 
                    String(future.getUTCHours()).padStart(2, '0') + ':' + 
                    String(future.getUTCMinutes()).padStart(2, '0') + ':' + 
                    String(future.getUTCSeconds()).padStart(2, '0');

  const notifId = `test_1min_${Date.now()}`;

  console.log(`🕒 Current UTC Time: ${now.toISOString()}`);
  console.log(`📅 Scheduled for EXACTLY:   ${utcString}`);
  console.log(`⏳ Waiting 60 seconds for the server to push it...`);

  await db.execute({
      sql: "INSERT INTO notification_history (api_key, notification_id, title, message, scheduled_for, status) VALUES (?, ?, ?, ?, ?, 'scheduled')",
      args: [apiKey, notifId, "⏱️ 1 MINUTE TEST", "The scheduler is working perfectly!", utcString]
  });

  console.log("✅ Inserted into database! Watch your phone.");
}

run().catch(console.error);
