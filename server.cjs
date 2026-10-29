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
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.static(__dirname));

// ============================================================
// 📛 BRAND INFORMATION
// ============================================================
const BRAND = {
  name: 'Sendly Notification', company: 'Henry Global Tech Industry', short: 'HGT',
  founder: 'Henry Kamsi Okwuabudike', email: 'kamsih924@gmail.com', website: 'https://hgt.com',
  built_date: '2026-08-16', powered_by: 'HGT'
};

// ============================================================
// 1. AUTO-GENERATE VAPID KEYS
// ============================================================
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  const keys = webpush.generateVAPIDKeys();
  process.env.VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  fs.appendFileSync('.env', `\nVAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
}

webpush.setVapidDetails(`mailto:${BRAND.email}`, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

// ============================================================
// 2. TURSO DATABASE
// ============================================================
const db = {
  async execute(query) {
    let sql = ""; let args = [];
    if (typeof query === "string") { sql = query; } 
    else {
      sql = query.sql;
      args = (query.args || []).map(val => {
        if (typeof val === "number") return { type: "float", value: val };
        if (val === null) return { type: "null" };
        return { type: "text", value: String(val) };
      });
    }
    let baseUrl = process.env.TURSO_URL ? process.env.TURSO_URL.replace(/\/$/, '') : '';
    if (baseUrl.startsWith('libsql://')) baseUrl = baseUrl.replace('libsql://', 'https://');
    if (!baseUrl) throw new Error("TURSO_URL is missing in .env");
    const response = await fetch(`${baseUrl}/v2/pipeline`, {
      method: "POST", headers: { "Authorization": `Bearer ${process.env.TURSO_AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ requests: [{ type: "execute", stmt: { sql, args } }, { type: "close" }] })
    });
    const data = await response.json();
    if (data.results && data.results[0] && data.results[0].type === "error") throw new Error(data.results[0].error.message);
    const resObj = data.results && data.results[0] && data.results[0].response && data.results[0].response.result;
    if (!resObj) return { rows: [], rowsAffected: 0 };
    const cols = (resObj.cols || []).map(c => c.name);
    const rows = (resObj.rows || []).map(row => {
      const rowObj = {};
      row.forEach((cell, idx) => { rowObj[cols[idx]] = cell ? cell.value : null; rowObj[idx] = cell ? cell.value : null; });
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
    await db.execute(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, surname TEXT, email TEXT UNIQUE, password_hash TEXT, traffic TEXT, total_push_quota INTEGER DEFAULT 1000, total_email_quota INTEGER DEFAULT 250, plan TEXT DEFAULT 'free', plan_expires_at DATETIME, blocked BOOLEAN DEFAULT 0, dark_mode BOOLEAN DEFAULT 0, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, token TEXT UNIQUE, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, project_name TEXT, app_name TEXT, app_url TEXT, api_key TEXT UNIQUE, push_quota INTEGER DEFAULT 1000, email_quota INTEGER DEFAULT 250, plan TEXT DEFAULT 'free', blocked BOOLEAN DEFAULT 0, crack_signals INTEGER DEFAULT 0, crack_locked_until DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS subscribers (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key TEXT, endpoint TEXT UNIQUE, p256dh TEXT, auth TEXT, device_type TEXT, device_name TEXT, region TEXT, subscriber_group TEXT DEFAULT 'all', created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS notification_history (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key TEXT, notification_id TEXT UNIQUE, title TEXT, message TEXT, image_url TEXT, icon_url TEXT, button1_name TEXT, button1_url TEXT, button2_name TEXT, button2_url TEXT, persistent BOOLEAN DEFAULT 0, scheduled_for DATETIME, sent_at DATETIME, devices_sent INTEGER DEFAULT 0, views INTEGER DEFAULT 0, clicks INTEGER DEFAULT 0, button1_clicks INTEGER DEFAULT 0, button2_clicks INTEGER DEFAULT 0, open_rate DECIMAL(5,2) DEFAULT 0, avg_view_time DECIMAL(5,2) DEFAULT 0, status TEXT DEFAULT 'pending', ab_test_group TEXT, custom_sound_url TEXT)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS webhooks (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key TEXT, url TEXT, event TEXT, active BOOLEAN DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE IF NOT EXISTS rate_limits (id INTEGER PRIMARY KEY AUTOINCREMENT, api_key TEXT, request_count INTEGER DEFAULT 0, last_reset DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    console.log('✅ Turso Database connected & schema verified.');
  } catch (error) { console.error('❌ Database initialization failed:', error); }
}
initDB();

// ============================================================
// 4. STATIC ROUTES
// ============================================================
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/sw.js', (req, res) => { res.setHeader('Content-Type', 'application/javascript'); res.sendFile(path.join(__dirname, 'sw.js')); });
app.get('/health', (req, res) => res.json({ status: 200, success: true, message: 'Server is healthy' }));
app.get('/api/v1/vapid-key', (req, res) => res.json({ publicKey: process.env.VAPID_PUBLIC_KEY }));

// ============================================================
// 5. AUTHENTICATION
// ============================================================
app.post('/api/v1/auth/register', async (req, res) => {
  const { name, surname, email, password, traffic } = req.body;
  if (!name || !surname || !email || !password || !traffic) return res.json({ status: 400, success: false, message: 'All fields are required' });
  try {
    const existingUser = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
    if (existingUser.rows.length > 0) return res.json({ status: 400, success: false, message: 'Email already registered. Please login.' });
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    await db.execute({ sql: 'INSERT INTO users (name, surname, email, password_hash, traffic) VALUES (?, ?, ?, ?, ?)', args: [name, surname, email, passwordHash, traffic] });
    const user = await db.execute({ sql: 'SELECT id FROM users WHERE email = ?', args: [email] });
    res.json({ status: 201, success: true, message: 'User registered successfully', user_id: user.rows[0].id, email: email });
  } catch (error) { res.status(500).json({ status: 500, success: false, error: error.message }); }
});

app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.json({ status: 400, success: false, message: 'Email and password required' });
  try {
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const user = await db.execute({ sql: 'SELECT id, name, surname, email, plan, blocked FROM users WHERE email = ? AND password_hash = ?', args: [email, passwordHash] });
    if (user.rows.length === 0) return res.json({ status: 401, success: false, message: 'Invalid email or password' });
    if (user.rows[0].blocked === 1) return res.json({ status: 403, success: false, message: 'Account blocked. Contact support.' });
    const sessionToken = crypto.randomBytes(32).toString('hex');
    await db.execute({ sql: 'INSERT OR REPLACE INTO sessions (user_id, token) VALUES (?, ?)', args: [user.rows[0].id, sessionToken] });
    res.json({ status: 200, success: true, message: 'Login successful', user_id: user.rows[0].id, name: user.rows[0].name, surname: user.rows[0].surname || '', email: user.rows[0].email, plan: user.rows[0].plan || 'free', session_token: sessionToken });
  } catch (error) { res.status(500).json({ status: 500, success: false, error: error.message }); }
});

app.post('/api/v1/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ status: 400, success: false, message: 'Token required' });
  try {
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client('136019833914-lhou851uparpfjd4vu0hp5e7mfpqf134.apps.googleusercontent.com');
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: '136019833914-lhou851uparpfjd4vu0hp5e7mfpqf134.apps.googleusercontent.com'
    });
    const payload = ticket.getPayload();
    const { email, name } = payload;
    const existingUser = await db.execute({ sql: 'SELECT id, name, email, plan, blocked FROM users WHERE email = ?', args: [email] });
    if (existingUser.rows.length > 0) {
      const user = existingUser.rows[0];
      if (user.blocked === 1) return res.json({ status: 403, success: false, message: 'Account blocked.' });
      const sessionToken = crypto.randomBytes(32).toString('hex');
      await db.execute({ sql: 'INSERT OR REPLACE INTO sessions (user_id, token) VALUES (?, ?)', args: [user.id, sessionToken] });
      return res.json({ status: 200, success: true, message: 'Login successful', user_id: user.id, name: user.name || name, email: user.email, plan: user.plan || 'free', session_token: sessionToken });
    } else {
      await db.execute({ sql: 'INSERT INTO users (name, email, password_hash, traffic) VALUES (?, ?, ?, ?)', args: [name || 'Google User', email, 'google_oauth_' + Date.now(), 'google'] });
      const newUser = await db.execute({ sql: 'SELECT id, name, email, plan FROM users WHERE email = ?', args: [email] });
      const user = newUser.rows[0];
      const sessionToken = crypto.randomBytes(32).toString('hex');
      await db.execute({ sql: 'INSERT OR REPLACE INTO sessions (user_id, token) VALUES (?, ?)', args: [user.id, sessionToken] });
      return res.json({ status: 201, success: true, message: 'Account created and logged in', user_id: user.id, name: user.name, email: user.email, plan: user.plan || 'free', session_token: sessionToken });
    }
  } catch (error) { res.status(500).json({ status: 500, success: false, message: 'Google auth failed: ' + error.message }); }
});

