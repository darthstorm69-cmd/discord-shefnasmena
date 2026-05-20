require('dotenv').config();
const token = process.env.DISCORD_TOKEN;
console.log('Token present:', !!token, '| Length:', token?.length, '| Starts with:', token?.slice(0, 10));
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Events, InteractionType, EmbedBuilder,
} = require('discord.js');
const cron = require('node-cron');
const { logMessage, getMessageStats, getVoiceStats, getAllTimeVoiceStats, getWallet, getWalletLeaderboard } = require('./database');
const { handleVoiceStateUpdate, initActiveSessions, getActiveStats } = require('./voiceTracker');
const { sendWeeklyReport } = require('./tasks/weeklyReport');
const { seedWalletsFromHistory, BUCKS_PER_HOUR } = require('./economy');

const VERSION = '1.2.0';

const PATCH_NOTES = [
  { emoji: '💰', text: `**Bucks system:** Earn ${BUCKS_PER_HOUR} 🪙 per hour of voice time — balance is yours forever` },
  { emoji: '📋', text: '**Full leaderboard:** \`/leaderboard\` shows all-time voice time for every member' },
  { emoji: '💼', text: '**Wallet:** Use \`/wallet\` to check your bucks balance anytime' },
];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── Ready ─────────────────────────────────────────────────────────────────────

async function sendPatchNotes(guilds) {
  const versionFile = path.join(__dirname, '..', 'data', 'version.txt');
  const lastVersion = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : null;
  if (lastVersion === VERSION) return;

  const embed = new EmbedBuilder()
    .setTitle(`🔧 Bot Update — v${VERSION}`)
    .setColor(0x57F287)
    .setDescription(PATCH_NOTES.map(n => `${n.emoji} ${n.text}`).join('\n'))
    .setTimestamp()
    .setFooter({ text: 'Updates are live now' });

  for (const [, guild] of guilds) {
    const channel = guild.channels.cache.find(c => c.name === (process.env.REPORT_CHANNEL || 'activity-reports') && c.isTextBased())
      || guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me)?.has('SendMessages'));
    if (channel) await channel.send({ embeds: [embed] }).catch(console.error);
  }

  fs.writeFileSync(versionFile, VERSION);
  console.log(`[patch notes] Announced v${VERSION}`);
}

client.once(Events.ClientReady, async c => {
  console.log(`✅ Logged in as ${c.user.tag}`);
  initActiveSessions(c.guilds.cache);
  await sendPatchNotes(c.guilds.cache);

  for (const [, guild] of c.guilds.cache) {
    seedWalletsFromHistory(guild.id).catch(console.error);
  }

  const day  = process.env.REPORT_DAY  ?? '0';  // 0 = Sunday
  const hour = process.env.REPORT_HOUR ?? '9';

  // e.g. "0 9 * * 0" = 09:00 every Sunday (UTC)
  cron.schedule(`0 ${hour} * * ${day}`, () => {
    console.log('[cron] Sending weekly reports…');
    client.guilds.cache.forEach(guild => sendWeeklyReport(guild));
  });
});

// ── Message tracking ──────────────────────────────────────────────────────────

client.on(Events.MessageCreate, message => {
  if (message.author.bot || !message.guild) return;
  logMessage(
    message.author.id,
    message.author.username,
    message.channel.id,
    message.channel.name,
    message.guild.id,
  );
});

// ── Voice tracking ────────────────────────────────────────────────────────────

client.on(Events.VoiceStateUpdate, handleVoiceStateUpdate);

