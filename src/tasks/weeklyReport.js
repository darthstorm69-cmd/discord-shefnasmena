const { EmbedBuilder } = require('discord.js');
const { getMessageStats, getVoiceStats } = require('../database');
const { getActiveStats } = require('../voiceTracker');

function formatDuration(ms) {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function aggregateByUser(rows, valueKey) {
  const map = {};
  for (const row of rows) {
    if (!map[row.user_id]) map[row.user_id] = { username: row.username, total: 0, channels: {} };
    map[row.user_id].total += row[valueKey];
    map[row.user_id].channels[row.channel_name] = (map[row.user_id].channels[row.channel_name] || 0) + row[valueKey];
  }
  return Object.entries(map).sort((a, b) => b[1].total - a[1].total);
}

function topChannels(rows, valueKey, limit = 3) {
  const map = {};
  for (const row of rows) {
    map[row.channel_name] = (map[row.channel_name] || 0) + row[valueKey];
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, limit);
}

const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];

async function assignTopVoiceRole(guild, topUserIds) {
  const roleName = process.env.TOP_VOICE_ROLE;
  if (!roleName) return;

  const role = guild.roles.cache.find(r => r.name === roleName);
  if (!role) {
    console.warn(`[role] Role "${roleName}" not found in ${guild.name}`);
    return;
  }

  // Remove from anyone no longer in top 3
  for (const [, member] of role.members) {
    if (!topUserIds.includes(member.id)) {
      await member.roles.remove(role).catch(console.error);
      console.log(`[role] Removed "${roleName}" from ${member.user.username}`);
    }
  }

  // Assign to top 3 who don't already have it
  for (const userId of topUserIds) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role).catch(console.error);
      console.log(`[role] Assigned "${roleName}" to ${member.user.username}`);
    }
  }
}

async function sendWeeklyReport(guild, specificChannel = null) {
  const channel = specificChannel
    || guild.channels.cache.find(c => c.name === (process.env.REPORT_CHANNEL || 'activity-reports') && c.isTextBased())
    || guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages'));

  if (!channel) return console.warn(`[report] No writable channel found in ${guild.name}`);

  const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const msgRows   = await getMessageStats(guild.id, since);
  const voiceRows = [...await getVoiceStats(guild.id, since), ...getActiveStats(guild.id, since)];

  const topMessagers = aggregateByUser(msgRows, 'count').slice(0, 5);
  const topVoicers   = aggregateByUser(voiceRows, 'total_ms').slice(0, 5);
  const topMsgChans  = topChannels(msgRows, 'count');

  const totalMessages  = topMessagers.reduce((s, [, u]) => s + u.total, 0);
  const totalVoiceMs   = topVoicers.reduce((s, [, u]) => s + u.total, 0);
  const uniqueActive   = new Set([...msgRows.map(r => r.user_id), ...voiceRows.map(r => r.user_id)]).size;

  const top3Ids = topVoicers.slice(0, 3).map(([id]) => id);
  if (top3Ids.length > 0) assignTopVoiceRole(guild, top3Ids).catch(console.error);

  const embed = new EmbedBuilder()
    .setTitle('📊 Weekly Activity Report')
    .setColor(0x5865F2)
    .setTimestamp()
    .setFooter({ text: `${guild.name} • past 7 days` });

  if (totalMessages === 0 && totalVoiceMs === 0) {
    embed.setDescription("It was a quiet week — no activity recorded. Come hang out! 👋");
    return channel.send({ embeds: [embed] });
  }

  embed.setDescription(
    `**${uniqueActive}** member${uniqueActive !== 1 ? 's' : ''} were active this week across **${guild.name}**.`
  );

  embed.addFields({
    name: '📈 At a Glance',
    value: [
      `💬 **${totalMessages.toLocaleString()}** messages sent`,
      `🎙️ **${formatDuration(totalVoiceMs)}** total voice time`,
      `👥 **${uniqueActive}** active members`,
    ].join('\n'),
    inline: false,
  });

  if (topMessagers.length > 0) {
    embed.addFields({
      name: '💬 Top Chatters',
      value: topMessagers.map(([, u], i) => `${MEDALS[i]} **${u.username}** — ${u.total.toLocaleString()} msgs`).join('\n'),
      inline: true,
    });
  }

  if (topVoicers.length > 0) {
    embed.addFields({
      name: '🎙️ Voice Champions',
      value: topVoicers.map(([, u], i) => `${MEDALS[i]} **${u.username}** — ${formatDuration(u.total)}`).join('\n'),
      inline: true,
    });
  }

  if (topMsgChans.length > 0) {
    embed.addFields({
      name: '📢 Hottest Channels',
      value: topMsgChans.map(([name, count], i) => `${MEDALS[i]} **#${name}** — ${count.toLocaleString()} msgs`).join('\n'),
      inline: false,
    });
  }

  // Spotlight: break down the top chatter's busiest channels
  if (topMessagers[0]) {
    const [, top] = topMessagers[0];
    const breakdown = Object.entries(top.channels)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ch, n]) => `#${ch}: ${n}`)
      .join(' · ');
    embed.addFields({
      name: `🌟 Spotlight: ${top.username}`,
      value: `Sent the most messages this week!\n${breakdown}`,
      inline: false,
    });
  }

  await channel.send({ embeds: [embed] });
}

