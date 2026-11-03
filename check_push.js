require('dotenv').config();
const webpush = require('web-push');

webpush.setVapidDetails(
  `mailto:kamsih924@gmail.com`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

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
    console.log("🔍 Fetching subscribers from DB...");
    const res = await db.execute("SELECT endpoint, p256dh, auth FROM subscribers");
    const rows = res.results[0].response.result.rows;

    if (rows.length === 0) {
        console.log("❌ No subscribers found in database.");
        return;
    }

    const endpoint = rows[0][0].value;
    const p256dh = rows[0][1].value;
    const auth = rows[0][2].value;

    console.log("✅ Found Subscriber!");
    console.log("🔗 Endpoint:", endpoint.substring(0, 50) + "...");

    console.log("🚀 Attempting to send a direct push...");
    try {
        await webpush.sendNotification({
            endpoint: endpoint,
            keys: { p256dh: p256dh, auth: auth }
        }, JSON.stringify({
            title: "🔥 Direct Test Push",
            body: "If you see this, your phone is receiving pushes!",
            icon: "/icon.png"
        }));
        console.log("✅ PUSH SENT SUCCESSFULLY! Google accepted the message.");
        console.log("If you still don't see it, your phone's OS is blocking it, or the Service Worker is broken.");
    } catch (err) {
        console.log("❌ PUSH FAILED!");
        console.log("Error Status Code:", err.statusCode);
        console.log("Error Message:", err.message);
        console.log("--> This means your subscription token is DEAD. You must unsubscribe and resubscribe on your phone.");
    }
}
run().catch(console.error);
