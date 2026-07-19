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
src/modules/verification/        Fenix Secure Verification v4.2
  SessionManager.js              hashowane tokeny, TTL i jednorazowe stany OAuth2
  RateLimiter.js                 limity prób użytkownika i połączenia
  PluginRegistry.js              rejestr metod weryfikacji
  VerificationManager.js         orkiestracja metod, role, audyt i logi
  routes.js                      Turnstile i callback Discord OAuth2
  plugins/discord.js             metoda bezpośrednio na zwykłych serwerach
  plugins/web.js                 metoda WWW wyłącznie dla oficjalnego supportu
  plugins/language.js            metoda wyłącznie dla oficjalnego supportu
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
- Zwykłe serwery weryfikują użytkownika bezpośrednio z podpisanej interakcji Discord; nie otwierają strony WWW.
- Na oficjalnym supporcie token WWW jest jednorazowy, wygasa i jest przechowywany wyłącznie jako SHA-256; callback OAuth2 używa osobnego jednorazowego `state`.
- Nowe metody weryfikacji są rejestrowane przez `PluginRegistry`, a nadanie roli następuje dopiero po ukończeniu całego łańcucha.
- Działania skutkowe, takie jak lockdown, Emergency Mode i backup restore, są osobnymi akcjami API.
- PostgreSQL jest zalecany w produkcji; lokalny JSON pozwala uruchomić bota bez zewnętrznej bazy.
