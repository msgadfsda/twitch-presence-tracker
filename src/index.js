import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { createStore } from './store.js';
import { fetchChatters, exchangeCodeForToken, fetchMe, fetchUserByLogin, refreshAccessToken } from './twitch.js';
import { createEnricher } from './enrich.js';
import { createAuthStore } from './authStore.js';

const app = express();
app.set('trust proxy', 1);
const port = Number(process.env.PORT || 8787);
const pollMs = Number(process.env.POLL_MS || 15000);

const staticCfg = {
  clientId: process.env.TWITCH_CLIENT_ID,
  clientSecret: process.env.TWITCH_CLIENT_SECRET,
  redirectUri: process.env.TWITCH_REDIRECT_URI || `http://localhost:${port}/auth/callback`
};

const oauthState = new Map();
const authStore = createAuthStore();

if (!staticCfg.clientId) console.warn('[warn] missing env: TWITCH_CLIENT_ID');
if (!staticCfg.clientSecret) console.warn('[warn] missing env: TWITCH_CLIENT_SECRET');

const store = createStore(process.env.DB_PATH || './tracker.db');

function newSessionAuth() {
  return {
    token: null,
    refreshToken: null,
    tokenExpiresAt: null,
    moderatorId: null,
    meLogin: null,
    tokenScopes: [],
    broadcasterId: null,
    broadcasterLogin: null,
    current: new Set(),
    lastPollAt: null,
    lastError: null
  };
}

const sessions = new Map(); // sid -> auth object

(function bootAuthFromDisk() {
  const saved = authStore.load() || {};
  for (const [sid, a] of Object.entries(saved)) {
    const v = newSessionAuth();
    v.token = a.token || null;
    v.refreshToken = a.refreshToken || null;
    v.tokenExpiresAt = a.tokenExpiresAt || null;
    v.moderatorId = a.moderatorId || null;
    v.meLogin = a.meLogin || null;
    v.tokenScopes = a.tokenScopes || [];
    v.broadcasterId = a.broadcasterId || null;
    v.broadcasterLogin = a.broadcasterLogin || null;
    v.current = store.getOpenSet(v.broadcasterLogin || '__none__');
    sessions.set(sid, v);
  }
})();

function persistAuth() {
  const out = {};
  for (const [sid, a] of sessions.entries()) {
    out[sid] = {
      token: a.token,
      refreshToken: a.refreshToken,
      tokenExpiresAt: a.tokenExpiresAt,
      moderatorId: a.moderatorId,
      meLogin: a.meLogin,
      tokenScopes: a.tokenScopes,
      broadcasterId: a.broadcasterId,
      broadcasterLogin: a.broadcasterLogin
    };
  }
  authStore.save(out);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = decodeURIComponent(part.slice(i + 1).trim());
    out[k] = v;
  }
  return out;
}

function getSid(req, res) {
  const cookies = parseCookies(req);
  let sid = cookies.tp_sid;
  if (!sid) sid = crypto.randomBytes(24).toString('hex');

  const secure = req.secure || (req.headers['x-forwarded-proto'] || '').toString().includes('https');
  // Persist browser session identity for 30 days so auth survives tab/browser restarts.
  res.setHeader('Set-Cookie', `tp_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}${secure ? '; Secure' : ''}`);
  return sid;
}

function getSessionAuth(req, res) {
  const sid = getSid(req, res);
  if (!sessions.has(sid)) sessions.set(sid, newSessionAuth());
  return { sid, auth: sessions.get(sid) };
}

async function ensureFreshToken(a) {
  if (!a.refreshToken || !a.tokenExpiresAt) return;
  if (Date.now() < a.tokenExpiresAt - 60_000) return;

  const refreshed = await refreshAccessToken({
    clientId: staticCfg.clientId,
    clientSecret: staticCfg.clientSecret,
    refreshToken: a.refreshToken
  });
  a.token = refreshed.access_token;
  a.refreshToken = refreshed.refresh_token || a.refreshToken;
  a.tokenScopes = refreshed.scope || a.tokenScopes;
  a.tokenExpiresAt = Date.now() + (Number(refreshed.expires_in || 0) * 1000);
  persistAuth();
}

