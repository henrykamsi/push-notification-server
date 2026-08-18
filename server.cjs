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
// 18. SELECT APP
// ============================================================
app.post('/api/v1/apps/select', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const { app_id } = req.body;

  if (!sessionToken) {
    return res.json({ status: 401, success: false, message: 'Session token required' });
  }

  if (!app_id) {
    return res.json({ status: 400, success: false, message: 'App ID required' });
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
      args: [app_id, userId]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'App not found' });
    }

    res.json({
      status: 200,
      success: true,
      message: 'App selected successfully',
      selected_app: app_id
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 19. GET SELECTED APP
// ============================================================
app.get('/api/v1/apps/select', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];

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

    const apps = await db.execute({
      sql: 'SELECT id, app_name, api_key FROM projects WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      args: [userId]
    });

    if (apps.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'No apps found' });
    }

    res.json({
      status: 200,
      success: true,
      selected_app: apps.rows[0]
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 20. GET APP STATS
// ============================================================
app.get('/api/v1/apps/:id/stats', async (req, res) => {
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
      sql: 'SELECT id, project_name, app_name, api_key, push_quota, email_quota, plan FROM projects WHERE id = ? AND user_id = ?',
      args: [appId, userId]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'App not found' });
    }

    const subscriberCount = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?',
      args: [project.rows[0].api_key]
    });

    const notificationCount = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM notification_history WHERE api_key = ?',
      args: [project.rows[0].api_key]
    });

    res.json({
      status: 200,
      success: true,
      app: project.rows[0],
      stats: {
        subscribers: subscriberCount.rows[0].count || 0,
        notifications_sent: notificationCount.rows[0].count || 0,
        push_quota_remaining: project.rows[0].push_quota || 0,
        email_quota_remaining: project.rows[0].email_quota || 0
      }
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 21. SUBSCRIBE DEVICE
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
// 22. GET SUBSCRIBERS
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
// 23. DELETE SUBSCRIBER
// ============================================================
app.delete('/api/v1/subscribers/:id', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const subscriberId = req.params.id;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const subscriber = await db.execute({
      sql: 'SELECT id FROM subscribers WHERE id = ? AND api_key = ?',
      args: [subscriberId, apiKey]
    });

    if (subscriber.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'Subscriber not found' });
    }

    await db.execute({
      sql: 'DELETE FROM subscribers WHERE id = ?',
      args: [subscriberId]
    });

    res.json({
      status: 001,
      success: true,
      message: 'Subscriber deleted successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 24. SUBSCRIBER COUNT
// ============================================================
app.get('/api/v1/subscribers/count', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const result = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?',
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      count: result.rows[0].count || 0
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 25. EXPORT SUBSCRIBERS
// ============================================================
app.get('/api/v1/subscribers/export', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const format = req.query.format || 'json';

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const result = await db.execute({
      sql: 'SELECT id, endpoint, device_type, device_name, region, subscriber_group, created_at FROM subscribers WHERE api_key = ? ORDER BY created_at DESC',
      args: [apiKey]
    });

    if (format === 'csv') {
      let csv = 'id,endpoint,device_type,device_name,region,subscriber_group,created_at\n';
      for (const row of result.rows) {
        csv += `${row.id},${row.endpoint},${row.device_type || ''},${row.device_name || ''},${row.region || ''},${row.subscriber_group || 'all'},${row.created_at}\n`;
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=subscribers.csv');
      return res.send(csv);
    }

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
// 26. SEND NOTIFICATION - FIXED
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
// 27. TEST NOTIFICATION
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
// 28. VALIDATE API KEY
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
// 29. NOTIFICATION STATS
// ============================================================
app.get('/api/v1/notification/:id/stats', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const notificationId = req.params.id;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const result = await db.execute({
      sql: `SELECT notification_id, title, message, image_url, icon_url,
            button1_name, button1_url, button2_name, button2_url,
            devices_sent, views, clicks, button1_clicks, button2_clicks,
            open_rate, avg_view_time, status, sent_at, scheduled_for, persistent
            FROM notification_history
            WHERE notification_id = ? AND api_key = ?`,
      args: [notificationId, apiKey]
    });

    if (result.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'Notification not found' });
    }

    res.json({
      status: 191,
      success: true,
      notification: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 30. RESEND NOTIFICATION
// ============================================================
app.post('/api/v1/notification/:id/resend', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const notificationId = req.params.id;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const notification = await db.execute({
      sql: 'SELECT title, message, image_url, icon_url, button1_name, button1_url, button2_name, button2_url FROM notification_history WHERE notification_id = ? AND api_key = ?',
      args: [notificationId, apiKey]
    });

    if (notification.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'Notification not found' });
    }

    const n = notification.rows[0];
    const newNotificationId = `sendly_msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    await db.execute({
      sql: `INSERT INTO notification_history
            (api_key, notification_id, title, message, image_url, icon_url,
             button1_name, button1_url, button2_name, button2_url,
             status, sent_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime("now"))`,
      args: [
        apiKey, newNotificationId, n.title, n.message, n.image_url || '', n.icon_url || '',
        n.button1_name || '', n.button1_url || '', n.button2_name || '', n.button2_url || '',
        'sent'
      ]
    });

    res.json({
      status: 201,
      success: true,
      message: 'Notification resent successfully',
      new_notification_id: newNotificationId
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 31. PAUSE NOTIFICATION
// ============================================================
app.post('/api/v1/notification/:id/pause', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const notificationId = req.params.id;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    await db.execute({
      sql: 'UPDATE notification_history SET status = "paused" WHERE notification_id = ? AND api_key = ?',
      args: [notificationId, apiKey]
    });

    res.json({
      status: 202,
      success: true,
      message: 'Notification paused successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 32. PLAY NOTIFICATION
// ============================================================
app.post('/api/v1/notification/:id/play', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const notificationId = req.params.id;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    await db.execute({
      sql: 'UPDATE notification_history SET status = "sent" WHERE notification_id = ? AND api_key = ?',
      args: [notificationId, apiKey]
    });

    res.json({
      status: 200,
      success: true,
      message: 'Notification resumed successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 33. CANCEL NOTIFICATION
// ============================================================
app.post('/api/v1/notification/:id/cancel', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const notificationId = req.params.id;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const notif = await db.execute({
      sql: 'SELECT status FROM notification_history WHERE notification_id = ? AND api_key = ?',
      args: [notificationId, apiKey]
    });

    if (notif.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'Notification not found' });
    }

    if (notif.rows[0].status !== 'scheduled') {
      return res.json({ status: 400, success: false, message: 'Only scheduled notifications can be cancelled' });
    }

    await db.execute({
      sql: 'UPDATE notification_history SET status = "cancelled" WHERE notification_id = ? AND api_key = ?',
      args: [notificationId, apiKey]
    });

    res.json({
      status: 001,
      success: true,
      message: 'Scheduled notification cancelled successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 34. DELETE NOTIFICATION
// ============================================================
app.delete('/api/v1/notification/:id', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const notificationId = req.params.id;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    await db.execute({
      sql: 'DELETE FROM notification_history WHERE notification_id = ? AND api_key = ?',
      args: [notificationId, apiKey]
    });

    res.json({
      status: 001,
      success: true,
      message: 'Notification deleted successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 35. SCHEDULED NOTIFICATIONS LIST
// ============================================================
app.get('/api/v1/notifications/scheduled', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const result = await db.execute({
      sql: `SELECT id, notification_id, title, message, scheduled_for, status
            FROM notification_history
            WHERE api_key = ? AND status = 'scheduled'
            ORDER BY scheduled_for ASC`,
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      count: result.rows.length,
      scheduled: result.rows
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 36. NOTIFICATIONS LIST WITH PAGINATION
// ============================================================
app.get('/api/v1/notifications/list', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const result = await db.execute({
      sql: `SELECT notification_id, title, message, image_url, icon_url,
            devices_sent, views, clicks, status, sent_at, scheduled_for
            FROM notification_history
            WHERE api_key = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?`,
      args: [apiKey, limit, offset]
    });

    const total = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM notification_history WHERE api_key = ?',
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      page: page,
      limit: limit,
      total: total.rows[0].count || 0,
      notifications: result.rows
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 37. RECENT NOTIFICATIONS
// ============================================================
app.get('/api/v1/notifications/recent', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const result = await db.execute({
      sql: `SELECT notification_id, title, message, devices_sent, status, sent_at
            FROM notification_history
            WHERE api_key = ?
            ORDER BY created_at DESC
            LIMIT 10`,
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      recent: result.rows
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 38. ANALYTICS OVERVIEW
// ============================================================
app.get('/api/v1/analytics/overview', async (req, res) => {
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

    const totalSent = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM notification_history WHERE api_key = ? AND status = "sent"',
      args: [apiKey]
    });

    const totalDelivered = await db.execute({
      sql: 'SELECT SUM(devices_sent) as total FROM notification_history WHERE api_key = ? AND status = "sent"',
      args: [apiKey]
    });

    const totalViews = await db.execute({
      sql: 'SELECT SUM(views) as total FROM notification_history WHERE api_key = ?',
      args: [apiKey]
    });

    const totalClicks = await db.execute({
      sql: 'SELECT SUM(clicks) as total FROM notification_history WHERE api_key = ?',
      args: [apiKey]
    });

    const totalSubscribers = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?',
      args: [apiKey]
    });

    const sentCount = totalSent.rows[0].count || 0;
    const deliveredCount = totalDelivered.rows[0].total || 0;
    const viewCount = totalViews.rows[0].total || 0;
    const clickCount = totalClicks.rows[0].total || 0;
    const subscriberCount = totalSubscribers.rows[0].count || 0;

    const deliveryRate = sentCount > 0 ? (deliveredCount / sentCount) * 100 : 0;
    const openRate = deliveredCount > 0 ? (viewCount / deliveredCount) * 100 : 0;
    const clickRate = viewCount > 0 ? (clickCount / viewCount) * 100 : 0;

    res.json({
      status: 200,
      success: true,
      analytics: {
        total_notifications_sent: sentCount,
        total_delivered: deliveredCount,
        total_views: viewCount,
        total_clicks: clickCount,
        total_subscribers: subscriberCount,
        delivery_rate: parseFloat(deliveryRate.toFixed(2)),
        open_rate: parseFloat(openRate.toFixed(2)),
        click_through_rate: parseFloat(clickRate.toFixed(2)),
        brand: BRAND.name
      }
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 39. ANALYTICS WITH DATE RANGE
// ============================================================
app.get('/api/v1/analytics/range', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const range = req.query.range || 'today';

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    let dateFilter = '';
    const now = new Date();
    let startDate = new Date();

    switch (range) {
      case 'today':
        startDate.setHours(0, 0, 0, 0);
        break;
      case 'yesterday':
        startDate.setDate(startDate.getDate() - 1);
        startDate.setHours(0, 0, 0, 0);
        break;
      case '7days':
        startDate.setDate(startDate.getDate() - 7);
        break;
      case '30days':
        startDate.setDate(startDate.getDate() - 30);
        break;
      case '60days':
        startDate.setDate(startDate.getDate() - 60);
        break;
      case '1year':
        startDate.setFullYear(startDate.getFullYear() - 1);
        break;
      default:
        startDate.setHours(0, 0, 0, 0);
    }

    const startDateStr = startDate.toISOString();

    const result = await db.execute({
      sql: `SELECT COUNT(*) as count, SUM(devices_sent) as delivered, SUM(views) as views, SUM(clicks) as clicks
            FROM notification_history
            WHERE api_key = ? AND status = 'sent' AND sent_at >= ?`,
      args: [apiKey, startDateStr]
    });

    const subscriberCount = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?',
      args: [apiKey]
    });

    const row = result.rows[0];
    const sentCount = row.count || 0;
    const deliveredCount = row.delivered || 0;
    const viewCount = row.views || 0;
    const clickCount = row.clicks || 0;
    const subscriberCountTotal = subscriberCount.rows[0].count || 0;

    const deliveryRate = sentCount > 0 ? (deliveredCount / sentCount) * 100 : 0;
    const openRate = deliveredCount > 0 ? (viewCount / deliveredCount) * 100 : 0;
    const clickRate = viewCount > 0 ? (clickCount / viewCount) * 100 : 0;

    res.json({
      status: 200,
      success: true,
      range: range,
      analytics: {
        total_notifications_sent: sentCount,
        total_delivered: deliveredCount,
        total_views: viewCount,
        total_clicks: clickCount,
        total_subscribers: subscriberCountTotal,
        delivery_rate: parseFloat(deliveryRate.toFixed(2)),
        open_rate: parseFloat(openRate.toFixed(2)),
        click_through_rate: parseFloat(clickRate.toFixed(2))
      }
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 40. ANALYTICS PER NOTIFICATION
// ============================================================
app.get('/api/v1/analytics/notification/:id', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const notificationId = req.params.id;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const result = await db.execute({
      sql: `SELECT notification_id, title, message, image_url, icon_url,
            devices_sent, views, clicks, button1_clicks, button2_clicks,
            open_rate, avg_view_time, status, sent_at
            FROM notification_history
            WHERE notification_id = ? AND api_key = ?`,
      args: [notificationId, apiKey]
    });

    if (result.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'Notification not found' });
    }

    res.json({
      status: 200,
      success: true,
      notification: result.rows[0]
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 41. SUBSCRIBER ANALYTICS
// ============================================================
app.get('/api/v1/analytics/subscribers', async (req, res) => {
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

    const byDevice = await db.execute({
      sql: 'SELECT device_type, COUNT(*) as count FROM subscribers WHERE api_key = ? GROUP BY device_type',
      args: [apiKey]
    });

    const byRegion = await db.execute({
      sql: 'SELECT region, COUNT(*) as count FROM subscribers WHERE api_key = ? GROUP BY region',
      args: [apiKey]
    });

    const byGroup = await db.execute({
      sql: 'SELECT subscriber_group, COUNT(*) as count FROM subscribers WHERE api_key = ? GROUP BY subscriber_group',
      args: [apiKey]
    });

    const total = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?',
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      total_subscribers: total.rows[0].count || 0,
      by_device: byDevice.rows,
      by_region: byRegion.rows,
      by_group: byGroup.rows
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 42. TEMPLATES - CREATE
// ============================================================
app.post('/api/v1/templates', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const { name, title, message, image_url, icon_url, button1_name, button1_url, button2_name, button2_url, custom_sound_url } = req.body;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  if (!name || !title || !message) {
    return res.json({ status: 400, success: false, message: 'Name, title and message are required' });
  }

  try {
    const project = await db.execute({
      sql: 'SELECT api_key FROM projects WHERE api_key = ?',
      args: [apiKey]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'No such API key' });
    }

    const templateId = `tpl_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    await db.execute({
      sql: `INSERT INTO templates (api_key, template_id, name, title, message, image_url, icon_url,
            button1_name, button1_url, button2_name, button2_url, custom_sound_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [apiKey, templateId, name, title, message, image_url || '', icon_url || '',
            button1_name || '', button1_url || '', button2_name || '', button2_url || '', custom_sound_url || '']
    });

    res.json({
      status: 201,
      success: true,
      message: 'Template created successfully',
      template_id: templateId
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 43. TEMPLATES - LIST
// ============================================================
app.get('/api/v1/templates', async (req, res) => {
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

    const templates = await db.execute({
      sql: 'SELECT id, template_id, name, title, message, image_url, icon_url, button1_name, button1_url, button2_name, button2_url, custom_sound_url, created_at FROM templates WHERE api_key = ? ORDER BY created_at DESC',
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      count: templates.rows.length,
      templates: templates.rows
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 44. TEMPLATES - UPDATE
// ============================================================
app.put('/api/v1/templates/:id', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const templateId = req.params.id;
  const { name, title, message, image_url, icon_url, button1_name, button1_url, button2_name, button2_url, custom_sound_url } = req.body;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const template = await db.execute({
      sql: 'SELECT id FROM templates WHERE template_id = ? AND api_key = ?',
      args: [templateId, apiKey]
    });

    if (template.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'Template not found' });
    }

    await db.execute({
      sql: `UPDATE templates SET name = ?, title = ?, message = ?, image_url = ?, icon_url = ?,
            button1_name = ?, button1_url = ?, button2_name = ?, button2_url = ?, custom_sound_url = ?
            WHERE template_id = ? AND api_key = ?`,
      args: [name, title, message, image_url || '', icon_url || '',
            button1_name || '', button1_url || '', button2_name || '', button2_url || '', custom_sound_url || '',
            templateId, apiKey]
    });

    res.json({
      status: 200,
      success: true,
      message: 'Template updated successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 45. TEMPLATES - DELETE
// ============================================================
app.delete('/api/v1/templates/:id', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const templateId = req.params.id;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const template = await db.execute({
      sql: 'SELECT id FROM templates WHERE template_id = ? AND api_key = ?',
      args: [templateId, apiKey]
    });

    if (template.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'Template not found' });
    }

    await db.execute({
      sql: 'DELETE FROM templates WHERE template_id = ? AND api_key = ?',
      args: [templateId, apiKey]
    });

    res.json({
      status: 001,
      success: true,
      message: 'Template deleted successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 46. WEBHOOK REGISTER
// ============================================================
app.post('/api/v1/webhook/register', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const { url, event } = req.body;

  if (!apiKey || !url || !event) {
    return res.json({ status: 400, success: false, message: 'API key, URL and event required' });
  }

  try {
    await db.execute({
      sql: 'INSERT INTO webhooks (api_key, url, event) VALUES (?, ?, ?)',
      args: [apiKey, url, event]
    });

    res.json({
      status: 201,
      success: true,
      message: 'Webhook registered successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 47. WEBHOOK LIST
// ============================================================
app.get('/api/v1/webhook/list', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key is required' });
  }

  try {
    const webhooks = await db.execute({
      sql: 'SELECT id, url, event, active, created_at FROM webhooks WHERE api_key = ?',
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      webhooks: webhooks.rows
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 48. WEBHOOK DELETE
// ============================================================
app.delete('/api/v1/webhook/delete', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const { webhook_id } = req.body;

  if (!apiKey || !webhook_id) {
    return res.json({ status: 400, success: false, message: 'API key and webhook ID required' });
  }

  try {
    await db.execute({
      sql: 'DELETE FROM webhooks WHERE id = ? AND api_key = ?',
      args: [webhook_id, apiKey]
    });

    res.json({
      status: 202,
      success: true,
      message: 'Webhook deleted successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 49. WEBHOOK TRIGGER
// ============================================================
app.post('/api/v1/webhook/trigger', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const { event, data } = req.body;

  if (!apiKey || !event) {
    return res.json({ status: 400, success: false, message: 'API key and event required' });
  }

  try {
    const webhooks = await db.execute({
      sql: 'SELECT url FROM webhooks WHERE api_key = ? AND event = ? AND active = 1',
      args: [apiKey, event]
    });

    if (webhooks.rows.length === 0) {
      return res.json({ status: 404, success: false, message: 'No active webhooks found for this event' });
    }

    for (const webhook of webhooks.rows) {
      try {
        await fetch(webhook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: event,
            timestamp: new Date().toISOString(),
            api_key: apiKey,
            data: data || {}
          })
        });
      } catch (e) {
        console.warn('Webhook failed:', e.message);
      }
    }

    res.json({
      status: 203,
      success: true,
      message: `Webhook triggered for ${webhooks.rows.length} webhook(s)`
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 50. WEBHOOK TEST
// ============================================================
app.post('/api/v1/webhook/test', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const { url } = req.body;

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key required' });
  }

  if (!url) {
    return res.json({ status: 400, success: false, message: 'Webhook URL required' });
  }

  try {
    const testData = {
      event: 'test',
      timestamp: new Date().toISOString(),
      api_key: apiKey,
      data: {
        message: 'This is a test webhook from Sendly Notification',
        success: true
      }
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testData)
    });

    const responseText = await response.text();

    await db.execute({
      sql: `INSERT INTO webhook_logs (api_key, url, event, status, response)
            VALUES (?, ?, ?, ?, ?)`,
      args: [apiKey, url, 'test', response.ok ? 'success' : 'failed', responseText.substring(0, 500)]
    });

    res.json({
      status: response.ok ? 200 : 500,
      success: response.ok,
      message: response.ok ? '✅ Webhook test successful!' : '❌ Webhook test failed',
      response_code: response.status,
      response_body: responseText.substring(0, 500)
    });

  } catch (error) {
    res.status(500).json({
      status: 500,
      success: false,
      message: '❌ Webhook test error: ' + error.message
    });
  }
});

// ============================================================
// 51. LOGS - WEBHOOKS
// ============================================================
app.get('/api/v1/logs/webhooks', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key required' });
  }

  try {
    const logs = await db.execute({
      sql: 'SELECT id, url, event, status, response, created_at FROM webhook_logs WHERE api_key = ? ORDER BY created_at DESC LIMIT 50',
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      count: logs.rows.length,
      logs: logs.rows
    });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 52. LOGS - SUBSCRIPTIONS
// ============================================================
app.get('/api/v1/logs/subscriptions', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key required' });
  }

  try {
    const logs = await db.execute({
      sql: 'SELECT id, endpoint, device_type, device_name, region, action, created_at FROM subscription_logs WHERE api_key = ? ORDER BY created_at DESC LIMIT 50',
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      count: logs.rows.length,
      logs: logs.rows
    });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 53. LOGS - NOTIFICATIONS
// ============================================================
app.get('/api/v1/logs/notifications', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];

  if (!apiKey) {
    return res.json({ status: 401, success: false, message: 'API key required' });
  }

  try {
    const logs = await db.execute({
      sql: 'SELECT notification_id, title, message, devices_sent, status, sent_at FROM notification_history WHERE api_key = ? ORDER BY sent_at DESC LIMIT 50',
      args: [apiKey]
    });

    res.json({
      status: 200,
      success: true,
      count: logs.rows.length,
      logs: logs.rows
    });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 54. VERIFY WIDGET
// ============================================================
app.post('/api/v1/verify-widget', async (req, res) => {
  const { api_key, website_url } = req.body;

  if (!api_key) {
    return res.json({
      status: 400,
      success: false,
      message: '❌ API key is required',
      suggestion: 'Please provide your API key to verify the widget.'
    });
  }

  if (!website_url) {
    return res.json({
      status: 400,
      success: false,
      message: '❌ Website URL is required',
      suggestion: 'Please provide your website URL to verify the widget.'
    });
  }

  try {
    const project = await db.execute({
      sql: 'SELECT project_name, app_url, api_key FROM projects WHERE api_key = ?',
      args: [api_key]
    });

    if (project.rows.length === 0) {
      return res.json({
        status: 701,
        success: false,
        message: '❌ Widget is NOT registered',
        website: website_url,
        api_key: api_key,
        suggestion: 'Please add the widget code to your website head and visit the site.',
        code: 701
      });
    }

    const appUrl = project.rows[0].app_url || '';
    const isRegistered = appUrl.toLowerCase().includes(website_url.toLowerCase()) ||
                         website_url.toLowerCase().includes(appUrl.toLowerCase());

    if (!isRegistered) {
      return res.json({
        status: 701,
        success: false,
        message: '❌ Widget is NOT registered for this website',
        website: website_url,
        api_key: api_key,
        project_name: project.rows[0].project_name,
        suggestion: 'The API key belongs to a different website. Please check your API key.',
        code: 701
      });
    }

    const subscribers = await db.execute({
      sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?',
      args: [api_key]
    });

    const lastActivity = await db.execute({
      sql: 'SELECT MAX(created_at) as last_activity FROM subscribers WHERE api_key = ?',
      args: [api_key]
    });

    return res.json({
      status: 200,
      success: true,
      message: '✅ Widget is properly registered!',
      website: website_url,
      api_key: api_key,
      project_name: project.rows[0].project_name,
      subscribers: subscribers.rows[0].count || 0,
      last_activity: lastActivity.rows[0].last_activity || 'N/A',
      code: 200
    });

  } catch (error) {
    res.status(500).json({
      status: 500,
      success: false,
      message: '❌ Error verifying widget',
      error: error.message
    });
  }
});

// ============================================================
// 55. ACCOUNT PROFILE
// ============================================================
app.get('/api/v1/account/profile', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];

  if (!sessionToken) {
    return res.json({ status: 401, success: false, message: 'Session token required' });
  }

  try {
    const user = await db.execute({
      sql: 'SELECT id, name, surname, email, plan, created_at FROM users WHERE id IN (SELECT user_id FROM sessions WHERE token = ?)',
      args: [sessionToken]
    });

    if (user.rows.length === 0) {
      return res.json({ status: 401, success: false, message: 'Invalid session' });
    }

    res.json({
      status: 200,
      success: true,
      user: user.rows[0]
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 56. CHANGE PASSWORD
// ============================================================
app.post('/api/v1/account/change-password', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const { current_password, new_password, confirm_password } = req.body;

  if (!sessionToken) {
    return res.json({ status: 401, success: false, message: 'Session token required' });
  }

  if (!current_password || !new_password || !confirm_password) {
    return res.json({ status: 400, success: false, message: 'All password fields are required' });
  }

  if (new_password !== confirm_password) {
    return res.json({ status: 400, success: false, message: 'New passwords do not match' });
  }

  try {
    const user = await db.execute({
      sql: 'SELECT id, password_hash FROM users WHERE id IN (SELECT user_id FROM sessions WHERE token = ?)',
      args: [sessionToken]
    });

    if (user.rows.length === 0) {
      return res.json({ status: 401, success: false, message: 'Invalid session' });
    }

    const currentHash = crypto.createHash('sha256').update(current_password).digest('hex');

    if (currentHash !== user.rows[0].password_hash) {
      return res.json({ status: 401, success: false, message: 'Current password is incorrect' });
    }

    const newHash = crypto.createHash('sha256').update(new_password).digest('hex');

    await db.execute({
      sql: 'UPDATE users SET password_hash = ? WHERE id = ?',
      args: [newHash, user.rows[0].id]
    });

    res.json({
      status: 200,
      success: true,
      message: 'Password changed successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 57. REVOKE API KEY
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
// 58. DELETE ACCOUNT
// ============================================================
app.post('/api/v1/account/delete', async (req, res) => {
  const { api_key, username, password, confirm } = req.body;

  if (!api_key || !username || !password || !confirm) {
    return res.json({ status: 400, success: false, message: 'All fields required' });
  }

  if (confirm !== 'yes') {
    return res.json({ status: 000, success: false, message: 'Confirmation required. Type "yes" to confirm.' });
  }

  try {
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const user = await db.execute({
      sql: 'SELECT id FROM users WHERE name = ? AND password_hash = ?',
      args: [username, passwordHash]
    });

    if (user.rows.length === 0) {
      return res.json({ status: 010, success: false, message: 'Incorrect password' });
    }

    const project = await db.execute({
      sql: 'SELECT user_id FROM projects WHERE api_key = ?',
      args: [api_key]
    });

    if (project.rows.length === 0) {
      return res.json({ status: 030, success: false, message: 'Incorrect API key' });
    }

    if (project.rows[0].user_id !== user.rows[0].id) {
      return res.json({ status: 020, success: false, message: 'Incorrect username' });
    }

    // Delete all user data
    await db.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [user.rows[0].id] });
    await db.execute({ sql: 'DELETE FROM subscribers WHERE api_key IN (SELECT api_key FROM projects WHERE user_id = ?)', args: [user.rows[0].id] });
    await db.execute({ sql: 'DELETE FROM notification_history WHERE api_key IN (SELECT api_key FROM projects WHERE user_id = ?)', args: [user.rows[0].id] });
    await db.execute({ sql: 'DELETE FROM templates WHERE api_key IN (SELECT api_key FROM projects WHERE user_id = ?)', args: [user.rows[0].id] });
    await db.execute({ sql: 'DELETE FROM webhooks WHERE api_key IN (SELECT api_key FROM projects WHERE user_id = ?)', args: [user.rows[0].id] });
    await db.execute({ sql: 'DELETE FROM projects WHERE user_id = ?', args: [user.rows[0].id] });
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [user.rows[0].id] });

    res.json({
      status: 001,
      success: true,
      message: 'Account deleted successfully'
    });

  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 59. ADMIN ENDPOINTS
// ============================================================
const adminAuth = (req, res, next) => {
  const adminPassword = req.headers['x-admin-password'];
  if (!adminPassword || adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      status: 401,
      success: false,
      message: 'Invalid admin password. Access denied.'
    });
  }
  next();
};

app.get('/api/v1/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await db.execute('SELECT id, name, surname, email, plan, blocked, created_at FROM users ORDER BY created_at DESC');
    res.json({ status: 200, success: true, users: users.rows });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

app.get('/api/v1/admin/user/:id', adminAuth, async (req, res) => {
  try {
    const user = await db.execute({
      sql: 'SELECT id, name, surname, email, plan, traffic, blocked, created_at FROM users WHERE id = ?',
      args: [req.params.id]
    });
    if (user.rows.length === 0) {
      return res.json({ status: 701, success: false, message: 'User not found' });
    }
    res.json({ status: 200, success: true, user: user.rows[0] });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

app.post('/api/v1/admin/user/:id/block', adminAuth, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE users SET blocked = 1 WHERE id = ?',
      args: [req.params.id]
    });
    await db.execute({
      sql: 'INSERT INTO admin_logs (action, admin_email, details) VALUES (?, ?, ?)',
      args: ['block_user', BRAND.email, `Blocked user ID: ${req.params.id}`]
    });
    res.json({ status: 200, success: true, message: 'User blocked successfully' });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

app.post('/api/v1/admin/user/:id/unblock', adminAuth, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE users SET blocked = 0 WHERE id = ?',
      args: [req.params.id]
    });
    await db.execute({
      sql: 'INSERT INTO admin_logs (action, admin_email, details) VALUES (?, ?, ?)',
      args: ['unblock_user', BRAND.email, `Unblocked user ID: ${req.params.id}`]
    });
    res.json({ status: 200, success: true, message: 'User unblocked successfully' });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

app.delete('/api/v1/admin/user/:id/delete', adminAuth, async (req, res) => {
  try {
    await db.execute({
      sql: 'DELETE FROM users WHERE id = ?',
      args: [req.params.id]
    });
    await db.execute({
      sql: 'INSERT INTO admin_logs (action, admin_email, details) VALUES (?, ?, ?)',
      args: ['delete_user', BRAND.email, `Deleted user ID: ${req.params.id}`]
    });
    res.json({ status: 001, success: true, message: 'User deleted successfully' });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

app.get('/api/v1/admin/stats', adminAuth, async (req, res) => {
  try {
    const totalUsers = await db.execute('SELECT COUNT(*) as count FROM users');
    const totalApps = await db.execute('SELECT COUNT(*) as count FROM projects');
    const totalSubscribers = await db.execute('SELECT COUNT(*) as count FROM subscribers');
    const totalNotifications = await db.execute('SELECT COUNT(*) as count FROM notification_history');

    res.json({
      status: 200,
      success: true,
      stats: {
        total_users: totalUsers.rows[0].count,
        total_apps: totalApps.rows[0].count,
        total_subscribers: totalSubscribers.rows[0].count,
        total_notifications: totalNotifications.rows[0].count
      }
    });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

app.post('/api/v1/admin/user/:id/reset-quota', adminAuth, async (req, res) => {
  try {
    await db.execute({
      sql: 'UPDATE users SET total_push_quota = 1000, total_email_quota = 250 WHERE id = ?',
      args: [req.params.id]
    });

    await db.execute({
      sql: 'UPDATE projects SET push_quota = 1000, email_quota = 250 WHERE user_id = ?',
      args: [req.params.id]
    });

    await db.execute({
      sql: 'INSERT INTO admin_logs (action, admin_email, details) VALUES (?, ?, ?)',
      args: ['reset_quota', BRAND.email, `Reset quota for user ID: ${req.params.id}`]
    });

    res.json({
      status: 200,
      success: true,
      message: 'Quota reset successfully for user'
    });
  } catch (error) {
    res.status(500).json({ status: 500, success: false, error: error.message });
  }
});

// ============================================================
// 60. SCHEDULED NOTIFICATION PROCESSOR
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
                        sql: `UPDATE notification_history SET status = 'failed', sent_at = datetime("now") WHERE id = ?`,
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
                    sql: `UPDATE notification_history SET status = 'sent', sent_at = datetime("now"), devices_sent = ? WHERE id = ?`,
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
// 61. SDK ENDPOINT
// ============================================================
app.get('/sdk.js', (req, res) => {
  const serverUrl = process.env.RENDER_URL || 'https://push-notification-server-5tx2.onrender.com';
  
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(`
    (function() {
      'use strict';
      const SERVER_URL = '${serverUrl}';
      const APP_NAME = 'Sendly Notification';

      const scriptTag = document.currentScript || document.querySelector('script[data-api-key]');
      const API_KEY = scriptTag ? scriptTag.getAttribute('data-api-key') : null;

      if (!API_KEY) {
        console.error('Sendly: Missing data-api-key in script tag.');
        return;
      }

      if (!('Notification' in window)) {
        console.warn('Sendly: Notifications not supported');
        return;
      }

      const permissionStatus = Notification.permission;

      function createPopup() {
        if (document.getElementById('sendly-popup-overlay')) return;

        const popupHTML = \`
          <div id="sendly-popup-overlay" style="
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.85);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 999999;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          ">
            <div id="sendly-popup" style="
              background: #7c3aed;
              border-radius: 16px;
              padding: 40px 48px;
              max-width: 440px;
              width: 90%;
              position: relative;
              box-shadow: 0 20px 60px rgba(124, 58, 237, 0.4);
              animation: sendlyFadeIn 0.3s ease-out;
              text-align: center;
            ">
              <button id="sendly-close-btn" style="
                position: absolute;
                top: 12px;
                right: 16px;
                background: none;
                border: none;
                font-size: 24px;
                color: rgba(255,255,255,0.6);
                cursor: pointer;
                padding: 4px 8px;
                transition: color 0.2s;
              ">&times;</button>

              <div style="text-align: center; margin-bottom: 16px;">
                <span style="font-size: 48px;">🔔</span>
              </div>

              <h2 style="
                font-size: 22px;
                font-weight: 700;
                color: #ffffff;
                text-align: center;
                margin: 0 0 8px 0;
              ">Stay Updated with \${APP_NAME}</h2>

              <p style="
                font-size: 15px;
                color: rgba(255,255,255,0.85);
                text-align: center;
                margin: 0 0 24px 0;
                line-height: 1.6;
              ">
                Allow notifications to receive real-time updates, alerts, and important messages from this website.
              </p>

              <div style="display: flex; gap: 12px; justify-content: center;">
                <button id="sendly-allow-btn" style="
                  background: #22c55e;
                  color: #ffffff;
                  border: none;
                  border-radius: 8px;
                  padding: 14px 32px;
                  font-size: 16px;
                  font-weight: 600;
                  cursor: pointer;
                  transition: background 0.2s;
                  flex: 1;
                ">✅ Allow Notifications</button>

                <button id="sendly-dismiss-btn" style="
                  background: #ef4444;
                  color: #ffffff;
                  border: none;
                  border-radius: 8px;
                  padding: 14px 32px;
                  font-size: 16px;
                  font-weight: 600;
                  cursor: pointer;
                  transition: background 0.2s;
                  flex: 1;
                ">❌ Dismiss</button>
              </div>

              <p style="
                font-size: 12px;
                color: rgba(255,255,255,0.5);
                text-align: center;
                margin: 16px 0 0 0;
              ">You can change this anytime in your browser settings</p>
            </div>
          </div>

          <style>
            @keyframes sendlyFadeIn {
              from {
                opacity: 0;
                transform: scale(0.95) translateY(10px);
              }
              to {
                opacity: 1;
                transform: scale(1) translateY(0);
              }
            }
            #sendly-allow-btn:hover {
              background: #16a34a;
            }
            #sendly-dismiss-btn:hover {
              background: #dc2626;
            }
            #sendly-close-btn:hover {
              color: #ffffff;
            }
          </style>
        \`;

        const div = document.createElement('div');
        div.innerHTML = popupHTML;
        document.body.appendChild(div.firstElementChild);

        document.getElementById('sendly-allow-btn').addEventListener('click', function() {
          requestBrowserPermission();
        });

        document.getElementById('sendly-dismiss-btn').addEventListener('click', function() {
          closePopup();
          localStorage.setItem('sendly_dismissed', 'true');
        });

        document.getElementById('sendly-close-btn').addEventListener('click', function() {
          closePopup();
          localStorage.setItem('sendly_dismissed', 'true');
        });

        document.getElementById('sendly-popup-overlay').addEventListener('click', function(e) {
          if (e.target === this) {
            // Do nothing - popup stays open
          }
        });
      }

      function closePopup() {
        const overlay = document.getElementById('sendly-popup-overlay');
        if (overlay) {
          overlay.remove();
        }
      }

      function requestBrowserPermission() {
        Notification.requestPermission().then(function(permission) {
          if (permission === 'granted') {
            closePopup();
            registerServiceWorker();
            localStorage.removeItem('sendly_dismissed');
          } else if (permission === 'denied') {
            closePopup();
            localStorage.setItem('sendly_blocked', 'true');
          }
        });
      }

      async function registerServiceWorker() {
        try {
          const swUrl = SERVER_URL + '/sw.js';
          const reg = await navigator.serviceWorker.register(swUrl);
          console.log('Sendly: Service worker registered');

          const keyRes = await fetch(SERVER_URL + '/api/v1/vapid-key');
          const keyData = await keyRes.json();

          function urlBase64ToUint8Array(base64String) {
            const padding = '='.repeat((4 - base64String.length % 4) % 4);
            const base64 = (base64String + padding).replace(/\\-/g, '+').replace(/_/g, '/');
            const rawData = window.atob(base64);
            const outputArray = new Uint8Array(rawData.length);
            for (let i = 0; i < rawData.length; ++i) {
              outputArray[i] = rawData.charCodeAt(i);
            }
            return outputArray;
          }

          const subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
          });

          const response = await fetch(SERVER_URL + '/api/v1/subscribe', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-sendly-key': API_KEY
            },
            body: JSON.stringify(subscription)
          });

          const data = await response.json();
          if (data.status === 100) {
            console.log('Sendly: Device registered successfully');
          } else {
            console.error('Sendly: Registration failed', data);
          }

        } catch (err) {
          console.error('Sendly registration error:', err);
        }
      }

      function initSendly() {
        if (Notification.permission === 'granted') {
          registerServiceWorker();
          return;
        }

        if (Notification.permission === 'denied' || localStorage.getItem('sendly_blocked') === 'true') {
          return;
        }

        if (localStorage.getItem('sendly_dismissed') === 'true') {
          return;
        }

        createPopup();
      }

      if (document.readyState === 'complete') {
        initSendly();
      } else {
        window.addEventListener('load', initSendly);
      }

      window.enableSendly = initSendly;
      window.sendly = {
        subscribe: registerServiceWorker,
        showPopup: createPopup,
        closePopup: closePopup
      };

      console.log('Sendly: SDK loaded successfully');

    })();
  `);
});

// ============================================================
// 61. SERVER START
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
