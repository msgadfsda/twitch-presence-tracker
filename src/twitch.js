import axios from 'axios';

const twitch = axios.create({
  baseURL: 'https://api.twitch.tv/helix',
  timeout: 15000
});

function authHeaders({ clientId, userAccessToken }) {
  return {
    'Client-Id': clientId,
    'Authorization': `Bearer ${userAccessToken}`
  };
}

export async function exchangeCodeForToken({ clientId, clientSecret, code, redirectUri }) {
  const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    },
    timeout: 15000
  });

  return res.data; // { access_token, refresh_token, expires_in, scope, token_type }
}

export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret
    },
    timeout: 15000
  });
  return res.data;
}

export async function fetchMe({ clientId, userAccessToken }) {
  const headers = authHeaders({ clientId, userAccessToken });
  const res = await twitch.get('/users', { headers });
  return res.data?.data?.[0] || null;
}

export async function fetchUserByLogin({ clientId, userAccessToken, login }) {
  const headers = authHeaders({ clientId, userAccessToken });
  const res = await twitch.get('/users', { headers, params: { login } });
  return res.data?.data?.[0] || null;
}

export async function fetchChatters({ clientId, userAccessToken, broadcasterId, moderatorId }) {
  const headers = authHeaders({ clientId, userAccessToken });

  const params = {
    broadcaster_id: broadcasterId,
    moderator_id: moderatorId,
    first: 1000
  };

  const users = new Set();
  let after;

  for (let i = 0; i < 20; i++) {
    const res = await twitch.get('/chat/chatters', {
      headers,
      params: after ? { ...params, after } : params
    });

    const data = res.data?.data || [];
    for (const row of data) {
      const login = (row.user_login || '').toLowerCase().trim();
      if (login) users.add(login);
    }

    after = res.data?.pagination?.cursor;
    if (!after) break;
  }

  return users;
}

export async function fetchUsersByLogins({ clientId, userAccessToken, logins = [] }) {
  if (!logins.length) return [];
  const headers = authHeaders({ clientId, userAccessToken });

  const chunks = [];
  for (let i = 0; i < logins.length; i += 100) chunks.push(logins.slice(i, i + 100));

  const out = [];
  for (const chunk of chunks) {
    const params = new URLSearchParams();
    for (const login of chunk) params.append('login', login);
    const res = await twitch.get(`/users?${params.toString()}`, { headers });
    out.push(...(res.data?.data || []));
  }
  return out;
}

export async function fetchFollowerCount({ clientId, userAccessToken, broadcasterId }) {
  const headers = authHeaders({ clientId, userAccessToken });
  const res = await twitch.get('/channels/followers', { headers, params: { broadcaster_id: broadcasterId, first: 1 } });
  return res.data?.total ?? null;
}
