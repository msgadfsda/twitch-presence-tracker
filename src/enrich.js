import { fetchFollowerCount, fetchUsersByLogins } from './twitch.js';

export function createEnricher({ cfg, store }) {
  const queue = new Set();
  let running = false;

  function enqueue(usernames = []) {
    for (const u of usernames) if (u) queue.add(String(u).toLowerCase());
  }

  async function drain() {
    if (running || queue.size === 0) return;
    running = true;
    try {
      const batch = [...queue].slice(0, 50);
      for (const u of batch) queue.delete(u);

      const users = await fetchUsersByLogins({
        clientId: cfg.clientId,
        userAccessToken: cfg.userAccessToken,
        logins: batch
      });

      for (const u of users) {
        let followerCount = null;
        try {
          followerCount = await fetchFollowerCount({
            clientId: cfg.clientId,
            userAccessToken: cfg.userAccessToken,
            broadcasterId: u.id
          });
        } catch {
          followerCount = null;
        }

        store.saveUserProfile({
          username: (u.login || '').toLowerCase(),
          user_id: u.id || null,
          display_name: u.display_name || null,
          broadcaster_type: u.broadcaster_type || null,
          follower_count: followerCount,
          profile_image_url: u.profile_image_url || null,
          updated_at: Date.now()
        });
      }
    } finally {
      running = false;
    }
  }

  return {
    enqueue,
    async tick() {
      await drain();
    },
    stats() {
      return { queued: queue.size, running };
    }
  };
}
