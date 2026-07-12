# FenixExelent Security v3.1

Publiczny bot Discord z dashboardem, modułową strukturą, PostgreSQL i logowaniem Pino.

## Najważniejsze zmiany

- PostgreSQL zamiast `config.json` i SQLite.
- Dane nie znikają po restarcie lub redeployu darmowej usługi Render.
- Oddzielna konfiguracja dla każdego serwera Discord.
- Automatyczna migracja starego `config.json` do PostgreSQL przy pierwszym uruchomieniu.
- Kolejkowanie zapisów konfiguracji, aby ograniczyć konflikty przy wielu zmianach.
- Audit log zmian dashboardu w tabeli `audit_log`.
- Pino z kontekstem serwera, użytkownika, kanału, komendy i przycisku.

## Struktura

```text
index.js
src/
  application.js
  config/defaultGuildConfig.js
  services/database.js
  services/logger.js
dashboard/public/
deploy-commands.js
```

## PostgreSQL

Możesz użyć PostgreSQL z Render, Neon, Supabase lub własnego serwera. Bot potrzebuje jednej zmiennej:

```env
DATABASE_URL=postgresql://user:password@host:5432/database
```

Dla zdalnej bazy użyj:

```env
DATABASE_SSL=true
```

Dla lokalnego PostgreSQL bez SSL:

```env
DATABASE_SSL=false
```

Przy pierwszym uruchomieniu bot sam utworzy tabele:

- `app_config`
- `guild_config`
- `audit_log`

## Render bez płatnego dysku

Nie dodawaj Persistent Disk. PostgreSQL jest zewnętrzną, trwałą bazą danych.

Ustaw w Render:

```text
Build Command: npm install
Start Command: npm start
```

Zmienne środowiskowe:

```env
NODE_ENV=production
LOG_LEVEL=info
BOT_TOKEN=...
CLIENT_ID=...
CLIENT_SECRET=...
SESSION_SECRET=...
DASHBOARD_URL=https://twoja-usluga.onrender.com
REDIRECT_URI=https://twoja-usluga.onrender.com/callback
DATABASE_URL=postgresql://...
DATABASE_SSL=true
SUPPORT_GUILD_ID=1492793536930910310
OWNER_ID=1075478964505677824
DEVELOPER_ROLE_ID=1514607845872631868
```

Nie ustawiaj `GUILD_ID`, ponieważ komendy są rejestrowane globalnie.

## Instalacja

```bash
npm install
npm run check
npm run db:check
npm run deploy
npm start
```

`npm run deploy` wykonaj po zmianach definicji komend. Nie ustawiaj go jako Start Command.

## Migracja starego config.json

Jeżeli w katalogu głównym znajduje się `config.json`, a tabela `guild_config` jest pusta, bot:

1. odczyta konfigurację,
2. zapisze ustawienia w PostgreSQL,
3. zmieni nazwę pliku na `config.json.migrated`.

Nie publikuj `.env`, `config.json` ani `config.json.migrated` w GitHubie.

## Kontrola po wdrożeniu

Otwórz:

```text
https://twoja-usluga.onrender.com/ping
```

Oczekiwana odpowiedź:

```json
{"ok":true,"uptime":123}
```

W logach powinny pojawić się komunikaty:

```text
PostgreSQL database initialized
Configuration loaded
Dashboard: https://...
```
