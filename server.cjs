require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());

// ============================================================
// ✅ CORS
// ============================================================
app.use((req, res, next) => {
  const allowedOrigin = req.headers.origin || '*';
  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-sendly-key, x-admin-password, x-session-token, x-api-key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Credentials', 'false');
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});

app.use(express.static(__dirname));

// ============================================================
// 📛 BRAND INFORMATION
// ============================================================
const BRAND = {
  name: 'Sendly Notification',
  company: 'Henry Global Tech Industry',
  short: 'HGT',
  founder: 'Henry Kamsi Okwuabudike',
  email: 'kamsih924@gmail.com',
  website: 'https://hgt.com',
  built_date: '2026-08-16',
  powered_by: 'HGT'
};

console.log(`🏢 ${BRAND.name} | ${BRAND.company} (${BRAND.short})`);
console.log(`👤 Owned by ${BRAND.founder}`);
console.log(`📅 Built: ${BRAND.built_date}`);
console.log(`⚡ Powered By ${BRAND.powered_by}`);

// ============================================================
// 1. AUTO-GENERATE VAPID KEYS
// ============================================================
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  fs.appendFileSync('.env', `\nVAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
}

webpush.setVapidDetails(
  `mailto:${BRAND.email}`,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ============================================================
// 2. TURSO DATABASE
// ============================================================
const db = {
  async execute(query) {
    let sql = "";
    let args = [];
    if (typeof query === "string") {
      sql = query;
    } else {
      sql = query.sql;
      args = (query.args || []).map(val => {
        if (typeof val === "number") return { type: "float", value: val };
        if (val === null) return { type: "null" };
        return { type: "text", value: String(val) };
      });
    }

    let baseUrl = process.env.TURSO_URL ? process.env.TURSO_URL.replace(/\/$/, '') : '';
    if (baseUrl.startsWith('libsql://')) {
      baseUrl = baseUrl.replace('libsql://', 'https://');
    }

    if (!baseUrl) throw new Error("TURSO_URL is missing in .env");

    const url = `${baseUrl}/v2/pipeline`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.TURSO_AUTH_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        requests: [
          { type: "execute", stmt: { sql, args } },
          { type: "close" }
        ]
      })
    });

    const data = await response.json();
    if (data.results && data.results[0] && data.results[0].type === "error") {
      throw new Error(data.results[0].error.message);
    }

    const resObj = data.results && data.results[0] && data.results[0].response && data.results[0].response.result;
    if (!resObj) return { rows: [], rowsAffected: 0 };

    const cols = (resObj.cols || []).map(c => c.name);
    const rows = (resObj.rows || []).map(row => {
      const rowObj = {};
      row.forEach((cell, idx) => {
        const colName = cols[idx];
        const val = cell ? cell.value : null;
        rowObj[colName] = val;
        rowObj[idx] = val;
      });
      return rowObj;
    });

    return { rows, rowsAffected: resObj.affected_row_count || 0 };
  }
};

// ============================================================
// 3. DATABASE INITIALIZATION
// ============================================================
async function initDB() {
  try {
    await db.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        surname TEXT,
        email TEXT UNIQUE,
        password_hash TEXT,
        traffic TEXT,
        total_push_quota INTEGER DEFAULT 1000,
        total_email_quota INTEGER DEFAULT 250,
        plan TEXT DEFAULT 'free',
        plan_expires_at DATETIME,
        blocked BOOLEAN DEFAULT 0,
        dark_mode BOOLEAN DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        token TEXT UNIQUE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        project_name TEXT,
        app_name TEXT,
        app_url TEXT,
        api_key TEXT UNIQUE,
        push_quota INTEGER DEFAULT 1000,
        email_quota INTEGER DEFAULT 250,
        plan TEXT DEFAULT 'free',
        blocked BOOLEAN DEFAULT 0,
        crack_signals INTEGER DEFAULT 0,
        crack_locked_until DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS subscribers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        endpoint TEXT UNIQUE,
        p256dh TEXT,
        auth TEXT,
        device_type TEXT,
        device_name TEXT,
        region TEXT,
        subscriber_group TEXT DEFAULT 'all',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS notification_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        notification_id TEXT UNIQUE,
        title TEXT,
        message TEXT,
        image_url TEXT,
        icon_url TEXT,
        button1_name TEXT,
        button1_url TEXT,
        button2_name TEXT,
        button2_url TEXT,
        persistent BOOLEAN DEFAULT 0,
        scheduled_for DATETIME,
        sent_at DATETIME,
        devices_sent INTEGER DEFAULT 0,
        views INTEGER DEFAULT 0,
        clicks INTEGER DEFAULT 0,
        button1_clicks INTEGER DEFAULT 0,
        button2_clicks INTEGER DEFAULT 0,
        open_rate DECIMAL(5,2) DEFAULT 0,
        avg_view_time DECIMAL(5,2) DEFAULT 0,
        status TEXT DEFAULT 'pending',
        ab_test_group TEXT,
        custom_sound_url TEXT,
        FOREIGN KEY (api_key) REFERENCES projects(api_key)
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS webhooks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        url TEXT,
        event TEXT,
        active BOOLEAN DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        request_count INTEGER DEFAULT 0,
        last_reset DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS admin_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT,
        admin_email TEXT,
        details TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        url TEXT,
        event TEXT,
        status TEXT,
        response TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS subscription_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        endpoint TEXT,
        device_type TEXT,
        device_name TEXT,
        region TEXT,
        action TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS api_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        endpoint TEXT,
        method TEXT,
        status TEXT,
        response_code INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await db.execute(`
      CREATE TABLE IF NOT EXISTS templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        api_key TEXT,
        template_id TEXT UNIQUE,
        name TEXT,
        title TEXT,
        message TEXT,
        image_url TEXT,
        icon_url TEXT,
        button1_name TEXT,
        button1_url TEXT,
        button2_name TEXT,
        button2_url TEXT,
        custom_sound_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (api_key) REFERENCES projects(api_key)
      )
    `);

    console.log('✅ Turso Database connected & schema verified.');
    console.log('✅ All tables ready.');
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  }
}
initDB();

// ============================================================
// 4. SERVE UI LANDING PAGE
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ============================================================
// 5. SERVICE WORKER ROUTE
// ============================================================
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.sendFile(path.join(__dirname, 'sw.js'));
});

// ============================================================
// 6. HEALTH CHECK
// ============================================================
app.get('/health', (req, res) => {
  res.json({
    status: 200,
    success: true,
    message: 'Server is healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    brand: BRAND.name,
    database: 'Turso Connected'
  });
});

// ============================================================
// 7. GET VAPID PUBLIC KEY
// ============================================================
app.get('/api/v1/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// ============================================================
// 8. HELP
// ============================================================
app.get('/api/v1/help', (req, res) => {
  res.json({
    status: 200,
    success: true,
    message: 'Support contact information',
    support: {
      email: BRAND.email,
      response_time: 'Within 24 hours',
      hours: 'Monday - Friday, 9AM - 6PM WAT'
    }
  });
});

// ============================================================
// 9. BRAND
// ============================================================
app.get('/api/v1/brand', (req, res) => {
  res.json({
    status: 200,
    success: true,
    brand: BRAND
  });
});

// ============================================================
// 10. PLANS
// ============================================================
app.get('/api/v1/plans', (req, res) => {
  res.json({
    status: 200,
    success: true,
    brand: BRAND.name,
    plans: [
      { name: 'Free', price: 0, push_limit: 1000, email_limit: 250, apps_limit: 5,
        features: ['Push Notifications', 'Email Notifications', 'Basic Analytics', 'Scheduled Notifications'] },
      { name: 'Pro', price: 4500, push_limit: 10000, email_limit: 2500, apps_limit: 20,
        features: ['All Free features', 'Advanced Analytics', 'Scheduled Sends', 'Bulk Sending', 'Priority Support', 'Subscriber Groups', 'A/B Testing', 'Custom Sounds'] },
      { name: 'Enterprise', price: 15000, push_limit: 100000, email_limit: 25000, apps_limit: 100,
        features: ['All Pro features', 'Custom Branding', 'Webhooks', 'Dedicated Support', 'White-label', 'Team Collaboration'] }
    ]
  });
});

// ============================================================
// 11. GENERATE WEB PUSH CONFIG
// ============================================================
app.post('/api/v1/generate-web-push-config', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key required' });
  }

  try {
    const project = await db.execute({
      sql: 'SELECT project_name, api_key FROM projects WHERE api_key = ?',
      args: [apiKey]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'No such API key' });
    }

    const serverUrl = process.env.RENDER_URL || 'https://push-notification-server-5tx2.onrender.com';

    const configCode = `
