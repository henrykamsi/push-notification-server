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
    const data = await response.json();
    if (data.results[0].type === "error") console.error("❌ DB Error:", data.results[0].error.message);
    return data;
  }
};

async function run() {
    console.log("🔨 Creating security_logs table...");
    
    await db.execute(\`
        CREATE TABLE IF NOT EXISTS security_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            email TEXT,
            ip_address TEXT,
            device_name TEXT,
            action TEXT DEFAULT 'login',
            status TEXT DEFAULT 'pending',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    \`);
    
    await db.execute(\`
        CREATE TABLE IF NOT EXISTS trusted_ips (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    \`);
    
    console.log("✅ Tables created: security_logs & trusted_ips");
}
run();
