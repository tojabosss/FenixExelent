require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const commands = [
  new SlashCommandBuilder().setName('help').setDescription('📋 Wyświetl listę wszystkich komend'),
  new SlashCommandBuilder().setName('dashboard').setDescription('🌐 Otwórz panel webowy bota'),
  new SlashCommandBuilder().setName('setup').setDescription('⚙️ Automatycznie skonfiguruj kanały i kategorie serwera'),
  new SlashCommandBuilder().setName('security').setDescription('🛡️ Panel bezpieczeństwa'),
  new SlashCommandBuilder().setName('status').setDescription('📊 Status modułów bota'),
  new SlashCommandBuilder().setName('stats').setDescription('🔄 Odśwież statystyki serwera'),

  new SlashCommandBuilder()
    .setName('modlog')
    .setDescription('📋 Ustaw kanał logów moderacji')
    .addChannelOption(o => o.setName('kanal').setDescription('Kanał logów').setRequired(true)),

  new SlashCommandBuilder()
    .setName('antispam')
    .setDescription('🚫 Zarządzaj AntiSpam')
    .addSubcommand(s => s.setName('on').setDescription('Włącz AntiSpam'))
    .addSubcommand(s => s.setName('off').setDescription('Wyłącz AntiSpam'))
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Ustaw AntiSpam')
      .addIntegerOption(o => o.setName('wiadomosci').setDescription('Max wiadomości').setRequired(true).setMinValue(2).setMaxValue(20))
      .addIntegerOption(o => o.setName('czas').setDescription('Czas w sekundach').setRequired(true).setMinValue(1).setMaxValue(30))
      .addIntegerOption(o => o.setName('mute').setDescription('Mute w minutach').setRequired(false).setMinValue(1).setMaxValue(1440)))
    .addSubcommand(s => s
      .setName('log')
      .setDescription('Ustaw logi AntiSpam')
      .addChannelOption(o => o.setName('kanal').setDescription('Kanał logów').setRequired(true))),

  new SlashCommandBuilder()
    .setName('antiraid')
    .setDescription('🚨 Zarządzaj AntiRaid')
    .addSubcommand(s => s.setName('on').setDescription('Włącz AntiRaid'))
    .addSubcommand(s => s.setName('off').setDescription('Wyłącz AntiRaid'))
    .addSubcommand(s => s
      .setName('set')
      .setDescription('Ustaw AntiRaid')
      .addIntegerOption(o => o.setName('dolaczenia').setDescription('Max dołączeń').setRequired(true).setMinValue(2).setMaxValue(50))
      .addIntegerOption(o => o.setName('czas').setDescription('Czas w sekundach').setRequired(true).setMinValue(1).setMaxValue(60))
      .addStringOption(o => o.setName('akcja').setDescription('Akcja').setRequired(false).addChoices(
        { name: '👢 Kick', value: 'kick' },
        { name: '🔨 Ban', value: 'ban' },
        { name: '🔇 Mute', value: 'mute' },
      )))
    .addSubcommand(s => s
      .setName('lockdown')
      .setDescription('Włącz/wyłącz lockdown')
      .addBooleanOption(o => o.setName('aktywny').setDescription('true/false').setRequired(true)))
    .addSubcommand(s => s
      .setName('log')
      .setDescription('Ustaw logi AntiRaid')
      .addChannelOption(o => o.setName('kanal').setDescription('Kanał logów').setRequired(true))),

  new SlashCommandBuilder()
    .setName('channelguard')
    .setDescription('🔒 Zarządzaj Channel Guard')
    .addSubcommand(s => s.setName('on').setDescription('Włącz Channel Guard'))
    .addSubcommand(s => s.setName('off').setDescription('Wyłącz Channel Guard'))
    .addSubcommand(s => s
      .setName('whitelist')
      .setDescription('Dodaj rolę do whitelisty')
      .addRoleOption(o => o.setName('rola').setDescription('Rola').setRequired(true)))
    .addSubcommand(s => s
      .setName('log')
      .setDescription('Ustaw logi Channel Guard')
      .addChannelOption(o => o.setName('kanal').setDescription('Kanał logów').setRequired(true))),

  new SlashCommandBuilder()
    .setName('warn')
    .setDescription('⚠️ Ostrzeż użytkownika')
    .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
    .addStringOption(o => o.setName('powod').setDescription('Powód').setRequired(true)),

  new SlashCommandBuilder()
    .setName('warnings')
    .setDescription('📋 Sprawdź ostrzeżenia')
    .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true)),

  new SlashCommandBuilder()
    .setName('clearwarns')
    .setDescription('🗑️ Wyczyść ostrzeżenia')
    .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true)),

  new SlashCommandBuilder()
    .setName('kick')
    .setDescription('👢 Wyrzuć użytkownika')
    .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
    .addStringOption(o => o.setName('powod').setDescription('Powód').setRequired(false)),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('🔨 Zbanuj użytkownika')
    .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
    .addStringOption(o => o.setName('powod').setDescription('Powód').setRequired(false)),

  new SlashCommandBuilder()
    .setName('unban')
    .setDescription('✅ Odbanuj po ID')
    .addStringOption(o => o.setName('id').setDescription('ID użytkownika').setRequired(true)),

  new SlashCommandBuilder()
    .setName('unmute')
    .setDescription('🔊 Zdejmij muta')
    .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true)),

  new SlashCommandBuilder()
    .setName('verification')
    .setDescription('✅ Zarządzaj weryfikacją')
    .addSubcommand(s => s
      .setName('setup')
      .setDescription('Ustaw rolę weryfikacji')
      .addRoleOption(o => o.setName('rola').setDescription('Rola').setRequired(true)))
    .addSubcommand(s => s.setName('on').setDescription('Włącz weryfikację'))
    .addSubcommand(s => s.setName('off').setDescription('Wyłącz weryfikację'))
    .addSubcommand(s => s.setName('panel').setDescription('Wyślij panel weryfikacji')),

  new SlashCommandBuilder()
    .setName('ticket')
    .setDescription('🎫 Zarządzaj ticketami')
    .addSubcommand(s => s
      .setName('setup')
      .setDescription('Skonfiguruj tickety')
      .addRoleOption(o => o.setName('rola').setDescription('Rola supportu').setRequired(true))
      .addChannelOption(o => o.setName('logi').setDescription('Kanał logów').setRequired(false)))
    .addSubcommand(s => s.setName('on').setDescription('Włącz tickety'))
    .addSubcommand(s => s.setName('off').setDescription('Wyłącz tickety'))
    .addSubcommand(s => s.setName('panel').setDescription('Wyślij panel ticketów')),

  new SlashCommandBuilder()
  .setName('botserver')
  .setDescription('🔥 Oficjalny setup serwera supportowego FenixExelent')
  .addSubcommand(s => s
    .setName('setup')
    .setDescription('Utwórz kanały oficjalnego serwera supportowego'))
  .addSubcommand(s => s
    .setName('refresh')
    .setDescription('🔄 Odśwież embedy informacyjne PL/EN')),