// ── Slash commands ────────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.type !== InteractionType.ApplicationCommand) return;

  if (interaction.commandName === 'report') {
    await interaction.deferReply();
    const days  = parseInt(interaction.options.getString('period') ?? '7', 10);
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    // Temporarily patch the report to cover the chosen period
    const { sendCustomReport } = require('./tasks/weeklyReport');
    await sendCustomReport(interaction.guild, interaction.channel, since, days);
    await interaction.editReply(`Report for the last ${days} days posted above!`);
  }

  if (interaction.commandName === 'mystats') {
    await interaction.deferReply({ ephemeral: true });
    const since = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const msgRows   = await getMessageStats(interaction.guild.id, since);
    const voiceRows = await getVoiceStats(interaction.guild.id, since);

    const myMsgs  = msgRows.filter(r => r.user_id === interaction.user.id);
    const myVoice = voiceRows.filter(r => r.user_id === interaction.user.id);

    const totalMsgs  = myMsgs.reduce((s, r) => s + r.count, 0);
    const totalMs    = myVoice.reduce((s, r) => s + r.total_ms, 0);

    function fmt(ms) {
      if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    const lines = [
      `**Your activity this week, ${interaction.user.username}:**`,
      `💬 Messages sent: **${totalMsgs.toLocaleString()}**`,
      `🎙️ Voice time: **${fmt(totalMs)}**`,
    ];

    if (myMsgs.length > 0) {
      const top = myMsgs.sort((a, b) => b.count - a.count)[0];
      lines.push(`📢 Most active in: **#${top.channel_name}** (${top.count} msgs)`);
    }

    await interaction.editReply({ content: lines.join('\n') });
  }

  if (interaction.commandName === 'wallet') {
    await interaction.deferReply({ ephemeral: true });

    function fmt(ms) {
      if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    const userId  = interaction.user.id;
    const guildId = interaction.guild.id;

    const balance      = await getWallet(userId, guildId);
    const allTimeRows  = await getAllTimeVoiceStats(guildId);
    const activeRows   = getActiveStats(guildId, 0);

    const historicalMs = (allTimeRows.find(r => r.user_id === userId)?.total_ms ?? 0);
    const activeMs     = (activeRows.find(r => r.user_id === userId)?.total_ms ?? 0);
    const totalMs      = historicalMs + activeMs;

    const embed = new EmbedBuilder()
      .setTitle(`💼 ${interaction.user.username}'s Wallet`)
      .setColor(0xF1C40F)
      .addFields(
        { name: '🪙 Balance', value: `**${balance.toLocaleString()} bucks**`, inline: true },
        { name: '🎙️ All-Time Voice', value: `**${fmt(totalMs)}**`, inline: true },
        { name: '📈 Earn Rate', value: `${BUCKS_PER_HOUR} 🪙 / hour`, inline: true },
      )
      .setFooter({ text: 'Time only counts when 2+ people are in the channel and you\'re unmuted' });

    await interaction.editReply({ embeds: [embed] });
  }

  if (interaction.commandName === 'leaderboard') {
    await interaction.deferReply();

    function fmt(ms) {
      if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
      const h = Math.floor(ms / 3_600_000);
      const m = Math.floor((ms % 3_600_000) / 60_000);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }

    const guildId     = interaction.guild.id;
    const historical  = await getAllTimeVoiceStats(guildId);
    const active      = getActiveStats(guildId, 0);
    const walletRows  = await getWalletLeaderboard(guildId);

    // Merge historical + active voice time per user
    const voiceMap = {};
    for (const r of [...historical, ...active]) {
      if (!voiceMap[r.user_id]) voiceMap[r.user_id] = { username: r.username, total_ms: 0 };
      voiceMap[r.user_id].total_ms += r.total_ms;
    }
    // Include wallet holders with 0 voice time (edge case)
    for (const w of walletRows) {
      if (!voiceMap[w.userId]) voiceMap[w.userId] = { username: w.username, total_ms: 0 };
    }

    const bucksMap = Object.fromEntries(walletRows.map(w => [w.userId, w.balance]));

    const sorted = Object.entries(voiceMap)
      .sort((a, b) => b[1].total_ms - a[1].total_ms);

    const MEDALS = ['🥇', '🥈', '🥉'];

    const embed = new EmbedBuilder()
      .setTitle('📋 All-Time Voice Leaderboard')
      .setColor(0x5865F2)
      .setDescription(`**${sorted.length}** member${sorted.length !== 1 ? 's' : ''} tracked`)
      .setFooter({ text: `${interaction.guild.name} • all time` });

    // Chunk into fields of 15 users each
    const CHUNK = 15;
    for (let i = 0; i < sorted.length; i += CHUNK) {
      const chunk = sorted.slice(i, i + CHUNK);
      const lines = chunk.map(([uid, u], j) => {
        const rank   = i + j + 1;
        const medal  = rank <= 3 ? MEDALS[rank - 1] : `\`#${rank}\``;
        const bucks  = (bucksMap[uid] ?? 0).toLocaleString();
        return `${medal} **${u.username}** — ${fmt(u.total_ms)} • ${bucks} 🪙`;
      });

      embed.addFields({
        name: i === 0 ? '🎙️ Rankings' : '​',
        value: lines.join('\n'),
      });

      // Discord embed total char limit ~6000 — bail early if we're getting large
      if (embed.length > 5500) {
        embed.addFields({ name: '​', value: `_…and ${sorted.length - (i + CHUNK)} more_` });
        break;
      }
    }

    await interaction.editReply({ embeds: [embed] });
  }
});

client.login(process.env.DISCORD_TOKEN);