app.get('/api/v1/account/profile', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.status(401).json({ status: 401, message: 'Session required' });
  try {
    const user = await db.execute({ sql: 'SELECT name, surname, email, plan FROM users WHERE id IN (SELECT user_id FROM sessions WHERE token = ?)', args: [sessionToken] });
    if (user.rows.length === 0) return res.status(404).json({ status: 404, message: 'User not found' });
    res.json({ status: 200, success: true, user: user.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/account/delete', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  const { api_key, username, password, confirm } = req.body;
  if (!sessionToken) return res.status(401).json({ status: 401, success: false, message: 'Session token required' });
  if (confirm !== 'yes') return res.status(400).json({ status: 400, success: false, message: 'Confirmation required' });
  try {
    const userRes = await db.execute({ sql: 'SELECT user_id FROM sessions WHERE token = ?', args: [sessionToken] });
    if (userRes.rows.length === 0) return res.status(401).json({ status: 401, success: false, message: 'Invalid or expired session' });
    const userId = userRes.rows[0].user_id;
    const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
    const verifyUser = await db.execute({ sql: 'SELECT id FROM users WHERE id = ? AND password_hash = ?', args: [userId, passwordHash] });
    if (verifyUser.rows.length === 0) return res.status(403).json({ status: 403, success: false, message: 'Incorrect password' });
    await db.execute({ sql: 'DELETE FROM subscribers WHERE api_key IN (SELECT api_key FROM projects WHERE user_id = ?)', args: [userId] });
    await db.execute({ sql: 'DELETE FROM notification_history WHERE api_key IN (SELECT api_key FROM projects WHERE user_id = ?)', args: [userId] });
    await db.execute({ sql: 'DELETE FROM templates WHERE api_key IN (SELECT api_key FROM projects WHERE user_id = ?)', args: [userId] });
    await db.execute({ sql: 'DELETE FROM webhooks WHERE api_key IN (SELECT api_key FROM projects WHERE user_id = ?)', args: [userId] });
    await db.execute({ sql: 'DELETE FROM projects WHERE user_id = ?', args: [userId] });
    await db.execute({ sql: 'DELETE FROM sessions WHERE user_id = ?', args: [userId] });
    await db.execute({ sql: 'DELETE FROM users WHERE id = ?', args: [userId] });
    res.json({ status: 001, success: true, message: 'Account and all associated data deleted permanently' });
  } catch (error) { res.status(500).json({ status: 500, success: false, error: error.message }); }
});

// ============================================================
// 6. APP CREATION & MANAGEMENT
// ============================================================
app.post('/api/v1/apps/create', async (req, res) => {
  const { app_name, app_url } = req.body;
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.json({ status: 401, success: false, message: 'Session token required. Please login.' });
  if (!app_name || !app_url) return res.json({ status: 400, success: false, message: 'App name and URL are required' });
  try {
    const user = await db.execute({ sql: 'SELECT id, plan FROM users WHERE id IN (SELECT user_id FROM sessions WHERE token = ?)', args: [sessionToken] });
    if (user.rows.length === 0) return res.json({ status: 401, success: false, message: 'Invalid session. Please login again.' });
    const userId = user.rows[0].id; const plan = user.rows[0].plan || 'free';
    let appLimit = 5; if (plan === 'pro') appLimit = 20; if (plan === 'enterprise') appLimit = 100;
    const appCount = await db.execute({ sql: 'SELECT COUNT(*) as count FROM projects WHERE user_id = ?', args: [userId] });
    if (appCount.rows[0].count >= appLimit) return res.json({ status: 702, success: false, message: `App limit reached. Upgrade your plan to create more apps. (Limit: ${appLimit})` });
    const rawKey = crypto.randomBytes(16).toString('hex');
    const normalizedAppName = app_name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const apiKey = `sendly_live_${normalizedAppName}_${rawKey}`;
    await db.execute({ sql: 'INSERT INTO projects (user_id, project_name, app_name, app_url, api_key, plan, push_quota, email_quota) VALUES (?, ?, ?, ?, ?, ?, 1000, 250)', args: [userId, app_name, app_name, app_url, apiKey, plan] });
    const newAppCount = await db.execute({ sql: 'SELECT COUNT(*) as count FROM projects WHERE user_id = ?', args: [userId] });
    res.json({ status: 201, success: true, message: 'App created successfully', app_id: newAppCount.rows[0].count, app_name, app_url, api_key: apiKey, push_quota: 1000, email_quota: 250, plan });
  } catch (error) { res.status(500).json({ status: 500, success: false, error: error.message }); }
});

app.get('/api/v1/apps/list', async (req, res) => {
  const sessionToken = req.headers['x-session-token'];
  if (!sessionToken) return res.json({ status: 401, success: false, message: 'Session token required. Please login.' });
  try {
    const user = await db.execute({ sql: 'SELECT user_id FROM sessions WHERE token = ?', args: [sessionToken] });
    if (user.rows.length === 0) return res.json({ status: 401, success: false, message: 'Invalid session. Please login again.' });
    const userId = user.rows[0].user_id;
    const apps = await db.execute({ sql: 'SELECT id, project_name, app_name, app_url, api_key, push_quota, email_quota, plan, created_at FROM projects WHERE user_id = ? ORDER BY created_at DESC', args: [userId] });
    for (let app of apps.rows) {
      const count = await db.execute({ sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?', args: [app.api_key] });
      app.subscribers = count.rows[0].count;
    }
    res.json({ status: 200, success: true, apps: apps.rows });
  } catch (error) { res.status(500).json({ status: 500, success: false, error: error.message }); }
});

app.delete('/api/v1/apps/:id', async (req, res) => {
  const sessionToken = req.headers['x-session-token']; const appId = req.params.id;
  if (!sessionToken) return res.json({ status: 401, success: false, message: 'Session token required' });
  try {
    const user = await db.execute({ sql: 'SELECT user_id FROM sessions WHERE token = ?', args: [sessionToken] });
    if (user.rows.length === 0) return res.json({ status: 401, success: false, message: 'Invalid session' });
    const userId = user.rows[0].user_id;
    const project = await db.execute({ sql: 'SELECT id, api_key FROM projects WHERE id = ? AND user_id = ?', args: [appId, userId] });
    if (project.rows.length === 0) return res.json({ status: 701, success: false, message: 'App not found' });
    const apiKey = project.rows[0].api_key;
    await db.execute({ sql: 'DELETE FROM subscribers WHERE api_key = ?', args: [apiKey] });
    await db.execute({ sql: 'DELETE FROM notification_history WHERE api_key = ?', args: [apiKey] });
    await db.execute({ sql: 'DELETE FROM projects WHERE id = ?', args: [appId] });
    res.json({ status: 001, success: true, message: 'App and all associated data deleted permanently' });
  } catch (error) { res.status(500).json({ status: 500, success: false, error: error.message }); }
});

// ============================================================
// 7. SUBSCRIBERS & TRACKING
// ============================================================
app.post('/api/v1/subscribe', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const { endpoint, keys, device_type, device_name, region } = req.body;
  if (!apiKey || !endpoint || !keys) return res.status(400).json({ success: false, error: 'Missing required payload parameters.' });
  try {
    const project = await db.execute({ sql: 'SELECT api_key, blocked FROM projects WHERE api_key = ?', args: [apiKey] });
    if (project.rows.length === 0) return res.status(401).json({ status: 401, success: false, error: 'Invalid API Key.' });
    if (project.rows[0].blocked === 1) return res.status(403).json({ status: 403, success: false, error: 'API key is blocked.' });
    
    await db.execute({
      sql: `INSERT INTO subscribers (api_key, endpoint, p256dh, auth, device_type, device_name, region)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET 
              p256dh = excluded.p256dh, 
              auth = excluded.auth,
              region = CASE WHEN excluded.region != 'unknown' AND excluded.region != '' THEN excluded.region ELSE subscribers.region END`,
      args: [apiKey, endpoint, keys.p256dh, keys.auth, device_type || 'unknown', device_name || 'unknown', region || 'unknown']
    });
    res.json({ status: 100, success: true, message: 'Device registered for push notifications successfully.', brand: BRAND.name });
  } catch (error) { res.status(500).json({ status: 500, success: false, error: error.message }); }
});

app.get('/api/v1/subscribers', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  if (!apiKey) return res.json({ status: 401, success: false, message: 'API key is required' });
  try {
    const result = await db.execute({ sql: 'SELECT id, endpoint, device_type, device_name, region, subscriber_group, created_at FROM subscribers WHERE api_key = ? ORDER BY created_at DESC', args: [apiKey] });
    res.json({ status: 200, success: true, count: result.rows.length, subscribers: result.rows });
  } catch (error) { res.status(500).json({ status: 500, success: false, error: error.message }); }
});

app.get('/api/v1/analytics/countries', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  if (!apiKey) return res.status(401).json({ status: 401, message: 'API key required' });
  try {
    const stats = await db.execute({ sql: `SELECT region as country, COUNT(*) as clicks FROM subscribers WHERE api_key = ? AND region IS NOT NULL GROUP BY region ORDER BY clicks DESC LIMIT 5`, args: [apiKey] });
    res.json({ status: 200, success: true, top_countries: stats.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/analytics/track', async (req, res) => {
  const { notification_id, action } = req.body;
  if (!notification_id) return res.status(400).json({ error: 'Missing ID' });
  try {
    if (action === 'click') {
      await db.execute({ sql: 'UPDATE notification_history SET clicks = clicks + 1, views = views + 1 WHERE notification_id = ?', args: [notification_id] });
    } else if (action === 'open') {
      await db.execute({ sql: 'UPDATE notification_history SET views = views + 1 WHERE notification_id = ?', args: [notification_id] });
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/analytics/range', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  if (!apiKey) return res.status(401).json({ status: 401, message: 'API key required' });
  try {
    const stats = await db.execute({ sql: `SELECT COUNT(*) as total_sent, COALESCE(SUM(devices_sent), 0) as total_delivered, COALESCE(SUM(views), 0) as total_views, COALESCE(SUM(clicks), 0) as total_clicks FROM notification_history WHERE api_key = ? AND status = 'sent'`, args: [apiKey] });
    const row = stats.rows[0] || {};
    const sent = parseInt(row.total_sent) || 0;
    const delivered = parseInt(row.total_delivered) || 0;
    const views = parseInt(row.total_views) || 0;
    const clicks = parseInt(row.total_clicks) || 0;
    const successRate = sent > 0 ? Math.min(100, ((delivered / sent) * 100)).toFixed(1) : 0;
    const openRate = delivered > 0 ? ((views / delivered) * 100).toFixed(1) : 0;
    const clickRate = delivered > 0 ? ((clicks / delivered) * 100).toFixed(1) : 0;
    res.json({ status: 200, success: true, analytics: { total_notifications_sent: sent, total_delivered: delivered, total_views: views, total_clicks: clicks, open_rate: parseFloat(openRate), click_through_rate: parseFloat(clickRate), delivery_rate: parseFloat(successRate) } });
  } catch (e) { res.status(500).json({ status: 500, message: e.message }); }
});

app.get('/api/v1/analytics/notification/:id', async (req, res) => {
  const apiKey = req.headers['x-sendly-key']; const notifId = req.params.id;
  if (!apiKey) return res.status(401).json({ status: 401, message: 'API key required' });
  try {
    const result = await db.execute({ sql: 'SELECT title, devices_sent, views, clicks, button1_clicks, button2_clicks, status, sent_at FROM notification_history WHERE notification_id = ? AND api_key = ?', args: [notifId, apiKey] });
    if (result.rows.length === 0) return res.status(404).json({ status: 404, message: 'Notification not found' });
    res.json({ status: 200, success: true, notification: result.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 8. SEND NOTIFICATION
// ============================================================
app.post('/api/v1/send', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  const { channel, title, message, recipient, image, image_url, icon, icon_url, button1_name, button1_url, button2_name, button2_url, persistent, scheduled_for, custom_sound_url, ab_test_group, subscriber_group } = req.body;

  if (!apiKey) return res.status(401).json({ status: 401, error: 'Unauthorized', message: 'API key is missing' });
  if (!title || !message) return res.status(400).json({ status: 400, success: false, message: 'Title and message are required' });

  try {
    const project = await db.execute({ sql: 'SELECT user_id, push_quota, email_quota, blocked, plan FROM projects WHERE api_key = ?', args: [apiKey] });
    if (project.rows.length === 0) return res.status(401).json({ status: 401, error: 'Unauthorized', message: 'Invalid API Key' });
    if (project.rows[0].blocked === 1) return res.status(403).json({ status: 403, success: false, error: 'API key is blocked.' });

    const notificationId = `sendly_msg_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

    // 🛑 SCHEDULE INTERCEPTOR
    if (scheduled_for) {
      await db.execute({
        sql: `INSERT INTO notification_history (api_key, notification_id, title, message, image_url, icon_url, button1_name, button1_url, button2_name, button2_url, persistent, scheduled_for, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled')`,
        args: [apiKey, notificationId, title, message, image || image_url || '', icon || icon_url || '', button1_name || '', button1_url || '', button2_name || '', button2_url || '', persistent ? 1 : 0, scheduled_for]
      });
      return res.json({ status: 201, success: true, message: '✅ Notification Scheduled!', notification_id: notificationId, scheduled_for: scheduled_for });
    }

    if (channel === 'push') {
      const currentQuota = project.rows[0].push_quota !== null ? Number(project.rows[0].push_quota) : 1000;
      if (currentQuota <= 0) return res.status(702).json({ status: 702, error: 'Limit Reached', message: 'Push notification quota exhausted. Please upgrade your plan.' });

      let subscriberQuery = 'SELECT endpoint, p256dh, auth FROM subscribers WHERE api_key = ?';
      let args = [apiKey];
      if (subscriber_group && subscriber_group !== 'all') { subscriberQuery += ' AND subscriber_group = ?'; args.push(subscriber_group); }
      const subscribers = await db.execute({ sql: subscriberQuery, args });
      if (subscribers.rows.length === 0) return res.json({ status: 200, success: true, message: 'No devices registered.' });

      await db.execute({
        sql: `INSERT INTO notification_history (api_key, notification_id, title, message, image_url, icon_url, button1_name, button1_url, button2_name, button2_url, persistent, scheduled_for, ab_test_group, custom_sound_url, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')`,
        args: [apiKey, notificationId, title, message, image || image_url || '', icon || icon_url || '', button1_name || '', button1_url || '', button2_name || '', button2_url || '', persistent ? 1 : 0, null, null, custom_sound_url || '']
      });

      const payload = {
        title, body: message, icon: icon || icon_url || '/icon.png', image: image || image_url || '', badge: '/badge.png', vibrate: [200, 100, 200],
        data: { url: '/', notification_id: notificationId, button1_url: button1_url || '', button2_url: button2_url || '' }
      };

      const actions = [];
      if (button1_name && button1_url) actions.push({ action: 'button1', title: button1_name });
      if (button2_name && button2_url) actions.push({ action: 'button2', title: button2_name });
      if (actions.length > 0) payload.actions = actions;
      if (custom_sound_url) payload.sound = custom_sound_url;

      let successCount = 0;
      const pushPromises = subscribers.rows.map(async (sub) => {
        try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload)); successCount++; } 
        catch (err) { if (err.statusCode === 410 || err.statusCode === 404) await db.execute({ sql: 'DELETE FROM subscribers WHERE endpoint = ?', args: [sub.endpoint] }); }
      });

      await Promise.all(pushPromises);
      await db.execute({ sql: `UPDATE notification_history SET devices_sent = ?, status = 'sent', sent_at = datetime('now') WHERE notification_id = ?`, args: [successCount, notificationId] });
      
      const newQuota = currentQuota - successCount;
      await db.execute({ sql: 'UPDATE projects SET push_quota = ? WHERE api_key = ?', args: [newQuota, apiKey] });

      return res.json({ status: 201, success: true, channel: 'push', notification_id: notificationId, message: `Push notification broadcasted to ${successCount} device(s).`, remaining_quota: newQuota, brand: BRAND.name });
    }
  } catch (error) { res.status(500).json({ status: 500, error: 'Internal Server Error', message: error.message }); }
});

// ============================================================
// 9. NOTIFICATIONS HISTORY & SCHEDULED// ============================================================
app.get('/api/v1/notifications/list', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  if (!apiKey) return res.status(401).json({ status: 401, message: 'API key required' });
  try {
    const logs = await db.execute({ sql: 'SELECT notification_id, title, message, devices_sent, views, clicks, status, sent_at, scheduled_for FROM notification_history WHERE api_key = ? ORDER BY id DESC LIMIT 50', args: [apiKey] });
    res.json({ status: 200, success: true, notifications: logs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/v1/notifications/scheduled', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  if (!apiKey) return res.status(401).json({ status: 401, message: 'API key required' });
  try {
    const logs = await db.execute({ sql: 'SELECT notification_id, title, message, scheduled_for FROM notification_history WHERE api_key = ? AND status = "scheduled" ORDER BY scheduled_for ASC', args: [apiKey] });
    res.json({ status: 200, success: true, scheduled: logs.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/notification/:id/resend', async (req, res) => {
  const apiKey = req.headers['x-sendly-key']; const notifId = req.params.id;
  if (!apiKey) return res.status(401).json({ status: 401, message: 'API key required' });
  try {
    const orig = await db.execute({ sql: 'SELECT title, message FROM notification_history WHERE notification_id = ? AND api_key = ?', args: [notifId, apiKey] });
    if (orig.rows.length === 0) return res.status(404).json({ status: 404, message: 'Original notification not found' });
    const { title, message } = orig.rows[0];
    const newNotifId = `sendly_msg_${Date.now()}`;
    await db.execute({ sql: 'INSERT INTO notification_history (api_key, notification_id, title, message, status) VALUES (?, ?, ?, ?, "sent")', args: [apiKey, newNotifId, title, message] });
    const subs = await db.execute({ sql: 'SELECT endpoint, p256dh, auth FROM subscribers WHERE api_key = ?', args: [apiKey] });
    let successCount = 0;
    const payload = JSON.stringify({ title, body: message, data: { notification_id: newNotifId } });
    for (const sub of subs.rows) {
        try { await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload); successCount++; } catch(e) {}
    }
    await db.execute({ sql: 'UPDATE notification_history SET devices_sent = ? WHERE notification_id = ?', args: [successCount, newNotifId] });
    res.json({ status: 201, success: true, new_notification_id: newNotifId, message: 'Resent successfully' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/v1/notification/:id', async (req, res) => {
  const apiKey = req.headers['x-sendly-key']; const notifId = req.params.id;
  if (!apiKey) return res.status(401).json({ status: 401, message: 'API key required' });
  try {
    await db.execute({ sql: 'DELETE FROM notification_history WHERE notification_id = ? AND api_key = ?', args: [notifId, apiKey] });
    res.json({ status: 001, success: true, message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/v1/notification/:id/cancel', async (req, res) => {
  const apiKey = req.headers['x-sendly-key']; const notifId = req.params.id;
  if (!apiKey) return res.status(401).json({ status: 401, message: 'API key required' });
  try {
    await db.execute({ sql: 'UPDATE notification_history SET status = "cancelled" WHERE notification_id = ? AND api_key = ?', args: [notifId, apiKey] });
    res.json({ status: 001, success: true, message: 'Cancelled' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================
// 10. VERIFY WIDGET
// ============================================================
app.post('/api/v1/verify-widget', async (req, res) => {
  try {
    let { api_key, website_url } = req.body;
    if (!api_key) return res.json({ status: 400, success: false, message: 'API key required' });
    if (!website_url) return res.json({ status: 400, success: false, message: 'Website URL required' });
    if (!website_url.startsWith('http://') && !website_url.startsWith('https://')) return res.json({ status: 400, success: false, message: '❌ Invalid URL. You MUST include https:// or http://' });
    const project = await db.execute({ sql: 'SELECT project_name FROM projects WHERE api_key = ?', args: [api_key] });
    if (project.rows.length === 0) return res.json({ status: 404, success: false, message: '❌ Invalid API Key' });
    let htmlContent = '';
    try {
      const response = await fetch(website_url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) return res.json({ status: 400, success: false, message: '❌ Could not reach website. Status: ' + response.status });
      htmlContent = await response.text();
    } catch (e) { return res.json({ status: 400, success: false, message: '❌ Website is offline or URL is invalid.' }); }
    if (!htmlContent.includes(api_key)) return res.json({ status: 404, success: false, message: '❌ Config NOT found on this website.', suggestion: 'The API key was not found in the HTML.' });
    const subs = await db.execute({ sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?', args: [api_key] });
    return res.json({ status: 200, success: true, message: '✅ Widget Verified!', project_name: project.rows[0].project_name, subscribers: subs.rows[0].count || 0 });
  } catch (e) { return res.status(500).json({ status: 500, success: false, message: '❌ Server Error: ' + e.message }); }
});

// ============================================================
// 11. SCHEDULED NOTIFICATION PROCESSOR
// ============================================================


// ============================================================
// 12. START SERVER
// ============================================================


// ============================================================
// 64. MISSING ENDPOINTS (RESTORED)
// ============================================================
app.get('/api/v1/validate-key', async (req, res) => {
  const apiKey = req.headers['x-sendly-key'];
  if (!apiKey) return res.json({ status: 401, success: false, message: 'API key is required' });
  try {
    const project = await db.execute({ sql: 'SELECT project_name, app_name, api_key, plan, blocked, push_quota, email_quota, crack_signals, crack_locked_until FROM projects WHERE api_key = ?', args: [apiKey] });
    if (project.rows.length === 0) return res.json({ status: 701, success: false, message: 'No such API key' });
    const proj = project.rows[0];
    if (proj.blocked === 1) return res.json({ status: 403, success: false, message: 'API key has been blocked.' });
    res.json({
      status: 200, success: true, message: 'API key is active',
      project: {
        name: proj.project_name, app_name: proj.app_name, plan: proj.plan || 'free',
        push_quota_remaining: parseInt(proj.push_quota) || 0,
        email_quota_remaining: parseInt(proj.email_quota) || 0,
        crack_signals: proj.crack_signals || 0
      }
    });
  } catch (error) { res.status(500).json({ status: 500, success: false, error: error.message }); }
});

app.post('/api/v1/verify-widget', async (req, res) => {
  try {
    let { api_key, website_url } = req.body;
    if (!api_key) return res.json({ status: 400, success: false, message: 'API key required' });
    if (!website_url) return res.json({ status: 400, success: false, message: 'Website URL required' });
    if (!website_url.startsWith('http://') && !website_url.startsWith('https://')) return res.json({ status: 400, success: false, message: '❌ Invalid URL. You MUST include https:// or http://' });
    
    const project = await db.execute({ sql: 'SELECT project_name FROM projects WHERE api_key = ?', args: [api_key] });
    if (project.rows.length === 0) return res.json({ status: 404, success: false, message: '❌ Invalid API Key' });

    let htmlContent = '';
    try {
      const response = await fetch(website_url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000) });
      if (!response.ok) return res.json({ status: 400, success: false, message: '❌ Could not reach website. Status: ' + response.status });
      htmlContent = await response.text();
    } catch (e) { return res.json({ status: 400, success: false, message: '❌ Website is offline or URL is invalid.' }); }

    if (!htmlContent.includes(api_key)) return res.json({ status: 404, success: false, message: '❌ Config NOT found on this website.', suggestion: 'The API key was not found in the HTML.' });

    const subs = await db.execute({ sql: 'SELECT COUNT(*) as count FROM subscribers WHERE api_key = ?', args: [api_key] });
    return res.json({ status: 200, success: true, message: '✅ Widget Verified!', project_name: project.rows[0].project_name, subscribers: subs.rows[0].count || 0 });
  } catch (e) { return res.status(500).json({ status: 500, success: false, message: '❌ Server Error: ' + e.message }); }
});

// ============================================================
// BACKGROUND SCHEDULER (FIXED FOR TURSO UTC)
// ============================================================


// ============================================================
// 12. START SERVER
// ============================================================


// ============================================================
// BACKGROUND SCHEDULER (NODE.JS TIME COMPARISON)
// ============================================================


// ============================================================
// 12. START SERVER
// ============================================================


// ============================================================
// ULTIMATE SCHEDULER (JAVASCRIPT TIME CHECK)
// ============================================================
async function processScheduledNotifications() {
    try {
        // 1. Get ALL scheduled notifications, regardless of time
        console.log("🔍 CHECKING SCHEDULED ROWS:", scheduled ? scheduled.rows.length : 0);
        if (scheduled && scheduled.rows) console.log("Times:", scheduled.rows.map(r => r.scheduled_for));
        console.log("🕒 CURRENT SERVER UTC TIME:", new Date().toISOString());
        const scheduled = await db.execute({ 
            sql: "SELECT id, api_key, title, message, image_url, icon_url, button1_name, button1_url, button2_name, button2_url, custom_sound_url, notification_id, scheduled_for FROM notification_history WHERE status = 'scheduled'"
        });

        if (!scheduled || !scheduled.rows || scheduled.rows.length === 0) return;

        const now = new Date();

        for (const notif of scheduled.rows) {
            try {
                // 2. Parse the scheduled time in JavaScript
                if (!notif.scheduled_for) continue;
                
                // Turso might return it as a string or Date. We force it to a Date object.
                let scheduledDate = new Date(notif.scheduled_for);
                
                // If the date is invalid, skip it
                if (isNaN(scheduledDate.getTime())) continue;

                // 3. Compare times in JavaScript
                if (scheduledDate <= now) {
                    console.log(`🚀 Time reached for ${notif.notification_id}. Sending...`);
                    
                    const subscribers = await db.execute({ 
                        sql: 'SELECT endpoint, p256dh, auth FROM subscribers WHERE api_key = ?', 
                        args: [notif.api_key] 
                    });

                    if (subscribers.rows.length === 0) {
                        await db.execute({ sql: "UPDATE notification_history SET status = 'failed' WHERE id = ?", args: [notif.id] });
                        continue;
                    }

                    const payload = {
                        title: notif.title, body: notif.message, icon: notif.icon_url || '/icon.png', image: notif.image_url || '', badge: '/badge.png', vibrate: [200, 100, 200],
                        data: { url: '/', notification_id: notif.notification_id, button1_url: notif.button1_url || '', button2_url: notif.button2_url || '' }
                    };

                    const actions = [];
                    if (notif.button1_name && notif.button1_url) actions.push({ action: 'button1', title: notif.button1_name });
                    if (notif.button2_name && notif.button2_url) actions.push({ action: 'button2', title: notif.button2_name });
                    if (actions.length > 0) payload.actions = actions;
                    if (notif.custom_sound_url) payload.sound = notif.custom_sound_url;

                    const finalPayload = JSON.stringify(payload);
                    let successCount = 0;

                    for (const sub of subscribers.rows) {
                        try {
                            await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, finalPayload);
                            successCount++;
                        } catch (err) {
                            if (err.statusCode === 410 || err.statusCode === 404) {
                                await db.execute({ sql: 'DELETE FROM subscribers WHERE endpoint = ?', args: [sub.endpoint] });
                            }
                        }
                    }

                    await db.execute({ sql: "UPDATE notification_history SET status = 'sent', sent_at = datetime('now'), devices_sent = ? WHERE id = ?", args: [successCount, notif.id] });
                    console.log(`✅ Sent scheduled notification ${notif.notification_id} to ${successCount} devices`);
                }
            } catch (err) {
                console.error(`❌ Failed to send scheduled notification ${notif.id}:`, err);
                await db.execute({ sql: "UPDATE notification_history SET status = 'failed' WHERE id = ?", args: [notif.id] });
            }
        }
    } catch (error) {
        console.error('❌ Scheduler Error:', error);
    }
}

setInterval(processScheduledNotifications, 15000);
setTimeout(processScheduledNotifications, 5000);

// ============================================================
// 12. START SERVER
// ============================================================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
