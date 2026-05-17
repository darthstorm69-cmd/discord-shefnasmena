const { saveVoiceSession } = require('./database');

// key: `${userId}:${guildId}`
// Session fields:
//   hasCompany    – ≥2 non-bot users in the same channel
//   isMuted       – self/server muted OR deafened (deafen implies mute in Discord)
//   lastValidJoin – timestamp counting started; null = paused
// Time counts only when hasCompany && !isMuted.
const activeSessions = new Map();

// ── Public API ────────────────────────────────────────────────────────────────

function handleVoiceStateUpdate(oldState, newState) {
  const userId   = newState.member?.id ?? oldState.member?.id;
  const username = newState.member?.user?.username ?? oldState.member?.user?.username ?? 'Unknown';
  const guildId  = newState.guild.id;
  const now      = Date.now();
  const key      = `${userId}:${guildId}`;

  const joined = !oldState.channelId && newState.channelId;
  const left   =  oldState.channelId && !newState.channelId;
  const moved  =  oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId;

  if (joined || moved) {
    if (moved) {
      _closeSession(key, now);
      _refreshCompany(oldState.channel, guildId, now);
    }

    const nonBotMembers = [...newState.channel.members.values()].filter(m => !m.user.bot);
    const hasCompany    = nonBotMembers.length >= 2;
    const isMuted       = _isMuted(newState);

    const s = {
      userId, username,
      channelId:    newState.channelId,
      channelName:  newState.channel.name,
      guildId,
      joinTime:     now,
      effectiveMs:  0,
      lastValidJoin: null,
      hasCompany,
      isMuted,
    };
    activeSessions.set(key, s);
    _syncCounting(s, now);

    // Refresh company status of others already in the new channel
    _refreshCompany(newState.channel, guildId, now, userId);

  } else if (left) {
    _closeSession(key, now);
    _refreshCompany(oldState.channel, guildId, now);

  } else if (oldState.channelId && newState.channelId) {
    // Same channel — check for mute/deafen change
    const s = activeSessions.get(key);
    if (!s) return;
    const newMuted = _isMuted(newState);
    if (s.isMuted !== newMuted) {
      s.isMuted = newMuted;
      _syncCounting(s, now);
    }
  }
}

function initActiveSessions(guilds) {
  const now = Date.now();
  for (const [, guild] of guilds) {
    for (const [, channel] of guild.channels.cache) {
      if (!channel.isVoiceBased?.()) continue;
      const nonBotMembers = [...channel.members.values()].filter(m => !m.user.bot);
      const hasCompany = nonBotMembers.length >= 2;
      for (const member of nonBotMembers) {
        const k = `${member.id}:${guild.id}`;
        if (activeSessions.has(k)) continue;
        const isMuted = _isMuted(member.voice);
        const s = {
          userId:      member.id,
          username:    member.user.username,
          channelId:   channel.id,
          channelName: channel.name,
          guildId:     guild.id,
          joinTime:    now,
          effectiveMs: 0,
          lastValidJoin: null,
          hasCompany,
          isMuted,
        };
        activeSessions.set(k, s);
        _syncCounting(s, now);
      }
    }
  }
}

function getActiveStats(guildId, since) {
  const now  = Date.now();
  const rows = [];
  for (const [, s] of activeSessions) {
    if (s.guildId !== guildId) continue;

    let validMs;
    if (s.joinTime >= since) {
      validMs = s.effectiveMs + (s.lastValidJoin !== null ? now - s.lastValidJoin : 0);
    } else {
      validMs = s.lastValidJoin !== null ? now - Math.max(s.lastValidJoin, since) : 0;
    }

    if (validMs > 0) {
      rows.push({ user_id: s.userId, username: s.username, channel_name: s.channelName, total_ms: validMs });
    }
  }
  return rows;
}

// ── Internals ─────────────────────────────────────────────────────────────────

function _isMuted(voiceState) {
  return !!(voiceState?.mute || voiceState?.deaf);
}

// Start or stop counting based on current hasCompany + isMuted
function _syncCounting(s, now) {
  const shouldCount = s.hasCompany && !s.isMuted;
  if (shouldCount && s.lastValidJoin === null) {
    s.lastValidJoin = now;
  } else if (!shouldCount && s.lastValidJoin !== null) {
    s.effectiveMs += now - s.lastValidJoin;
    s.lastValidJoin = null;
  }
}

function _closeSession(key, now) {
  const s = activeSessions.get(key);
  if (!s) return;
  if (s.lastValidJoin !== null) s.effectiveMs += now - s.lastValidJoin;
  if (s.effectiveMs > 0) saveVoiceSession(s);
  activeSessions.delete(key);
}

// Recompute hasCompany for all members in a channel (excluding one user we already handled)
function _refreshCompany(channel, guildId, now, skipUserId = null) {
  if (!channel) return;
  const nonBotMembers = [...channel.members.values()].filter(m => !m.user.bot);
  const hasCompany = nonBotMembers.length >= 2;

  for (const member of nonBotMembers) {
    if (member.id === skipUserId) continue;
    const s = activeSessions.get(`${member.id}:${guildId}`);
    if (!s || s.hasCompany === hasCompany) continue;
    s.hasCompany = hasCompany;
    _syncCounting(s, now);
  }
}

module.exports = { handleVoiceStateUpdate, initActiveSessions, getActiveStats };
