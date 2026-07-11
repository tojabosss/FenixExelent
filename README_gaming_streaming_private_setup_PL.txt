FenixExelentSecurity — prywatny gaming/streaming server setup

Dodane komendy:
/gamingserver preview — pokazuje, co zostanie utworzone
/gamingserver security — włącza wszystkie zabezpieczenia bez usuwania kanałów
/gamingserver reset potwierdz:USUN WSZYSTKO — usuwa wszystkie kanały i tworzy nowy serwer

Zabezpieczenia:
- Komenda działa tylko na serwerze ID 1462330169669980244
- Może jej używać tylko właściciel serwera albo ID z GAMING_SETUP_OWNER_ID / OWNER_ID
- Reset wymaga dokładnego potwierdzenia: USUN WSZYSTKO
- Przed resetem bot zapisuje backup konfiguracji kanałów/ról w config.json

Render Environment zalecane:
GAMING_SETUP_GUILD_ID=1462330169669980244
GAMING_SETUP_OWNER_ID=TWÓJ_DISCORD_USER_ID
SUPPORT_GUILD_ID=1462330169669980244
AUTO_TRANSLATE_ENABLED=false

Po podmianie:
node --check .\index.js
node --check .\deploy-commands.js
node .\deploy-commands.js
git add .\index.js .\deploy-commands.js
git commit -m "Add private gaming streaming server setup"
git push origin main
