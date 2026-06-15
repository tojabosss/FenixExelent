// Jeżeli w index.js NIE masz endpointu /api/stats, dodaj to wewnątrz startDashboard():

app.get('/api/stats', (req, res) => {
  return res.json({
    guilds: client.guilds.cache.size,
    users: client.guilds.cache.reduce((total, guild) => total + (guild.memberCount || 0), 0),
    uptime: Math.floor(process.uptime()),
    ping: client.ws.ping,
  });
});
