import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { createStore } from './store.js';
import { fetchChatters, exchangeCodeForToken, fetchMe, fetchUserByLogin, refreshAccessToken } from './twitch.js';
import { createEnricher } from './enrich.js';
import { createAuthStore } from './authStore.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const pollMs = Number(process.env.POLL_MS || 15000);

const staticCfg = {
  clientId: process.env.TWITCH_CLIENT_ID,
  clientSecret: process.env.TWITCH_CLIENT_SECRET,
  redirectUri: process.env.TWITCH_REDIRECT_URI || `http://localhost:${port}/auth/callback`
};

const auth = {
  token: process.env.TWITCH_USER_ACCESS_TOKEN || null,
  refreshToken: null,
  tokenExpiresAt: null,
  moderatorId: process.env.TWITCH_MODERATOR_ID || null,
  broadcasterId: process.env.TWITCH_BROADCASTER_ID || null,
  broadcasterLogin: process.env.TWITCH_BROADCASTER_LOGIN || null,
  meLogin: null,
  tokenScopes: []
};

const oauthState = new Map();
const authStore = createAuthStore();

if (!staticCfg.clientId) console.warn('[warn] missing env: TWITCH_CLIENT_ID');
if (!staticCfg.clientSecret) console.warn('[warn] missing env: TWITCH_CLIENT_SECRET');

const store = createStore(process.env.DB_PATH || './tracker.db');

(function bootAuthFromDisk(){
  const saved = authStore.load();
  if (!saved) return;
  auth.token = saved.token || auth.token;
  auth.refreshToken = saved.refreshToken || null;
  auth.tokenExpiresAt = saved.tokenExpiresAt || null;
  auth.moderatorId = saved.moderatorId || auth.moderatorId;
  auth.meLogin = saved.meLogin || null;
  auth.broadcasterId = saved.broadcasterId || auth.broadcasterId;
  auth.broadcasterLogin = saved.broadcasterLogin || auth.broadcasterLogin;
  auth.tokenScopes = saved.tokenScopes || [];
})();

function persistAuth(){
  authStore.save({
    token: auth.token,
    refreshToken: auth.refreshToken,
    tokenExpiresAt: auth.tokenExpiresAt,
    moderatorId: auth.moderatorId,
    meLogin: auth.meLogin,
    broadcasterId: auth.broadcasterId,
    broadcasterLogin: auth.broadcasterLogin,
    tokenScopes: auth.tokenScopes
  });
}
const cfgForEnrich = {
  get clientId() { return staticCfg.clientId; },
  get userAccessToken() { return auth.token; }
};
const enricher = createEnricher({ cfg: cfgForEnrich, store });

let current = store.getOpenSet(auth.broadcasterLogin || '__none__');
let lastPollAt = null;
let lastError = null;

async function ensureFreshToken() {
  if (!auth.refreshToken) return;
  if (!auth.tokenExpiresAt) return;
  if (Date.now() < auth.tokenExpiresAt - 60_000) return;

  const refreshed = await refreshAccessToken({
    clientId: staticCfg.clientId,
    clientSecret: staticCfg.clientSecret,
    refreshToken: auth.refreshToken
  });
  auth.token = refreshed.access_token;
  auth.refreshToken = refreshed.refresh_token || auth.refreshToken;
  auth.tokenScopes = refreshed.scope || auth.tokenScopes;
  auth.tokenExpiresAt = Date.now() + (Number(refreshed.expires_in || 0) * 1000);
  persistAuth();
}

