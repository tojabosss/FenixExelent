'use strict';

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const command = (name, description) => new SlashCommandBuilder()
  .setName(name)
  .setDescription(description)
  .setDMPermission(false);

const staff = (builder, permission = PermissionFlagsBits.ManageGuild) =>
  builder.setDefaultMemberPermissions(permission);

function getCommandBuilders() {
  return [
    command('help', 'Wyświetl listę komend'),
    command('dashboard', 'Otwórz panel WWW bota'),
    staff(command('setup', 'Automatycznie skonfiguruj serwer'), PermissionFlagsBits.Administrator),
    command('security', 'Wyświetl panel bezpieczeństwa'),
    command('status', 'Wyświetl status modułów bota'),
    staff(command('stats', 'Odśwież kanały statystyk serwera')),
    command('securitystats', 'Wyświetl statystyki bezpieczeństwa serwera'),
    command('servercheck', 'Oblicz wynik bezpieczeństwa serwera'),
    command('privacy', 'Otwórz politykę prywatności'),
    command('terms', 'Otwórz warunki korzystania'),
    command('about', 'Informacje o bocie'),
    command('support', 'Otwórz stronę pomocy'),

    staff(command('modlog', 'Ustaw kanał logów moderacji')
      .addChannelOption(o => o.setName('kanal').setDescription('Kanał logów').setRequired(true)
        .addChannelTypes(ChannelType.GuildText))),

    staff(command('antispam', 'Zarządzaj AntiSpam')
      .addSubcommand(s => s.setName('on').setDescription('Włącz AntiSpam'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz AntiSpam'))
      .addSubcommand(s => s.setName('set').setDescription('Ustaw parametry AntiSpam')
        .addIntegerOption(o => o.setName('wiadomosci').setDescription('Maksymalna liczba wiadomości').setRequired(true).setMinValue(2).setMaxValue(20))
        .addIntegerOption(o => o.setName('czas').setDescription('Okno czasowe w sekundach').setRequired(true).setMinValue(1).setMaxValue(60))
        .addIntegerOption(o => o.setName('mute').setDescription('Wyciszenie w minutach').setMinValue(1).setMaxValue(1440)))
      .addSubcommand(s => s.setName('log').setDescription('Ustaw kanał logów')
        .addChannelOption(o => o.setName('kanal').setDescription('Kanał logów').setRequired(true).addChannelTypes(ChannelType.GuildText)))),

    staff(command('antiraid', 'Zarządzaj AntiRaid')
      .addSubcommand(s => s.setName('on').setDescription('Włącz AntiRaid'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz AntiRaid'))
      .addSubcommand(s => s.setName('set').setDescription('Ustaw parametry AntiRaid')
        .addIntegerOption(o => o.setName('dolaczenia').setDescription('Maksymalna liczba dołączeń').setRequired(true).setMinValue(2).setMaxValue(50))
        .addIntegerOption(o => o.setName('czas').setDescription('Okno czasowe w sekundach').setRequired(true).setMinValue(1).setMaxValue(60))
        .addStringOption(o => o.setName('akcja').setDescription('Akcja po wykryciu').addChoices(
          { name: 'Kick', value: 'kick' }, { name: 'Ban', value: 'ban' }, { name: 'Mute', value: 'mute' })))
      .addSubcommand(s => s.setName('lockdown').setDescription('Włącz lub wyłącz lockdown')
        .addBooleanOption(o => o.setName('aktywny').setDescription('Stan lockdownu').setRequired(true)))
      .addSubcommand(s => s.setName('log').setDescription('Ustaw kanał logów')
        .addChannelOption(o => o.setName('kanal').setDescription('Kanał logów').setRequired(true).addChannelTypes(ChannelType.GuildText)))),

    staff(command('antiscam', 'Zarządzaj AntiScam')
      .addSubcommand(s => s.setName('on').setDescription('Włącz AntiScam'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz AntiScam'))
      .addSubcommand(s => s.setName('set').setDescription('Ustaw parametry AntiScam')
        .addIntegerOption(o => o.setName('mute').setDescription('Wyciszenie w minutach').setMinValue(1).setMaxValue(1440))
        .addBooleanOption(o => o.setName('delete').setDescription('Usuwać wiadomości scam'))) 
      .addSubcommand(s => s.setName('whitelist').setDescription('Dodaj bezpieczną domenę')
        .addStringOption(o => o.setName('domena').setDescription('Domena, np. example.com').setRequired(true)))
      .addSubcommand(s => s.setName('log').setDescription('Ustaw kanał logów')
        .addChannelOption(o => o.setName('kanal').setDescription('Kanał logów').setRequired(true).addChannelTypes(ChannelType.GuildText)))),

    staff(command('scamdomains', 'Zarządzaj bazą domen scam')
      .addSubcommand(s => s.setName('add').setDescription('Dodaj domenę')
        .addStringOption(o => o.setName('domena').setDescription('Jedna lub wiele domen').setRequired(true)))
      .addSubcommand(s => s.setName('remove').setDescription('Usuń domenę')
        .addStringOption(o => o.setName('domena').setDescription('Domena').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('Wyświetl domeny'))),

    staff(command('ocrscan', 'Zarządzaj skanowaniem OCR')
      .addSubcommand(s => s.setName('on').setDescription('Włącz OCR'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz OCR'))
      .addSubcommand(s => s.setName('strict').setDescription('Ustaw tryb ostry')
        .addBooleanOption(o => o.setName('aktywny').setDescription('Stan trybu ostrego').setRequired(true)))
      .addSubcommand(s => s.setName('status').setDescription('Wyświetl ustawienia OCR'))),

    staff(command('antialt', 'Zarządzaj ochroną przed nowymi kontami')
      .addSubcommand(s => s.setName('on').setDescription('Włącz AntiAlt'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz AntiAlt'))
      .addSubcommand(s => s.setName('set').setDescription('Ustaw parametry AntiAlt')
        .addIntegerOption(o => o.setName('mindays').setDescription('Minimalny wiek konta w dniach').setMinValue(1).setMaxValue(365))
        .addChannelOption(o => o.setName('logi').setDescription('Kanał logów').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand(s => s.setName('status').setDescription('Wyświetl status AntiAlt'))),

    command('risk', 'Sprawdź swój wynik ryzyka lub wynik użytkownika')
      .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik (staff może sprawdzać innych)')),
    command('reportscam', 'Zgłoś podejrzany link lub użytkownika')
      .addStringOption(o => o.setName('link').setDescription('Link lub domena'))
      .addUserOption(o => o.setName('uzytkownik').setDescription('Podejrzany użytkownik'))
      .addStringOption(o => o.setName('opis').setDescription('Opis zgłoszenia').setMaxLength(700)),

    staff(command('reactionroles', 'Zarządzaj panelem ról przez reakcje')
      .addSubcommand(s => s.setName('setup').setDescription('Utwórz panel ról')
        .addChannelOption(o => o.setName('kanal').setDescription('Kanał panelu').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand(s => s.setName('status').setDescription('Wyświetl status panelu'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz nadawanie ról przez reakcje'))),

    staff(command('channelguard', 'Zarządzaj ochroną kanałów')
      .addSubcommand(s => s.setName('on').setDescription('Włącz Channel Guard'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz Channel Guard'))
      .addSubcommand(s => s.setName('whitelist').setDescription('Dodaj rolę do wyjątków')
        .addRoleOption(o => o.setName('rola').setDescription('Rola').setRequired(true)))
      .addSubcommand(s => s.setName('log').setDescription('Ustaw kanał logów')
        .addChannelOption(o => o.setName('kanal').setDescription('Kanał logów').setRequired(true).addChannelTypes(ChannelType.GuildText)))),

    staff(command('securityignore', 'Zarządzaj wyjątkami filtrów bezpieczeństwa')
      .addSubcommand(s => s.setName('channel').setDescription('Ignoruj kanał')
        .addChannelOption(o => o.setName('kanal').setDescription('Kanał').setRequired(true)))
      .addSubcommand(s => s.setName('role').setDescription('Ignoruj rolę')
        .addRoleOption(o => o.setName('rola').setDescription('Rola').setRequired(true)))
      .addSubcommand(s => s.setName('removechannel').setDescription('Usuń kanał z wyjątków')
        .addChannelOption(o => o.setName('kanal').setDescription('Kanał').setRequired(true)))
      .addSubcommand(s => s.setName('removerole').setDescription('Usuń rolę z wyjątków')
        .addRoleOption(o => o.setName('rola').setDescription('Rola').setRequired(true)))
      .addSubcommand(s => s.setName('list').setDescription('Wyświetl wyjątki'))),

    staff(command('warn', 'Nadaj ostrzeżenie użytkownikowi'), PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
      .addStringOption(o => o.setName('powod').setDescription('Powód').setRequired(true).setMaxLength(500)),
    staff(command('warnings', 'Wyświetl ostrzeżenia użytkownika'), PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true)),
    staff(command('clearwarns', 'Wyczyść ostrzeżenia użytkownika'), PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true)),
    staff(command('kick', 'Wyrzuć użytkownika'), PermissionFlagsBits.KickMembers)
      .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
      .addStringOption(o => o.setName('powod').setDescription('Powód').setMaxLength(500)),
    staff(command('ban', 'Zbanuj użytkownika'), PermissionFlagsBits.BanMembers)
      .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true))
      .addStringOption(o => o.setName('powod').setDescription('Powód').setMaxLength(500)),
    staff(command('unban', 'Odbanuj użytkownika po ID'), PermissionFlagsBits.BanMembers)
      .addStringOption(o => o.setName('id').setDescription('ID użytkownika').setRequired(true)),
    staff(command('unmute', 'Zdejmij wyciszenie'), PermissionFlagsBits.ModerateMembers)
      .addUserOption(o => o.setName('uzytkownik').setDescription('Użytkownik').setRequired(true)),

    staff(command('verification', 'Zarządzaj weryfikacją')
      .addSubcommand(s => s.setName('setup').setDescription('Ustaw rolę po weryfikacji')
        .addRoleOption(o => o.setName('rola').setDescription('Rola').setRequired(true)))
      .addSubcommand(s => s.setName('on').setDescription('Włącz weryfikację'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz weryfikację'))
      .addSubcommand(s => s.setName('panel').setDescription('Wyślij panel weryfikacji'))),

    staff(command('ticket', 'Zarządzaj ticketami')
      .addSubcommand(s => s.setName('setup').setDescription('Skonfiguruj tickety')
        .addRoleOption(o => o.setName('rola').setDescription('Rola supportu').setRequired(true))
        .addChannelOption(o => o.setName('logi').setDescription('Kanał logów').addChannelTypes(ChannelType.GuildText)))
      .addSubcommand(s => s.setName('on').setDescription('Włącz tickety'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz tickety'))
      .addSubcommand(s => s.setName('panel').setDescription('Wyślij panel ticketów'))),

    staff(command('backup', 'Twórz i przywracaj kopie ustawień serwera'), PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('create').setDescription('Utwórz backup'))
      .addSubcommand(s => s.setName('list').setDescription('Wyświetl backupy'))
      .addSubcommand(s => s.setName('restore').setDescription('Przywróć backup')
        .addStringOption(o => o.setName('id').setDescription('ID backupu').setRequired(true))),

    command('appeal', 'Wyślij lub obsłuż odwołanie')
      .addSubcommand(s => s.setName('submit').setDescription('Wyślij odwołanie')
        .addStringOption(o => o.setName('powod').setDescription('Treść odwołania').setRequired(true).setMaxLength(1000)))
      .addSubcommand(s => s.setName('setup').setDescription('Ustaw kanał odwołań')
        .addChannelOption(o => o.setName('kanal').setDescription('Kanał').setRequired(true).addChannelTypes(ChannelType.GuildText)))
      .addSubcommand(s => s.setName('review').setDescription('Sprawdź odwołanie')
        .addStringOption(o => o.setName('id').setDescription('ID odwołania').setRequired(true))),

    staff(command('emergency', 'Zarządzaj trybem awaryjnym'), PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('on').setDescription('Włącz tryb awaryjny'))
      .addSubcommand(s => s.setName('off').setDescription('Wyłącz tryb awaryjny'))
      .addSubcommand(s => s.setName('status').setDescription('Wyświetl status trybu awaryjnego')),

    staff(command('refreshbot', 'Odśwież konfigurację i statystyki bota'), PermissionFlagsBits.Administrator),
    staff(command('botserver', 'Konfiguracja oficjalnego serwera supportowego'), PermissionFlagsBits.Administrator)
      .addSubcommand(s => s.setName('setup').setDescription('Utwórz kanały serwera supportowego'))
      .addSubcommand(s => s.setName('refresh').setDescription('Odśwież embedy informacyjne')),
  ];
}

module.exports = { getCommandBuilders };