const cfgForEnrich = {
  get clientId() { return staticCfg.clientId; },
  // uses whichever token most recently queued; enrich failures are non-fatal
  userAccessToken: null
};
const enricher = createEnricher({ cfg: cfgForEnrich, store });

async function tickOne(a) {
  if (!staticCfg.clientId || !a.token || !a.broadcasterId || !a.moderatorId || !a.broadcasterLogin) return;

  const ts = Date.now();
  a.lastPollAt = ts;
  try {
    await ensureFreshToken(a);
    const next = await fetchChatters({
      clientId: staticCfg.clientId,
      userAccessToken: a.token,
      broadcasterId: a.broadcasterId,
      moderatorId: a.moderatorId
    });

    const joined = [...next].filter(u => !a.current.has(u));
    const left = [...a.current].filter(u => !next.has(u));

    for (const u of joined) store.eventJoin(u, ts, a.broadcasterLogin);
    for (const u of left) store.eventLeave(u, ts, a.broadcasterLogin);

    if (joined.length || left.length) {
      cfgForEnrich.userAccessToken = a.token;
      enricher.enqueue(joined);
    }

    a.current = next;
    a.lastError = null;
  } catch (err) {
    const status = err?.response?.status;
    if (status === 401 && a.refreshToken) {
      try {
        const refreshed = await refreshAccessToken({
          clientId: staticCfg.clientId,
          clientSecret: staticCfg.clientSecret,
          refreshToken: a.refreshToken
        });
        a.token = refreshed.access_token;
        a.refreshToken = refreshed.refresh_token || a.refreshToken;
        a.tokenScopes = refreshed.scope || a.tokenScopes;
        a.tokenExpiresAt = Date.now() + (Number(refreshed.expires_in || 0) * 1000);
        persistAuth();
        return;
      } catch (e2) {
        a.lastError = e2?.response?.data || e2?.message || String(e2);
        return;
      }
    }
    a.lastError = err?.response?.data || err?.message || String(err);
  }
}

async function tickAll() {
  for (const a of sessions.values()) {
    // eslint-disable-next-line no-await-in-loop
    await tickOne(a);
  }
}

setInterval(() => tickAll().catch(() => {}), pollMs);
setInterval(() => enricher.tick().catch((e) => console.error('[enrich:error]', e?.message || e)), 4000);
setTimeout(() => tickAll().catch(() => {}), 1500);

app.get('/auth/start', (req, res) => {
  const { sid } = getSessionAuth(req, res);
  if (!staticCfg.clientId || !staticCfg.clientSecret) {
    return res.status(400).json({ error: 'Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET first.' });
  }

  const broadcasterLogin = String(req.query.channel || '').trim().toLowerCase();
  if (!broadcasterLogin) return res.status(400).json({ error: 'Missing ?channel=<twitch_login>' });

  const state = crypto.randomBytes(18).toString('hex');
  oauthState.set(state, { sid, broadcasterLogin, createdAt: Date.now() });

  const scope = encodeURIComponent('moderator:read:chatters moderator:read:followers offline_access');
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
    if (!sessions.has(st.sid)) sessions.set(st.sid, newSessionAuth());
    const a = sessions.get(st.sid);

    const tokenData = await exchangeCodeForToken({
      clientId: staticCfg.clientId,
      clientSecret: staticCfg.clientSecret,
      code,
      redirectUri: staticCfg.redirectUri
    });

    a.token = tokenData.access_token;
    a.refreshToken = tokenData.refresh_token || null;
    a.tokenScopes = tokenData.scope || [];
    a.tokenExpiresAt = Date.now() + (Number(tokenData.expires_in || 0) * 1000);

    const me = await fetchMe({ clientId: staticCfg.clientId, userAccessToken: a.token });
    if (!me) throw new Error('Unable to fetch moderator identity from token.');
    a.moderatorId = me.id;
    a.meLogin = me.login;

    const broadcaster = await fetchUserByLogin({
      clientId: staticCfg.clientId,
      userAccessToken: a.token,
      login: st.broadcasterLogin
    });

    if (!broadcaster) throw new Error(`Broadcaster login not found: ${st.broadcasterLogin}`);
    a.broadcasterId = broadcaster.id;
    a.broadcasterLogin = broadcaster.login;
    a.current = store.getOpenSet(a.broadcasterLogin);
    persistAuth();

    res.send(`OAuth complete ✅<br/>Channel: ${a.broadcasterLogin}<br/>Moderator token user: ${a.meLogin}<br/><a href='/'>Open dashboard</a>`);
  } catch (e) {
    res.status(500).send(`OAuth failed: ${e?.message || e}`);
  }
});