new SlashCommandBuilder()
  .setName('antiscam')
  .setDescription('🔍 Zarządzaj AntiScam')
  .addSubcommand(s => s.setName('on').setDescription('Włącz AntiScam'))
  .addSubcommand(s => s.setName('off').setDescription('Wyłącz AntiScam'))
  .addSubcommand(s => s
    .setName('set')
    .setDescription('Ustaw AntiScam')
    .addIntegerOption(o => o
      .setName('mute')
      .setDescription('Mute w minutach')
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(1440))
    .addBooleanOption(o => o
      .setName('delete')
      .setDescription('Usuwać wiadomości scam?')
      .setRequired(false)))
  .addSubcommand(s => s
    .setName('whitelist')
    .setDescription('Dodaj domenę do whitelisty')
    .addStringOption(o => o
      .setName('domena')
      .setDescription('Np. discord.com')
      .setRequired(true)))
  .addSubcommand(s => s
    .setName('log')
    .setDescription('Ustaw logi AntiScam')
    .addChannelOption(o => o
      .setName('kanal')
      .setDescription('Kanał logów')
      .setRequired(true))),

new SlashCommandBuilder()
  .setName('risk')
  .setDescription('📊 Sprawdź reputację użytkownika')
  .addUserOption(o => o
    .setName('uzytkownik')
    .setDescription('Użytkownik')
    .setRequired(true)),

new SlashCommandBuilder()
  .setName('scamdomains')
  .setDescription('🌐 Zarządzaj bazą scam domen')
  .addSubcommand(s => s
    .setName('add')
    .setDescription('Dodaj domenę scam')
    .addStringOption(o => o
      .setName('domena')
      .setDescription('Np. fake-nitro.xyz')
      .setRequired(true)))
  .addSubcommand(s => s
    .setName('remove')
    .setDescription('Usuń domenę scam')
    .addStringOption(o => o
      .setName('domena')
      .setDescription('Domena')
      .setRequired(true)))
  .addSubcommand(s => s
    .setName('list')
    .setDescription('Pokaż listę scam domen')),

new SlashCommandBuilder()
  .setName('securitystats')
  .setDescription('🛡️ Statystyki bezpieczeństwa serwera'),

].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

(async () => {
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID;

  if (!process.env.BOT_TOKEN) {
    console.error('❌ Brak BOT_TOKEN w .env!');
    process.exit(1);
  }

  if (!clientId) {
    console.error('❌ Brak CLIENT_ID w .env!');
    process.exit(1);
  }

  try {
    console.log(`🔄 Rejestruję ${commands.length} komend slash...`);

    if (guildId) {
      await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      );
      console.log(`✅ Zarejestrowano ${commands.length} komend na serwerze ${guildId}`);
    } else {
      await rest.put(
        Routes.applicationCommands(clientId),
        { body: commands }
      );
      console.log(`✅ Zarejestrowano ${commands.length} komend globalnie`);
    }

    commands.forEach((cmd, i) => {
      console.log(`${i + 1}. /${cmd.name}`);
    });
  } catch (err) {
    console.error('❌ Błąd rejestracji:', err);
    process.exit(1);
  }
})();


