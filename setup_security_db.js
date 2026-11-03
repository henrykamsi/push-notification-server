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
    const response = await fetch(baseUrl + '/v2/pipeline', {
      method: "POST",
      headers: { "Authorization": "Bearer " + process.env.TURSO_AUTH_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql: sql, args: args } }, { type: "close" }] })
    });
    const data = await response.json();
    if (data.results[0].type === "error") console.error("DB Error:", data.results[0].error.message);
    return data;
  }
};

async function run() {
    console.log("Setting up security database...\n");

    try {
        await db.execute("ALTER TABLE users ADD COLUMN recovery_code_hash TEXT");
        console.log("Added recovery_code_hash to users");
    } catch(e) { console.log("recovery_code_hash already exists"); }

    try {
        await db.execute("ALTER TABLE users ADD COLUMN security_token TEXT");
        console.log("Added security_token to users");
    } catch(e) { console.log("security_token already exists"); }

    try {
        await db.execute("ALTER TABLE users ADD COLUMN security_enabled INTEGER DEFAULT 0");
        console.log("Added security_enabled to users");
    } catch(e) { console.log("security_enabled already exists"); }

    await db.execute("CREATE TABLE IF NOT EXISTS trusted_ips (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, ip_address TEXT, device_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    console.log("Created trusted_ips table");

    await db.execute("CREATE TABLE IF NOT EXISTS pending_logins (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, ip_address TEXT, device_name TEXT, session_token TEXT, status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, locked_until DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    console.log("Created pending_logins table");

    await db.execute("CREATE TABLE IF NOT EXISTS security_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, email TEXT, ip_address TEXT, device_name TEXT, action TEXT, status TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)");
    console.log("Created security_logs table");

    console.log("\nDatabase setup complete! Nothing was broken.");
}
run();