app.get('/auth/status', (req, res) => {
  const { auth: a } = getSessionAuth(req, res);
  res.json({
    configured: !!(staticCfg.clientId && staticCfg.clientSecret),
    authed: !!a.token,
    moderatorId: a.moderatorId,
    moderatorLogin: a.meLogin,
    broadcasterId: a.broadcasterId,
    broadcasterLogin: a.broadcasterLogin,
    scopes: a.tokenScopes,
    tokenExpiresAt: a.tokenExpiresAt
  });
});

app.post('/auth/logout', (req, res) => {
  const { sid } = getSessionAuth(req, res);
  sessions.set(sid, newSessionAuth());
  persistAuth();
  res.json({ ok: true });
});

app.get('/track/set', async (req, res) => {
  try {
    const { auth: a } = getSessionAuth(req, res);
    if (!a.token) return res.status(401).json({ error: 'Not authed yet. Connect Twitch first.' });
    const login = String(req.query.channel || '').trim().toLowerCase();
    if (!login) return res.status(400).json({ error: 'Missing ?channel=<twitch_login>' });

    const broadcaster = await fetchUserByLogin({
      clientId: staticCfg.clientId,
      userAccessToken: a.token,
      login
    });
    if (!broadcaster) return res.status(404).json({ error: `Channel not found: ${login}` });

    a.broadcasterId = broadcaster.id;
    a.broadcasterLogin = broadcaster.login;
    a.current = store.getOpenSet(a.broadcasterLogin);
    persistAuth();
    res.json({ ok: true, broadcasterId: a.broadcasterId, broadcasterLogin: a.broadcasterLogin });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get('/health', (req, res) => {
  const { auth: a } = getSessionAuth(req, res);
  res.json({ ok: true, pollMs, lastPollAt: a.lastPollAt, hasError: !!a.lastError });
});

app.get('/state', (req, res) => {
  const { auth: a } = getSessionAuth(req, res);
  res.json({
    onlineCount: a.current.size,
    users: [...a.current].sort(),
    lastPollAt: a.lastPollAt,
    lastError: a.lastError,
    enrich: enricher.stats(),
    auth: {
      authed: !!a.token,
      broadcasterLogin: a.broadcasterLogin,
      moderatorLogin: a.meLogin
    },
    channel: a.broadcasterLogin || null
  });
});

app.get('/events', (req, res) => {
  const { auth: a } = getSessionAuth(req, res);
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  const offset = Math.max(0, Number(req.query.offset || 0));
  const channel = String(req.query.channel || a.broadcasterLogin || '').toLowerCase();
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
  const { auth: a } = getSessionAuth(req, res);
  const limit = Number(req.query.limit || 100);
  const username = req.query.username ? String(req.query.username).toLowerCase() : null;
  const channel = String(req.query.channel || a.broadcasterLogin || '').toLowerCase();
  if (!channel) return res.json({ items: [] });
  let items = store.getSessions(channel, Math.min(limit, 1000));
  if (username) items = items.filter(x => (x.username || '').toLowerCase() === username);
  res.json({ items, channel });
});

app.get('/visitors/popular', (req, res) => {
  const { auth: a } = getSessionAuth(req, res);
  const limit = Math.min(Number(req.query.limit || 100), 1000);
  const offset = Math.max(0, Number(req.query.offset || 0));
  const channel = String(req.query.channel || a.broadcasterLogin || '').toLowerCase();
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
