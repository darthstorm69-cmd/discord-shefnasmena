const { getAllTimeVoiceStats, addBucks, isSeeded, markSeeded } = require('./database');

const BUCKS_PER_HOUR = parseFloat(process.env.BUCKS_PER_HOUR ?? '100');

function msToBucks(ms) {
  return Math.floor(ms / 3_600_000 * BUCKS_PER_HOUR);
}

async function awardSessionBucks(userId, username, guildId, effectiveMs) {
  const earned = msToBucks(effectiveMs);
  if (earned <= 0) return;
  await addBucks(userId, username, guildId, earned);
}

async function seedWalletsFromHistory(guildId) {
  if (await isSeeded(guildId)) return;

  const rows = await getAllTimeVoiceStats(guildId);
  for (const row of rows) {
    const bucks = msToBucks(row.total_ms);
    if (bucks > 0) await addBucks(row.user_id, row.username, guildId, bucks);
  }

  await markSeeded(guildId);
  console.log(`[economy] Seeded wallets for guild ${guildId} from ${rows.length} users' history`);
}

module.exports = { BUCKS_PER_HOUR, msToBucks, awardSessionBucks, seedWalletsFromHistory };
