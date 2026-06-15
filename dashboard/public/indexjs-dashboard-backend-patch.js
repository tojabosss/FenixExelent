// WKLEJ W index.js WEWNĄTRZ function startDashboard()
// 1) Dodaj ten endpoint przed app.get('/api/config/:guildId', ...)

app.get('/api/guild/:guildId/meta', requireAuth, async (req, res) => {
  const { guildId } = req.params;
  if (!hasAdminOnGuild(req, guildId)) return res.status(403).json({ error: 'Brak uprawnień' });

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: 'Bot nie jest na tym serwerze' });

  await guild.channels.fetch().catch(() => {});
  await guild.roles.fetch().catch(() => {});

  const channels = guild.channels.cache
    .filter(ch => ch.type === ChannelType.GuildText)
    .map(ch => ({ id: ch.id, name: ch.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const roles = guild.roles.cache
    .filter(r => !r.managed && r.id !== guild.roles.everyone.id)
    .map(r => ({ id: r.id, name: r.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  res.json({ channels, roles });
});

// 2) ZAMIEŃ cały stary app.post('/api/config/:guildId'...) na ten:

app.post('/api/config/:guildId', requireAuth, async (req, res) => {
  const { guildId } = req.params;
  if (!hasAdminOnGuild(req, guildId)) return res.status(403).json({ error: 'Brak uprawnień' });

  const guild = client.guilds.cache.get(guildId);
  if (!guild) return res.status(404).json({ error: 'Bot nie jest na tym serwerze' });

  const gc = getGuildConfig(guildId);
  const allowed = ['antispam', 'antiraid', 'channelGuard', 'verification', 'tickets', 'modLog'];

  for (const key of allowed) {
    if (req.body[key]) Object.assign(gc[key], req.body[key]);
  }

  const actions = req.body.actions || {};

  if (req.body.antiraid?.lockdownActive !== undefined) {
    for (const [, ch] of guild.channels.cache) {
      if (ch.type === ChannelType.GuildText) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, {
          SendMessages: req.body.antiraid.lockdownActive ? false : null,
        }).catch(() => {});
      }
    }
  }

  if (actions.sendVerificationPanel) {
    const channelId = gc.verification.channelId;
    const ch = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
    if (ch) await sendVerifyPanel(ch).catch(console.error);
  }

  if (actions.sendTicketPanel) {
    const channelId = gc.tickets.panelChannelId || gc.tickets.logChannelId;
    const ch = channelId ? await guild.channels.fetch(channelId).catch(() => null) : null;
    if (ch) await sendTicketPanel(ch).catch(console.error);
  }

  saveConfig();

  const logChannelId = gc.modLog?.channelId || gc.antiraid?.logChannel || gc.antispam?.logChannel || gc.channelGuard?.logChannel;
  if (logChannelId) {
    const logCh = await guild.channels.fetch(logChannelId).catch(() => null);
    if (logCh) {
      await logCh.send({
        embeds: [embed(
          '#2ed573',
          '⚙️ Dashboard zaktualizowany',
          'Ustawienia serwera zostały zmienione przez panel WWW.',
          [
            { name: 'AntiSpam', value: gc.antispam.enabled ? '✅ Włączony' : '❌ Wyłączony', inline: true },
            { name: 'AntiRaid', value: gc.antiraid.enabled ? '✅ Włączony' : '❌ Wyłączony', inline: true },
            { name: 'Channel Guard', value: gc.channelGuard.blockNewChannels ? '✅ Aktywny' : '❌ Wyłączony', inline: true },
          ]
        )]
      }).catch(() => {});
    }
  }

  res.json({ success: true, config: gc });
});