FenixExelent - index.js poprawiony pod dashboard Discord OAuth2

Co poprawiono:
1. startDashboard() oczyszczony z błędnej linii:
   express.static(path.join(...))
2. Logowanie Discord OAuth2:
   /login
   /callback
   /logout
   /api/me
   /api/guilds
3. Dodano endpoint wymagany przez dashboard:
   /api/guild/:guildId/meta
4. Rozszerzono zapis dashboardu:
   /api/config/:guildId zapisuje antispam, antiraid, antiscam, channelGuard, verification, tickets i modLog.
5. Dodano obsługę akcji z dashboardu:
   sendVerificationPanel
   sendTicketPanel
   lockdown
6. Poprawiono blokadę komend:
   tylko na support serwerze komend może używać właściciel.
   Na innych serwerach komendy działają normalnie.
7. Dodano antiscam do defaultGuildConfig.
8. Sprawdzono składnię:
   node --check OK

Wymagane ustawienia Render / .env:
DASHBOARD_URL=https://fenixexelent.onrender.com
REDIRECT_URI=https://fenixexelent.onrender.com/callback
CLIENT_ID=twoje_client_id
CLIENT_SECRET=nowy_client_secret
BOT_TOKEN=nowy_bot_token
SESSION_SECRET=dlugi_losowy_tekst
OWNER_ID=1075478964505677824
SUPPORT_GUILD_ID=1492793536930910310

W Discord Developer Portal -> OAuth2 -> Redirects dodaj dokładnie:
https://fenixexelent.onrender.com/callback

Po podmianie:
1. Podmień index.js
2. Restart / redeploy na Render
3. Wejdź:
   https://fenixexelent.onrender.com/login