async function sendCustomReport(guild, channel, since, days) {
  const msgRows   = await getMessageStats(guild.id, since);
  const voiceRows = [...await getVoiceStats(guild.id, since), ...getActiveStats(guild.id, since)];

  const topMessagers = aggregateByUser(msgRows, 'count').slice(0, 5);
  const topVoicers   = aggregateByUser(voiceRows, 'total_ms').slice(0, 5);
  const topMsgChans  = topChannels(msgRows, 'count');

  const totalMessages = topMessagers.reduce((s, [, u]) => s + u.total, 0);
  const totalVoiceMs  = topVoicers.reduce((s, [, u]) => s + u.total, 0);
  const uniqueActive  = new Set([...msgRows.map(r => r.user_id), ...voiceRows.map(r => r.user_id)]).size;

  const embed = new EmbedBuilder()
    .setTitle(`📊 Activity Report — Last ${days} Days`)
    .setColor(0x5865F2)
    .setTimestamp()
    .setFooter({ text: `${guild.name} • past ${days} days` });

  if (totalMessages === 0 && totalVoiceMs === 0) {
    embed.setDescription("No activity recorded for this period.");
    return channel.send({ embeds: [embed] });
  }

  embed.setDescription(`**${uniqueActive}** member${uniqueActive !== 1 ? 's' : ''} were active over the past ${days} days.`);
  embed.addFields({
    name: '📈 At a Glance',
    value: [
      `💬 **${totalMessages.toLocaleString()}** messages sent`,
      `🎙️ **${formatDuration(totalVoiceMs)}** total voice time`,
      `👥 **${uniqueActive}** active members`,
    ].join('\n'),
    inline: false,
  });

  if (topMessagers.length > 0) {
    embed.addFields({
      name: '💬 Top Chatters',
      value: topMessagers.map(([, u], i) => `${MEDALS[i]} **${u.username}** — ${u.total.toLocaleString()} msgs`).join('\n'),
      inline: true,
    });
  }

  if (topVoicers.length > 0) {
    embed.addFields({
      name: '🎙️ Voice Champions',
      value: topVoicers.map(([, u], i) => `${MEDALS[i]} **${u.username}** — ${formatDuration(u.total)}`).join('\n'),
      inline: true,
    });
  }

  if (topMsgChans.length > 0) {
    embed.addFields({
      name: '📢 Hottest Channels',
      value: topMsgChans.map(([name, count], i) => `${MEDALS[i]} **#${name}** — ${count.toLocaleString()} msgs`).join('\n'),
      inline: false,
    });
  }

  await channel.send({ embeds: [embed] });
}

module.exports = { sendWeeklyReport, sendCustomReport };
