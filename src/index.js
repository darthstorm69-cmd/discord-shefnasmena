require('dotenv').config();
const token = process.env.DISCORD_TOKEN;
console.log('Token present:', !!token, '| Length:', token?.length, '| Starts with:', token?.slice(0, 10));
const fs = require('fs');
const path = require('path');
const {
  Client, GatewayIntentBits, Events, InteractionType, EmbedBuilder,
} = require('discord.js');
const cron = require('node-cron');
const { logMessage, getMessageStats, getVoiceStats } = require('./database');
const { handleVoiceStateUpdate, initActiveSessions } = require('./voiceTracker');
const { sendWeeklyReport } = require('./tasks/weeklyReport');

const VERSION = '1.1.0';

const PATCH_NOTES = [
  { emoji: '🛡️', text: '**Anti-farming:** Voice time only counts when 2+ people are in the channel' },
  { emoji: '🔇', text: '**AFK detection:** Time pauses automatically when you\'re muted or deafened' },
  { emoji: '👑', text: '**Sitters role:** Top 3 weekly voice chatters earn the Sitters role — drop out of top 3 and it\'s gone' },
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
});

client.login(process.env.DISCORD_TOKEN);
