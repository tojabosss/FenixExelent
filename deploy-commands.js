'use strict';

require('dotenv').config();
const { REST, Routes } = require('discord.js');
const { getCommandBuilders } = require('./src/commands');

function getCommandTargetGuildId(args = process.argv.slice(2)) {
  const guildArgument = args.find(argument => String(argument).startsWith('--guild='));
  return guildArgument ? String(guildArgument).slice('--guild='.length).trim() : '';
}

async function deployCommands() {
  const token = String(process.env.BOT_TOKEN || '').trim();
  const clientId = String(process.env.CLIENT_ID || '').trim();
  const guildId = getCommandTargetGuildId();
  if (!token) throw new Error('Brak BOT_TOKEN w .env');
  if (!clientId) throw new Error('Brak CLIENT_ID w .env');

  const commands = getCommandBuilders().map(builder => builder.toJSON());
  const names = commands.map(item => item.name);
  if (new Set(names).size !== names.length) throw new Error('Wykryto zduplikowane nazwy komend');

  const rest = new REST({ version: '10' }).setToken(token);
  // Zwykłe `npm run deploy` zawsze rejestruje komendy globalnie, dzięki czemu
  // każdy serwer, na którym zainstalowano bota, otrzymuje ten sam zestaw.
  // Wdrożenie testowe na pojedynczy serwer wymaga jawnego `--guild=ID`.
  const route = guildId
    ? Routes.applicationGuildCommands(clientId, guildId)
    : Routes.applicationCommands(clientId);
  await rest.put(route, { body: commands });
  console.log(`Zarejestrowano ${commands.length} komend ${guildId ? `na serwerze ${guildId}` : 'globalnie'}.`);
  console.log(names.map(name => `/${name}`).join(', '));
}

if (require.main === module) {
  deployCommands().catch(error => {
    console.error('Błąd rejestracji komend:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { deployCommands, getCommandTargetGuildId };