async function tick() {
  if (!staticCfg.clientId || !auth.token || !auth.broadcasterId || !auth.moderatorId || !auth.broadcasterLogin) return;

  const ts = Date.now();
  lastPollAt = ts;
  try {
    await ensureFreshToken();
    const next = await fetchChatters({
      clientId: staticCfg.clientId,
      userAccessToken: auth.token,
      broadcasterId: auth.broadcasterId,
      moderatorId: auth.moderatorId
    });

    const joined = [...next].filter(u => !current.has(u));
    const left = [...current].filter(u => !next.has(u));

    for (const u of joined) store.eventJoin(u, ts, auth.broadcasterLogin);
    for (const u of left) store.eventLeave(u, ts, auth.broadcasterLogin);

    if (joined.length || left.length) {
      console.log(`[tick] joins=${joined.length} leaves=${left.length}`);
      enricher.enqueue(joined);
    }

    current = next;
    lastError = null;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 && auth.refreshToken) {
      try {
        const refreshed = await refreshAccessToken({
          clientId: staticCfg.clientId,
          clientSecret: staticCfg.clientSecret,
          refreshToken: auth.refreshToken
        });
        auth.token = refreshed.access_token;
        auth.refreshToken = refreshed.refresh_token || auth.refreshToken;
        auth.tokenScopes = refreshed.scope || auth.tokenScopes;
        auth.tokenExpiresAt = Date.now() + (Number(refreshed.expires_in || 0) * 1000);
        persistAuth();
        return;
      } catch (e2) {
        lastError = e2?.response?.data || e2?.message || String(e2);
        console.error('[tick:refresh-error]', lastError);
        return;
      }
    }
    lastError = err?.response?.data || err?.message || String(err);
    console.error('[tick:error]', lastError);
  }
}

setInterval(tick, pollMs);
setInterval(() => enricher.tick().catch((e) => console.error('[enrich:error]', e?.message || e)), 4000);
setTimeout(tick, 1500);

app.get('/auth/start', (req, res) => {
  if (!staticCfg.clientId || !staticCfg.clientSecret) {
    return res.status(400).json({ error: 'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET first.' });
  }

  const broadcasterLogin = String(req.query.channel || '').trim().toLowerCase();
  if (!broadcasterLogin) return res.status(400).json({ error: 'Missing ?channel=<twitch_login>' });

  const state = crypto.randomBytes(18).toString('hex');
  oauthState.set(state, { broadcasterLogin, createdAt: Date.now() });

  const scope = encodeURIComponent('moderator:read:chatters moderator:read:followers');
  const url = `https://id.twitch.tv/oauth2/authorize?client_id=${encodeURIComponent(staticCfg.clientId)}&redirect_uri=${encodeURIComponent(staticCfg.redirectUri)}&response_type=code&scope=${scope}&state=${state}`;
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  try {
    const code = String(req.query.code || '');
    const state = String(req.query.state || '');
    const st = oauthState.get(state);
    oauthState.delete(state);

    if (!code || !st) return res.status(400).send('Invalid OAuth callback (missing/invalid state).');

    const tokenData = await exchangeCodeForToken({
      clientId: staticCfg.clientId,
      clientSecret: staticCfg.clientSecret,
      code,
      redirectUri: staticCfg.redirectUri
    });

    auth.token = tokenData.access_token;
    auth.refreshToken = tokenData.refresh_token || null;
    auth.tokenScopes = tokenData.scope || [];
    auth.tokenExpiresAt = Date.now() + (Number(tokenData.expires_in || 0) * 1000);

    const me = await fetchMe({ clientId: staticCfg.clientId, userAccessToken: auth.token });
    if (!me) throw new Error('Unable to fetch moderator identity from token.');
    auth.moderatorId = me.id;
    auth.meLogin = me.login;

    const broadcaster = await fetchUserByLogin({
      clientId: staticCfg.clientId,
      userAccessToken: auth.token,
      login: st.broadcasterLogin
    });

    if (!broadcaster) throw new Error(`Broadcaster login not found: ${st.broadcasterLogin}`);
    auth.broadcasterId = broadcaster.id;
    auth.broadcasterLogin = broadcaster.login;
    current = store.getOpenSet(auth.broadcasterLogin);
    persistAuth();

    res.send(`OAuth complete ✅<br/>Channel: ${auth.broadcasterLogin}<br/>Moderator token user: ${auth.meLogin}<br/><a href='/'>Open dashboard</a>`);
  } catch (e) {
    res.status(500).send(`OAuth failed: ${e?.message || e}`);
  }
});