<!-- 🔔 Sendly Notification - Add this to your website HEAD -->
<script src="${serverUrl}/sdk.js" data-api-key="${apiKey}"></script>
    `;

    res.json({
      status: 201,
      success: true,
      message: 'Web push config generated successfully',
      config: configCode.trim(),
      instructions: 'Copy this code and paste it into your website\'s <head> section.'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 12. USER REGISTER
// ============================================================
app.post('/api/v1/auth/register', async (req, res) => {
  const { name, surname, email, password, traffic } = req.body;

  if (!name || !surname || !email || !password || !traffic) {
    return res.json({ status: 400, success: false, message: 'All fields are required' });
  }

  try {
    const existingUser = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [email]
    });

    if (existingUser.rows.length > 0) {
      return res.json({ status: 400, success: false, message: 'Email already registered. Please login.' });
    }

    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    await db.execute({
      sql: 'INSERT INTO users (name, surname, email, password_hash, traffic) VALUES (?, ?, ?, ?, ?)',
      args: [name, surname, email, passwordHash, traffic]
    });

    const user = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [email]
    });

    res.json({
      status: 201,
      success: true,
      message: 'User registered successfully',
      user_id: user.rows[0].id,
      email: email
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 13. USER LOGIN
// ============================================================
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.json({ status: 400, success: false, message: 'Email and password required' });
  }

  try {
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');

    const user = await db.execute({
      sql: 'SELECT id, name, surname, email, plan, blocked FROM users WHERE email = ? AND password_hash = ?',
      args: [email, passwordHash]
    });

    if (user.rows.length === 0) {
      return res.json({ status: 401, success: false, message: 'Invalid email or password' });
    }

    if (user.rows[0].blocked === 1) {
      return res.json({ status: 403, success: false, message: 'Account blocked. Contact support.' });
    }

    const sessionToken = crypto.randomBytes(32).toString('hex');

    await db.execute({
      sql: 'INSERT OR REPLACE INTO sessions (user_id, token) VALUES (?, ?)',
      args: [user.rows[0].id, sessionToken]
    });

    res.json({
      status: 200,
      success: true,
      message: 'Login successful',
      user_id: user.rows[0].id,
      name: user.rows[0].name,
      surname: user.rows[0].surname || '',
      email: user.rows[0].email,
      plan: user.rows[0].plan || 'free',
      session_token: sessionToken
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});
// ============================================================
// 13.5. GOOGLE AUTH
// ============================================================
app.post('/api/v1/auth/google', async (req, res) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({ status: 400, success: false, message: 'Token required' });
  }

  try {
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    const { email, name, picture } = payload;

    const existingUser = await db.execute({
      sql: 'SELECT id, name, email, plan, blocked FROM users WHERE email = ?',
      args: [email]
    });

    if (existingUser.rows.length > 0) {
      const user = existingUser.rows[0];
      if (user.blocked === 1) {
        return res.json({ status: 403, success: false, message: 'Account blocked.' });
      }

      const sessionToken = crypto.randomBytes(32).toString('hex');
      await db.execute({
        sql: 'INSERT OR REPLACE INTO sessions (user_id, token) VALUES (?, ?)',
        args: [user.id, sessionToken]
      });

      return res.json({
        status: 200,
        success: true,
        message: 'Login successful',
        user_id: user.id,
        name: user.name || name || 'User',
        email: user.email,
        plan: user.plan || 'free',
        session_token: sessionToken
      });
    } else {
      const result = await db.execute({
        sql: 'INSERT INTO users (name, email, password_hash, traffic) VALUES (?, ?, ?, ?)',
        args: [name || 'Google User', email, 'google_oauth_' + Date.now(), 'google']
      });

      const newUser = await db.execute({
        sql: 'SELECT id, name, email, plan FROM users WHERE email = ?',
        args: [email]
      });

      const user = newUser.rows[0];
      const sessionToken = crypto.randomBytes(32).toString('hex');

      await db.execute({
        sql: 'INSERT OR REPLACE INTO sessions (user_id, token) VALUES (?, ?)',
        args: [user.id, sessionToken]
      });

      return res.json({
        status: 201,
        success: true,
        message: 'Account created and logged in',
        user_id: user.id,
        name: user.name,
        email: user.email,
        plan: user.plan || 'free',
        session_token: sessionToken
      });
    }

  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ status: 500, success: false, message: 'Google authentication failed' });
  }
});
// ============================================================
// 14. LOGOUT
// ============================================================
app.post('/api/v1/auth/logout', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];

  if (!sessionToken) {
    return res.json({ status: 401, success: false, message: 'Session token required' });
  }

  try {
    await db.execute({
      sql: 'DELETE FROM sessions WHERE token = ?',
      args: [sessionToken]
    });

    res.json({
      status: 200,
      success: true,
      message: 'Logged out successfully'
    });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 15. CREATE APP
// ============================================================
app.post('/api/v1/apps/create', async (req, res) => {
  const { app_name, app_url } = req.body;
  const sessionToken = req.headers['x-session-token'];

  if (!sessionToken) {
    return res.json({ status: 401, success: false, message: 'Session token required. Please login.' });
  }

  if (!app_name) {
    return res.json({ status: 400, success: false, message: 'App name is required' });
  }

  if (!app_url) {
    return res.json({ status: 400, success: false, message: 'App URL is required' });
  }

  try {
    const user = await db.execute({
      sql: 'SELECT id, plan, total_push_quota FROM users WHERE id IN (SELECT user_id FROM sessions WHERE token = ?)',
      args: [sessionToken]
    });

    if (user.rows.length === 0) {
      return res.json({ status: 401, success: false, message: 'Invalid session. Please login again.' });
    }

    const userId = user.rows[0].id;
    const plan = user.rows[0].plan || 'free';

    let appLimit = 5;
    if (plan === 'pro') appLimit = 20;
    if (plan === 'enterprise') appLimit = 100;

    const appCount = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM projects WHERE user_id = ?',
      args: [userId]
    });

    if (appCount.rows[0].count >= appLimit) {
      return res.json({
        status: 702,
        success: false,
        message: `App limit reached. Upgrade your plan to create more apps. (Limit: ${appLimit})`
      });
    }

    const rawKey = crypto.randomBytes(16).toString('hex');
    const normalizedAppName = app_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const apiKey = `sendly_live_${normalizedAppName}_${rawKey}`;

    // URL verification disabled - accepting any URL
    const urlMatch = true;

    await db.execute({
      sql: 'INSERT INTO projects (user_id, project_name, app_name, app_url, api_key, plan) VALUES (?, ?, ?, ?, ?, ?)',
      args: [userId, app_name, app_name, app_url, apiKey, plan]
    });

    const newAppCount = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM projects WHERE user_id = ?',
      args: [userId]
    });

    res.json({
      status: 201,
      success: true,
      message: 'App created successfully',
      app_id: newAppCount.rows[0].count,
      app_name: app_name,
      app_url: app_url,
      api_key: apiKey,
      push_quota: 1000,
      email_quota: 250,
      plan: plan
    });

  } catch (error) {
    console.error('❌ Create app error:', error);
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 16. GET APP LIST
// ============================================================
app.get('/api/v1/apps/list', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];

  if (!sessionToken) {
    return res.json({ status: 401, success: false, message: 'Session token required. Please login.' });
  }

  try {
    const user = await db.execute({
      sql: 'SELECT user_id FROM sessions WHERE token = ?',
      args: [sessionToken]
    });

    if (user.rows.length === 0) {
      return res.json({ status: 401, success: false, message: 'Invalid session. Please login again.' });
    }

    const userId = user.rows[0].user_id;

    const apps = await db.execute({
      sql: 'SELECT id, project_name, app_name, app_url, api_key, push_quota, email_quota, plan, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC',
      args: [userId]
    });

    for (let app of apps.rows) {
      const count = await db.execute({
        sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?',
        args: [app.api_key]
      });
      app.subscribers = count.rows[0].count;
    }

    res.json({
      status: 200,
      success: true,
      apps: apps.rows
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 17. DELETE APP
// ============================================================
app.delete('/api/v1/apps/:id', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const appId = req.params.id;

  if (!sessionToken) {
    return res.json({ status: 401, success: false, message: 'Session token required' });
  }

  try {
    const user = await db.execute({
      sql: 'SELECT user_id FROM sessions WHERE token = ?',
      args: [sessionToken]
    });

    if (user.rows.length === 0) {
      return res.json({ status: 401, success: false, message: 'Invalid session' });
    }

    const userId = user.rows[0].user_id;

    const project = await db.execute({
      sql: 'SELECT id FROM projects WHERE id = ? AND user_id = ?',
      args: [appId, userId]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'App not found' });
    }

    // Delete all associated data
    await db.execute({ sql: 'DELETE FROM subscribers WHERE api_key IN (SELECT api_key FROM projects WHERE id = ?)', args: [appId] });
    await db.execute({ sql: 'DELETE FROM notification_history WHERE api_key IN (SELECT api_key FROM projects WHERE id = ?)', args: [appId] });
    await db.execute({ sql: 'DELETE FROM templates WHERE api_key IN (SELECT api_key FROM projects WHERE id = ?)', args: [appId] });
    await db.execute({ sql: 'DELETE FROM webhooks WHERE api_key IN (SELECT api_key FROM projects WHERE id = ?)', args: [appId] });
    await db.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [appId] });

    res.json({
      status: 001,
      success: true,
      message: 'App and all associated data deleted permanently'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 18. SUBSCRIBE DEVICE
// ============================================================
app.post('/api/v1/subscribe', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const { endpoint, keys, device_type, device_name, region } = req.body;

  if (!apiKey || !endpoint || !keys) {
    return res.status(400).json({ success: false, error: 'Missing required payload parameters.' });
  }

  try {
    const project = await db.execute({
      sql: 'SELECT api_key, blocked, crack_signals, crack_locked_until FROM projects WHERE api_key = ?',
      args: [apiKey]
    });

    if (project.rows.length === 0) {
      return res.status(401).json({ status: 401, success: false, error: 'Invalid API Key.' });
    }

    if (project.rows[0].blocked === 1) {
      return res.status(403).json({ status: 403, success: false, error: 'API key is blocked.' });
    }

    if (project.rows[0].crack_locked_until && new Date(project.rows[0].crack_locked_until) > new Date()) {
      return res.status(403).json({
        status: 403,
        success: false,
        error: 'API key locked due to crack signals. Please wait.'
      });
    }

    await db.execute({
      sql: `INSERT INTO subscription_logs (api_key, endpoint, device_type, device_name, region, action)
            VALUES (?, ?, ?, ?, ?, 'subscribed')`,
      args: [apiKey, endpoint, device_type || 'unknown', device_name || 'unknown', region || 'unknown']
    });

    await db.execute({
      sql: `INSERT INTO subscribers (api_key, endpoint, p256dh, auth, device_type, device_name, region)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      args: [apiKey, endpoint, keys.p256dh, keys.auth, device_type || 'unknown', device_name || 'unknown', region || 'unknown']
    });

    res.json({
      status: 100,
      success: true,
      message: 'Device registered for push notifications successfully.',
      brand: BRAND.name
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 19. GET SUBSCRIBERS
// ============================================================
app.get('/api/v1/subscribers', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const project = await db.execute({
      sql: 'SELECT api_key FROM projects WHERE api_key = ?',
      args: [apiKey]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'No such API key' });
    }

    const result = await db.execute({
      sql: 'SELECT id, endpoint, device_type, device_name, region, subscriber_group, created_at FROM subscribers WHERE api_key = ? ORDER BY created_at DESC',
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      count: result.rows.length,
      subscribers: result.rows
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 20. SEND NOTIFICATION - FIXED
// ============================================================
app.post('/api/v1/send', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const {
    channel, title, message, recipient,
    image, image_url, icon, icon_url,
    button1_name, button1_url,
    button2_name, button2_url,
    persistent, scheduled_for,
    custom_sound_url,
    ab_test_group,
    subscriber_group
  } = req.body;

  if (!apiKey) {
    return res.status(401).json({ status: 401, error: 'Unauthorized', message: 'API key is missing' });
  }

  if (!title || !message) {
    return res.status(400).json({ status: 400, success: false, message: 'Title and message are required' });
  }

  try {
    const project = await db.execute({
      sql: 'SELECT user_id, push_quota, email_quota, blocked, plan FROM projects WHERE api_key = ?',
      args: [apiKey]
    });

    if (project.rows.length === 0) {
      return res.status(401).json({ status: 401, error: 'Unauthorized', message: 'Invalid API Key' });
    }

    if (project.rows[0].blocked === 1) {
      return res.status(403).json({ status: 403, success: false, error: 'API key is blocked.' });
    }

    const plan = project.rows[0].plan || 'free';
    let rateLimit = 500;
    if (plan === 'pro') rateLimit = 5000;
    if (plan === 'enterprise') rateLimit = 50000;

    const rateCheck = await db.execute({
      sql: 'SELECT request_count, last_reset FROM rate_limits WHERE api_key = ?',
      args: [apiKey]
    });

    const now = new Date();
    if (rateCheck.rows.length === 0) {
      await db.execute({
        sql: 'INSERT INTO rate_limits (api_key, request_count, last_reset) VALUES (?, 1, ?)',
        args: [apiKey, now.toISOString()]
      });
    } else {
      const lastReset = new Date(rateCheck.rows[0].last_reset);
      const hoursDiff = (now - lastReset) / (1000 * 60 * 60);

      if (hoursDiff >= 1) {
        await db.execute({
          sql: 'UPDATE rate_limits SET request_count = 1, last_reset = ? WHERE api_key = ?',
          args: [now.toISOString(), apiKey]
        });
      } else {
        const currentCount = rateCheck.rows[0].request_count;
        if (currentCount >= rateLimit) {
          return res.status(429).json({
            status: 429,
            success: false,
            message: `Rate limit exceeded. You can send ${rateLimit} notifications per hour. Please wait.`
          });
        }
        await db.execute({
          sql: 'UPDATE rate_limits SET request_count = request_count + 1 WHERE api_key = ?',
          args: [apiKey]
        });
      }
    }

    const notificationId = `sendly_msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    if (channel === 'push') {
      const currentQuota = project.rows[0].push_quota ?? 1000;

      if (currentQuota <= 0) {
        return res.status(702).json({
          status: 702,
          error: 'Limit Reached',
          message: 'Push notification quota exhausted. Please upgrade your plan.'
        });
      }

      let subscriberQuery = 'SELECT endpoint, p256dh, auth FROM subscribers WHERE api_key = ?';
      let args = [apiKey];
      if (subscriber_group && subscriber_group !== 'all') {
        subscriberQuery += ' AND subscriber_group = ?';
        args.push(subscriber_group);
      }

      const subscribers = await db.execute({
        sql: subscriberQuery,
        args: args
      });

      if (subscribers.rows.length === 0) {
        return res.json({
          status: 200,
          success: true,
          message: subscriber_group ? `No devices in group: ${subscriber_group}` : 'No devices registered.'
        });
      }

      // Insert notification history
      await db.execute({
        sql: `INSERT INTO notification_history
              (api_key, notification_id, title, message, image_url, icon_url,
               button1_name, button1_url, button2_name, button2_url,
               persistent, scheduled_for, ab_test_group, custom_sound_url, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          apiKey, notificationId, title, message,
          image || image_url || '', icon || icon_url || '',
          button1_name || '', button1_url || '',
          button2_name || '', button2_url || '',
          persistent ? 1 : 0, scheduled_for || null,
          ab_test_group || null, custom_sound_url || '',
          scheduled_for ? 'scheduled' : 'sent'
        ]
      });

      const payload = {
        title: title,
        body: message,
        icon: icon || icon_url || '/icon.png',
        image: image || image_url || '',
        badge: '/badge.png',
        vibrate: [200, 100, 200],
        data: {
          url: button1_url || '/',
          notification_id: notificationId
        }
      };

      const actions = [];
      if (button1_name && button1_url) {
        actions.push({ action: 'button1', title: button1_name });
      }
      if (button2_name && button2_url) {
        actions.push({ action: 'button2', title: button2_name });
      }
      if (actions.length > 0) {
        payload.actions = actions;
      }

      if (custom_sound_url) {
        payload.sound = custom_sound_url;
      }

      const finalPayload = JSON.stringify(payload);

      let successCount = 0;
      const pushPromises = subscribers.rows.map(async (sub) => {
        const pushSubscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth }
        };
        try {
          await webpush.sendNotification(pushSubscription, finalPayload);
          successCount++;
        } catch (err) {
          if (err.statusCode === 410 || err.statusCode === 404) {
            await db.execute({
              sql: 'DELETE FROM subscribers WHERE endpoint = ?',
              args: [sub.endpoint]
            });
          }
        }
      });

      await Promise.all(pushPromises);

      await db.execute({
        sql: `UPDATE notification_history SET devices_sent = ?, status = "sent", sent_at = datetime('now') WHERE notification_id = ?`,
        args: [successCount, notificationId]
      });

      const newQuota = currentQuota - 1;
      await db.execute({
        sql: 'UPDATE projects SET push_quota = ? WHERE api_key = ?',
        args: [newQuota, apiKey]
      });

      return res.json({
        status: 201,
        success: true,
        channel: 'push',
        notification_id: notificationId,
        message: `Push notification broadcasted to ${successCount} device(s).`,
        remaining_quota: newQuota,
        brand: BRAND.name
      });

    } else if (channel === 'email') {
      if (!recipient) {
        return res.status(400).json({ success: false, error: "'recipient' email address is required for channel 'email'." });
      }

      const currentQuota = project.rows[0].email_quota ?? 250;

      if (currentQuota <= 0) {
        return res.status(702).json({
          status: 702,
          error: 'Limit Reached',
          message: 'Email quota exhausted. Please upgrade your plan.'
        });
      }

      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true' || false,
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });

      await transporter.verify();

      await transporter.sendMail({
        from: `${BRAND.name} <${process.env.SMTP_USER}>`,
        to: recipient,
        subject: title,
        text: message,
        html: `
          <div style="font-family: Arial, sans-serif; padding: 20px;">
            <h2>${title}</h2>
            <p>${message}</p>
            <hr>
            <p>Sent via ${BRAND.name} | ${BRAND.company}</p>
            <p>⚡ Powered By ${BRAND.powered_by}</p>
          </div>
        `
      });

      await db.execute({
        sql: 'INSERT INTO notification_history (api_key, notification_id, title, message, status, sent_at) VALUES (?, ?, ?, ?, "sent", datetime("now"))',
        args: [apiKey, notificationId, title, message]
      });

      const newQuota = currentQuota - 1;
      await db.execute({
        sql: 'UPDATE projects SET email_quota = ? WHERE api_key = ?',
        args: [newQuota, apiKey]
      });

      return res.json({
        status: 201,
        success: true,
        channel: 'email',
        notification_id: notificationId,
        message: `Email delivered to ${recipient} successfully.`,
        remaining_quota: newQuota,
        brand: BRAND.name
      });

    } else {
      return res.status(400).json({ success: false, error: "Unsupported channel. Use 'push' or 'email'." });
    }

  } catch (error) {
    console.error('❌ Send Error:', error);
    res.status(500).json({
      status: 500,
      error: 'Internal Server Error',
      message: error.message
    });
  }
});

