const Datastore = require('@seald-io/nedb');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const messages = new Datastore({ filename: path.join(dataDir, 'messages.db'), autoload: true });
const voice    = new Datastore({ filename: path.join(dataDir, 'voice.db'),    autoload: true });

messages.ensureIndex({ fieldName: 'guildId' });
messages.ensureIndex({ fieldName: 'timestamp' });
voice.ensureIndex({ fieldName: 'guildId' });
voice.ensureIndex({ fieldName: 'joinTime' });

// ── Messages ──────────────────────────────────────────────────────────────────

function logMessage(userId, username, channelId, channelName, guildId) {
  messages.insertAsync({ userId, username, channelId, channelName, guildId, timestamp: Date.now() });
}

async function getMessageStats(guildId, since) {
  const rows = await messages.findAsync({ guildId, timestamp: { $gte: since } });

  // Group by userId + channelName
  const map = {};
  for (const r of rows) {
    const key = `${r.userId}::${r.channelName}`;
    if (!map[key]) map[key] = { user_id: r.userId, username: r.username, channel_name: r.channelName, count: 0 };
    map[key].count++;
  }
  return Object.values(map).sort((a, b) => b.count - a.count);
}

// ── Voice sessions ────────────────────────────────────────────────────────────

async function logVoiceJoin(userId, username, channelId, channelName, guildId) {
  // Close any open session first
  await voice.updateAsync(
    { userId, guildId, leaveTime: { $exists: false } },
    { $set: { leaveTime: Date.now() } },
    { multi: true },
  );
  await voice.insertAsync({ userId, username, channelId, channelName, guildId, joinTime: Date.now() });
}

function logVoiceLeave(userId, guildId) {
  voice.updateAsync(
    { userId, guildId, leaveTime: { $exists: false } },
    { $set: { leaveTime: Date.now() } },
    { multi: true },
  );
}

async function getVoiceStats(guildId, since) {
  const now  = Date.now();
  const rows = await voice.findAsync({ guildId, joinTime: { $gte: since } });

  const map = {};
  for (const r of rows) {
    const duration = (r.leaveTime ?? now) - r.joinTime;
    const key = `${r.userId}::${r.channelName}`;
    if (!map[key]) map[key] = { user_id: r.userId, username: r.username, channel_name: r.channelName, total_ms: 0 };
    map[key].total_ms += duration;
  }
  return Object.values(map).sort((a, b) => b.total_ms - a.total_ms);
}

module.exports = { logMessage, getMessageStats, logVoiceJoin, logVoiceLeave, getVoiceStats };
