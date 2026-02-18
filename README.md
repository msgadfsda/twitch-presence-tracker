# Twitch Audience Presence Tracker (Phase 1)

Tracks **inferred audience presence** (chatters/presence signals), not guaranteed full viewer list.

## What this phase does

- Polls Twitch chatter presence on an interval
- Detects inferred `join` / `leave`
- Stores user sessions (`joined_at`, `left_at`, `duration_sec`)
- Supports future enrichment (partner/affiliate/followers)

## Why "inferred"?

Twitch does not provide a guaranteed real-time complete stream viewer join/leave API for all viewers. This project tracks the closest reliable signal set for identifiable users.

## Setup

1. Create a Twitch app and set env vars:

```bash
export TWITCH_CLIENT_ID=...
export TWITCH_CLIENT_SECRET=...
export TWITCH_REDIRECT_URI=http://localhost:8787/auth/callback
```

2. Install deps and run:

```bash
npm install
npm run dev
```

3. Open `http://localhost:8787/`, enter target channel login, then click **Connect Twitch + Start Tracking**.

Notes:
- OAuth scopes used: `moderator:read:chatters moderator:read:followers`
- The Twitch account you authorize must be moderator (or broadcaster) for the target channel.
- IDs/token are now resolved from OAuth and kept in runtime memory for MVP.

## API

- `GET /health`
- `GET /state`
- `GET /events?limit=100`
- `GET /sessions?limit=100`
- `GET /visitors/popular?limit=100`

## UI

- Open `http://localhost:8787/` for the MVP dashboard.
- Shows recent join/leave events + popular visitors (followers, broadcaster type, total stay time).

## Next phases

- Enrichment worker: partner/affiliate + follower counts
- Sort/rank UI by popularity and stay length
- Multi-channel support
- Confidence scoring and de-bounce rules