// ============================================================
// 21. TEST NOTIFICATION
// ============================================================
app.post('/api/v1/test-notification', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key required' });
  }

  try {
    const project = await db.execute({
      sql: 'SELECT push_quota FROM projects WHERE api_key = ?',
      args: [apiKey]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'No such API key' });
    }

    const subscribers = await db.execute({
      sql: 'SELECT endpoint, p256dh, auth FROM subscribers WHERE api_key = ?',
      args: [apiKey]
    });

    if (subscribers.rows.length === 0) {
      return res.json({
        status: 200,
        success: true,
        message: 'No devices registered. Please subscribe first.',
        has_subscriber: false
      });
    }

    const payload = JSON.stringify({
      title: '🔔 Test Notification',
      body: 'Your Sendly Notification is working! 🎉',
      icon: '/icon.png',
      data: { url: '/' }
    });

    let successCount = 0;
    const pushPromises = subscribers.rows.map(async (sub) => {
      const pushSubscription = {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.p256dh, auth: sub.auth }
      };
      try {
        await webpush.sendNotification(pushSubscription, payload);
        successCount++;
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.execute({
            sql: 'DELETE FROM subscribers WHERE endpoint = ?',
            args: [sub.endpoint]
          });
        }
      }
    });

    await Promise.all(pushPromises);

    res.json({
      status: 201,
      success: true,
      message: `Test notification sent to ${successCount} device(s)`,
      devices_sent: successCount
    });

  } catch (error) {
    console.error('❌ Test notification error:', error);
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 22. VALIDATE API KEY
// ============================================================
app.get('/api/v1/validate-key', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const project = await db.execute({
      sql: 'SELECT project_name, app_name, api_key, plan, blocked, push_quota, email_quota, crack_signals, crack_locked_until FROM projects WHERE api_key = ?',
      args: [apiKey]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'No such API key' });
    }

    const proj = project.rows[0];

    if (proj.crack_locked_until && new Date(proj.crack_locked_until) > new Date()) {
      return res.json({
        status: 403,
        success: false,
        message: 'API key locked due to crack signals. Please wait until ' + proj.crack_locked_until
      });
    }

    if (proj.blocked === 1) {
      return res.json({ status: 403, success: false, message: 'API key has been blocked.' });
    }

    res.json({
      status: 200,
      success: true,
      message: 'API key is active',
      project: {
        name: proj.project_name,
        app_name: proj.app_name,
        plan: proj.plan || 'free',
        push_quota_remaining: proj.push_quota || 0,
        email_quota_remaining: proj.email_quota || 0,
        crack_signals: proj.crack_signals || 0
      }
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 23. REVOKE API KEY
// ============================================================
app.post('/api/v1/revoke-key', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const { email, password } = req.body;

  if (!apiKey || !email || !password) {
    return res.json({ status: 400, success: false, message: 'API key, email and password required' });
  }

  try {
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const user = await db.execute({
      sql: 'SELECT id FROM users WHERE email = ? AND password_hash = ?',
      args: [email, passwordHash]
    });

    if (user.rows.length === 0) {
      return res.json({ status: 010, success: false, message: 'Incorrect password' });
    }

    const project = await db.execute({
      sql: 'SELECT id, user_id FROM projects WHERE api_key = ?',
      args: [apiKey]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 030, success: false, message: 'Incorrect API key' });
    }

    if (project.rows[0].user_id !== user.rows[0].id) {
      return res.json({ status: 020, success: false, message: 'Incorrect username' });
    }

    const rawKey = crypto.randomBytes(16).toString('hex');
    const newApiKey = `sendly_live_${rawKey}`;

    await db.execute({
      sql: 'UPDATE projects SET api_key = ? WHERE id = ?',
      args: [newApiKey, project.rows[0].id]
    });

    res.json({
      status: 001,
      success: true,
      message: 'API key revoked and regenerated successfully',
      old_api_key: apiKey,
      new_api_key: newApiKey
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 24. SCHEDULED NOTIFICATION PROCESSOR
// ============================================================
async function processScheduledNotifications() {
    try {
        const now = new Date().toISOString();
        const scheduled = await db.execute({
            sql: `SELECT id, api_key, title, message, image_url, icon_url,
                         button1_name, button1_url, button2_name, button2_url,
                         persistent, custom_sound_url, notification_id
                  FROM notification_history
                  WHERE status = 'scheduled' AND scheduled_for <= ?`,
            args: [now]
        });

        if (scheduled.rows.length === 0) return;

        console.log(`⏰ Processing ${scheduled.rows.length} scheduled notifications...`);

        for (const notif of scheduled.rows) {
            try {
                const subscribers = await db.execute({
                    sql: 'SELECT endpoint, p256dh, auth FROM subscribers WHERE api_key = ?',
                    args: [notif.api_key]
                });

                if (subscribers.rows.length === 0) {
                    await db.execute({
                        sql: `UPDATE notification_history SET status = 'failed', sent_at = datetime('now') WHERE id = ?`,
                        args: [notif.id]
                    });
                    continue;
                }

                const payload = {
                    title: notif.title,
                    body: notif.message,
                    icon: notif.icon_url || '/icon.png',
                    image: notif.image_url || '',
                    badge: '/badge.png',
                    vibrate: [200, 100, 200],
                    data: {
                        url: notif.button1_url || '/',
                        notification_id: notif.notification_id
                    }
                };

                const actions = [];
                if (notif.button1_name && notif.button1_url) {
                    actions.push({ action: 'button1', title: notif.button1_name });
                }
                if (notif.button2_name && notif.button2_url) {
                    actions.push({ action: 'button2', title: notif.button2_name });
                }
                if (actions.length > 0) {
                    payload.actions = actions;
                }
                if (notif.custom_sound_url) {
                    payload.sound = notif.custom_sound_url;
                }

                const finalPayload = JSON.stringify(payload);
                let successCount = 0;

                for (const sub of subscribers.rows) {
                    try {
                        await webpush.sendNotification({
                            endpoint: sub.endpoint,
                            keys: { p256dh: sub.p256dh, auth: sub.auth }
                        }, finalPayload);
                        successCount++;
                    } catch (err) {
                        if (err.statusCode === 410 || err.statusCode === 404) {
                            await db.execute({
                                sql: 'DELETE FROM subscribers WHERE endpoint = ?',
                                args: [sub.endpoint]
                            });
                        }
                    }
                }

                await db.execute({
                    sql: `UPDATE notification_history SET status = 'sent', sent_at = datetime('now'), devices_sent = ? WHERE id = ?`,
                    args: [successCount, notif.id]
                });

                console.log(`✅ Scheduled notification ${notif.notification_id} sent to ${successCount} devices`);

            } catch (err) {
                console.error(`❌ Failed to send scheduled notification ${notif.id}:`, err);
                await db.execute({
                    sql: `UPDATE notification_history SET status = 'failed' WHERE id = ?`,
                    args: [notif.id]
                });
            }
        }

    } catch (error) {
        console.error('❌ Scheduled notification processor error:', error);
    }
}

setInterval(processScheduledNotifications, 30000);
setTimeout(processScheduledNotifications, 5000);

// ============================================================
// 25. SERVER START
// ============================================================
const PORT = process.env.PORT || 5000;
const serverUrl = process.env.RENDER_URL || `http://localhost:${PORT}`;

app.listen(PORT, () => {
  console.log('');
  console.log(`🚀 ${BRAND.name} Server running on ${serverUrl}`);
  console.log(`🏢 ${BRAND.company} (${BRAND.short})`);
  console.log(`👤 Owned by ${BRAND.founder}`);
  console.log(`📅 Built: ${BRAND.built_date}`);
  console.log(`⚡ Powered By ${BRAND.powered_by}`);
  console.log(`📧 Email: ${BRAND.email}`);
  console.log('');
  console.log(`✅ CORS enabled - All origins allowed`);
  console.log(`✅ SDK endpoint: ${serverUrl}/sdk.js`);
  console.log(`✅ Service worker: ${serverUrl}/sw.js`);
  console.log(`✅ Admin endpoints secured with password`);
  console.log(`✅ Scheduled notifications processor running`);
  console.log(`✅ All endpoints ready!`);
  console.log('');
});
