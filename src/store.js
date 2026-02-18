import Database from 'better-sqlite3';

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === column);
}

export function createStore(path = './tracker.db') {
  const db = new Database(path);

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK(event_type IN ('join','leave')),
      ts INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      left_at INTEGER,
      duration_sec INTEGER
    );

    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      user_id TEXT,
      display_name TEXT,
      broadcaster_type TEXT,
      follower_count INTEGER,
      profile_image_url TEXT,
      updated_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(username);
  `);

  // Migration: map entries to a specific channel
  if (!hasColumn(db, 'events', 'channel_login')) {
    db.exec(`ALTER TABLE events ADD COLUMN channel_login TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_events_channel_ts ON events(channel_login, ts DESC)`);
  }
  if (!hasColumn(db, 'sessions', 'channel_login')) {
    db.exec(`ALTER TABLE sessions ADD COLUMN channel_login TEXT`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_channel_user ON sessions(channel_login, username)`);
  }

  const insertEvent = db.prepare(`
    INSERT INTO events (username, event_type, ts, channel_login) VALUES (?, ?, ?, ?)
  `);

  const insertSession = db.prepare(`
    INSERT INTO sessions (username, joined_at, channel_login) VALUES (?, ?, ?)
  `);

  const closeSession = db.prepare(`
    UPDATE sessions
    SET left_at = ?, duration_sec = ?
    WHERE username = ? AND left_at IS NULL AND channel_login = ?
    ORDER BY joined_at DESC
    LIMIT 1
  `);

  const getOpenUsers = db.prepare(`
    SELECT username FROM sessions WHERE left_at IS NULL AND channel_login = ?
  `);

  const getEvents = db.prepare(`
    SELECT * FROM events
    WHERE channel_login = ?
    ORDER BY ts DESC
    LIMIT ? OFFSET ?
  `);

  const countEvents = db.prepare(`SELECT COUNT(*) as c FROM events WHERE channel_login = ?`);

  const getSessions = db.prepare(`
    SELECT * FROM sessions
    WHERE channel_login = ?
    ORDER BY joined_at DESC
    LIMIT ?
  `);

  const upsertUser = db.prepare(`
    INSERT INTO users (username, user_id, display_name, broadcaster_type, follower_count, profile_image_url, updated_at)
    VALUES (@username, @user_id, @display_name, @broadcaster_type, @follower_count, @profile_image_url, @updated_at)
    ON CONFLICT(username) DO UPDATE SET
      user_id=excluded.user_id,
      display_name=excluded.display_name,
      broadcaster_type=excluded.broadcaster_type,
      follower_count=excluded.follower_count,
      profile_image_url=excluded.profile_image_url,
      updated_at=excluded.updated_at
  `);

  const getUsersByFollowers = db.prepare(`
    SELECT u.*, 
      COALESCE((
        SELECT SUM(
          CASE
            WHEN s.duration_sec IS NOT NULL THEN s.duration_sec
            WHEN s.left_at IS NULL THEN MAX(0, CAST((? - s.joined_at) / 1000 AS INTEGER))
            ELSE 0
          END
        )
        FROM sessions s
        WHERE s.username = u.username AND s.channel_login = ?
      ),0) AS total_watch_sec,
      COALESCE((SELECT COUNT(*) FROM sessions s WHERE s.username = u.username AND s.channel_login = ?),0) AS visit_count,
      (SELECT MAX(joined_at) FROM sessions s WHERE s.username = u.username AND s.channel_login = ?) AS last_seen
    FROM users u
    WHERE EXISTS (SELECT 1 FROM sessions s2 WHERE s2.username = u.username AND s2.channel_login = ?)
    ORDER BY COALESCE(u.follower_count, 0) DESC, total_watch_sec DESC
    LIMIT ? OFFSET ?
  `);

  const countVisitors = db.prepare(`
    SELECT COUNT(DISTINCT username) as c FROM sessions WHERE channel_login = ?
  `);

  return {
    db,
    eventJoin(username, ts, channelLogin) {
      insertEvent.run(username, 'join', ts, channelLogin);
      insertSession.run(username, ts, channelLogin);
    },
    eventLeave(username, ts, channelLogin) {
      insertEvent.run(username, 'leave', ts, channelLogin);
      const row = db.prepare('SELECT joined_at FROM sessions WHERE username = ? AND left_at IS NULL AND channel_login = ? ORDER BY joined_at DESC LIMIT 1').get(username, channelLogin);
      if (row) {
        const dur = Math.max(0, Math.floor((ts - row.joined_at) / 1000));
        closeSession.run(ts, dur, username, channelLogin);
      }
    },
    getOpenSet(channelLogin) {
      const rows = getOpenUsers.all(channelLogin);
      return new Set(rows.map(r => r.username.toLowerCase()));
    },
    getEvents(channelLogin, limit = 100, offset = 0) {
      return getEvents.all(channelLogin, limit, offset);
    },
    countEvents(channelLogin) {
      return countEvents.get(channelLogin).c;
    },
    getSessions(channelLogin, limit = 100) {
      return getSessions.all(channelLogin, limit);
    },
    saveUserProfile(profile) {
      upsertUser.run(profile);
    },
    getPopularVisitors(channelLogin, limit = 100, offset = 0) {
      const nowMs = Date.now();
      return getUsersByFollowers.all(nowMs, channelLogin, channelLogin, channelLogin, channelLogin, limit, offset);
    },
    countVisitors(channelLogin) {
      return countVisitors.get(channelLogin).c;
    }
  };
}
