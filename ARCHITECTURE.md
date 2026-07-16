# Architektura FenixExelent 3.2

```text
index.js                         punkt startowy
deploy-commands.js               wdrażanie komend z jednej listy
src/application.js               Discord, moduły ochrony i zdarzenia
src/commands.js                  38 definicji komend i uprawnienia
src/config/defaultGuildConfig.js pełna konfiguracja serwera
src/services/database.js         PostgreSQL lub lokalny JSON
src/services/logger.js           bezpieczne logowanie
src/dashboard/server.js          OAuth2, API, sesje i audyt
src/dashboard/configValidation.js walidacja danych panelu
dashboard/public/dashboard.html  kompletny panel administracyjny
scripts/check.js                 kontrola kodu i zgodności komend
scripts/db-check.js              test zapisu danych
scripts/smoke.js                 test startu aplikacji i HTTP
```

## Zasady

- `index.js` uruchamia wyłącznie `src/application.js`.
- `src/commands.js` jest jedynym źródłem definicji komend Discord.
- Komendy mają domyślne uprawnienia Discord oraz ponowną kontrolę w handlerze.
- Dashboard zapisuje wyłącznie pola zaakceptowane przez walidator.
- Działania skutkowe, takie jak lockdown, Emergency Mode i backup restore, są osobnymi akcjami API.
- PostgreSQL jest zalecany w produkcji; lokalny JSON pozwala uruchomić bota bez zewnętrznej bazy.
