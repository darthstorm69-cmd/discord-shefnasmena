const Datastore = require('@seald-io/nedb');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const messages = new Datastore({ filename: path.join(dataDir, 'messages.db'), autoload: true });
const voice    = new Datastore({ filename: path.join(dataDir, 'voice.db'),    autoload: true });
const wallets  = new Datastore({ filename: path.join(dataDir, 'wallets.db'),  autoload: true });
const meta     = new Datastore({ filename: path.join(dataDir, 'meta.db'),     autoload: true });

messages.ensureIndex({ fieldName: 'guildId' });
messages.ensureIndex({ fieldName: 'timestamp' });
voice.ensureIndex({ fieldName: 'guildId' });
voice.ensureIndex({ fieldName: 'joinTime' });
wallets.ensureIndex({ fieldName: 'guildId' });
wallets.ensureIndex({ fieldName: 'userId' });

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

function saveVoiceSession({ userId, username, channelId, channelName, guildId, joinTime, effectiveMs }) {
  voice.insertAsync({ userId, username, channelId, channelName, guildId, joinTime, effectiveMs });
}

async function getVoiceStats(guildId, since) {
  const now  = Date.now();
  const rows = await voice.findAsync({ guildId, joinTime: { $gte: since } });

  const map = {};
  for (const r of rows) {
    // Support old records (joinTime/leaveTime) and new records (effectiveMs)
    const duration = r.effectiveMs !== undefined
      ? r.effectiveMs
      : (r.leaveTime ?? now) - r.joinTime;
    const key = `${r.userId}::${r.channelName}`;
    if (!map[key]) map[key] = { user_id: r.userId, username: r.username, channel_name: r.channelName, total_ms: 0 };
    map[key].total_ms += duration;
  }
  return Object.values(map).sort((a, b) => b.total_ms - a.total_ms);
}

// ── All-time voice stats (no time filter) ────────────────────────────────────

async function getAllTimeVoiceStats(guildId) {
  const rows = await voice.findAsync({ guildId });
  const map  = {};
  for (const r of rows) {
    const duration = r.effectiveMs !== undefined
      ? r.effectiveMs
      : (r.leaveTime ?? Date.now()) - r.joinTime;
    if (!map[r.userId]) map[r.userId] = { user_id: r.userId, username: r.username, total_ms: 0 };
    map[r.userId].total_ms += duration;
  }
  return Object.values(map).sort((a, b) => b.total_ms - a.total_ms);
}

// ── Wallets ───────────────────────────────────────────────────────────────────

async function getWallet(userId, guildId) {
  const doc = await wallets.findOneAsync({ userId, guildId });
  return doc?.balance ?? 0;
}

async function addBucks(userId, username, guildId, amount) {
  const existing = await wallets.findOneAsync({ userId, guildId });
  if (existing) {
    await wallets.updateAsync(
      { userId, guildId },
      { $inc: { balance: amount }, $set: { username, updatedAt: Date.now() } },
    );
  } else {
    await wallets.insertAsync({ userId, username, guildId, balance: amount, updatedAt: Date.now() });
  }
}

async function getWalletLeaderboard(guildId) {
  const rows = await wallets.findAsync({ guildId });
  return rows.sort((a, b) => b.balance - a.balance);
}

// ── Migration flags ───────────────────────────────────────────────────────────

async function isSeeded(guildId) {
  const doc = await meta.findOneAsync({ type: 'wallet_seed', guildId });
  return !!doc;
}

async function markSeeded(guildId) {
  await meta.insertAsync({ type: 'wallet_seed', guildId, at: Date.now() });
}

module.exports = {
  logMessage, getMessageStats,
  saveVoiceSession, getVoiceStats, getAllTimeVoiceStats,
  getWallet, addBucks, getWalletLeaderboard,
  isSeeded, markSeeded,
};