app.get('/auth/status', (_req, res) => {
  res.json({
    configured: !!(staticCfg.clientId && staticCfg.clientSecret),
    authed: !!auth.token,
    moderatorId: auth.moderatorId,
    moderatorLogin: auth.meLogin,
    broadcasterId: auth.broadcasterId,
    broadcasterLogin: auth.broadcasterLogin,
    scopes: auth.tokenScopes,
    tokenExpiresAt: auth.tokenExpiresAt
  });
});

app.post('/auth/logout', (_req, res) => {
  auth.token = null;
  auth.refreshToken = null;
  auth.tokenExpiresAt = null;
  auth.moderatorId = null;
  auth.meLogin = null;
  auth.tokenScopes = [];
  auth.broadcasterId = null;
  auth.broadcasterLogin = null;
  current = new Set();
  authStore.clear();
  res.json({ ok: true });
});

app.get('/track/set', async (req, res) => {
  try {
    if (!auth.token) return res.status(401).json({ error: 'Not authed yet. Connect Twitch first.' });
    const login = String(req.query.channel || '').trim().toLowerCase();
    if (!login) return res.status(400).json({ error: 'Missing ?channel=<twitch_login>' });

    const broadcaster = await fetchUserByLogin({
      clientId: staticCfg.clientId,
      userAccessToken: auth.token,
      login
    });
    if (!broadcaster) return res.status(404).json({ error: `Channel not found: ${login}` });

    auth.broadcasterId = broadcaster.id;
    auth.broadcasterLogin = broadcaster.login;
    current = store.getOpenSet(auth.broadcasterLogin);
    persistAuth();
    res.json({ ok: true, broadcasterId: auth.broadcasterId, broadcasterLogin: auth.broadcasterLogin });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, pollMs, lastPollAt, hasError: !!lastError });
});

app.get('/state', (_req, res) => {
  res.json({
    onlineCount: current.size,
    users: [...current].sort(),
    lastPollAt,
    lastError,
    enrich: enricher.stats(),
    auth: {
      authed: !!auth.token,
      broadcasterLogin: auth.broadcasterLogin,
      moderatorLogin: auth.meLogin
    },
    channel: auth.broadcasterLogin || null
  });
});

app.get('/events', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  const offset = Math.max(0, Number(req.query.offset || 0));
  const channel = String(req.query.channel || auth.broadcasterLogin || '').toLowerCase();
  if (!channel) return res.json({ items: [], total: 0, limit, offset });
  res.json({
    items: store.getEvents(channel, limit, offset),
    total: store.countEvents(channel),
    limit,
    offset,
    channel
  });
});

app.get('/sessions', (req, res) => {
  const limit = Number(req.query.limit || 100);
  const username = req.query.username ? String(req.query.username).toLowerCase() : null;
  const channel = String(req.query.channel || auth.broadcasterLogin || '').toLowerCase();
  if (!channel) return res.json({ items: [] });
  let items = store.getSessions(channel, Math.min(limit, 1000));
  if (username) items = items.filter(x => (x.username || '').toLowerCase() === username);
  res.json({ items, channel });
});

app.get('/visitors/popular', (req, res) => {
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  const offset = Math.max(0, Number(req.query.offset || 0));
  const channel = String(req.query.channel || auth.broadcasterLogin || '').toLowerCase();
  if (!channel) return res.json({ items: [], total: 0, limit, offset, channel: null });
  res.json({
    items: store.getPopularVisitors(channel, limit, offset),
    total: store.countVisitors(channel),
    limit,
    offset,
    channel
  });
});

const publicDir = path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

app.listen(port, () => {
  console.log(`tracker listening on :${port}`);
});
