const BOT_ID = '1492580561364193572';

const commands = [
  { name: 'help', description: 'Wyswietl liste komend', type: 1 },
  { name: 'dashboard', description: 'Otworz panel webowy', type: 1 },
  { name: 'setup', description: 'Skonfiguruj serwer', type: 1 },
  { name: 'security', description: 'Panel bezpieczenstwa', type: 1 },
  { name: 'status', description: 'Status modulow bota', type: 1 },
  { name: 'stats', description: 'Odswiez statystyki', type: 1 },
  { name: 'modlog', description: 'Ustaw kanal logow moderacji', type: 1 },
  { name: 'antispam', description: 'Zarzadzaj modulem AntiSpam', type: 1 },
  { name: 'antiraid', description: 'Zarzadzaj modulem AntiRaid', type: 1 },
  { name: 'channelguard', description: 'Zarzadzaj Channel Guard', type: 1 },
  { name: 'warn', description: 'Wydaj ostrzezenie', type: 1 },
  { name: 'warnings', description: 'Sprawdz ostrzezenia', type: 1 },
  { name: 'clearwarns', description: 'Wyczysc ostrzezenia', type: 1 },
  { name: 'kick', description: 'Wyrzuc uzytkownika', type: 1 },
  { name: 'ban', description: 'Zbanuj uzytkownika', type: 1 },
  { name: 'unban', description: 'Odbanuj uzytkownika', type: 1 },
  { name: 'unmute', description: 'Zdejmij muta', type: 1 },
  { name: 'verification', description: 'System weryfikacji', type: 1 },
  { name: 'ticket', description: 'System ticketow', type: 1 }
];

fetch(`https://discordbotlist.com/api/v1/bots/${BOT_ID}/commands`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': "eyJhbGciOiJIUzI1NiJ9.eyJhcGkiOnRydWUsImlkIjoiMTA3NTQ3ODk2NDUwNTY3NzgyNCIsImlhdCI6MTc4MTI0Nzg1Mn0.AqMc6DU3n9Md2BdtjICsj8-C1AgoKNmxMMn2tbfgC0Y"
  },
  body: JSON.stringify(commands)
}).then(r => r.json()).then(console.log).catch(console.error);