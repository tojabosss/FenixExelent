# FenixExelent Security 3.2

Bot Discord z panelem WWW, ochroną AntiSpam/AntiRaid/AntiScam/AntiAlt, OCR obrazów, modułowym Fenix Secure Verification v4, ticketami, backupami, odwołaniami i moderacją.

## Wymagania

- Node.js 20.11 lub nowszy,
- aplikacja i bot utworzone w Discord Developer Portal,
- opcjonalnie PostgreSQL (Render, Neon, Supabase lub własny serwer).

Bez `DATABASE_URL` bot automatycznie zapisuje dane w `data/config.json`. W produkcji zalecany jest PostgreSQL.

## Instalacja

1. Skopiuj `.env.example` jako `.env`.
2. Uzupełnij co najmniej `BOT_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, `SESSION_SECRET`, `DASHBOARD_URL`, `REDIRECT_URI`, `VERIFICATION_REDIRECT_URI`, `TURNSTILE_SITE_KEY` i `TURNSTILE_SECRET_KEY`.
3. Zainstaluj zależności i sprawdź paczkę:

```bash
npm install
npm test
```

4. Zarejestruj komplet 38 komend Discord:

```bash
npm run deploy
```

5. Uruchom bota:

```bash
npm start
```

Po każdej zmianie definicji komend uruchom ponownie `npm run deploy`.
Polecenie wdraża komendy globalnie dla wszystkich serwerów i celowo ignoruje stare `GUILD_ID`. Wdrożenie testowe tylko na jednym serwerze wymaga jawnego `npm run deploy -- --guild=ID_SERWERA`.

## Konfiguracja Discord OAuth2

W Discord Developer Portal dodaj adres przekierowania identyczny z `REDIRECT_URI`, np.:

```text
https://twoja-domena.example/callback
```

Dodaj także osobny adres callbacku weryfikacji identyczny z `VERIFICATION_REDIRECT_URI`:

```text
https://twoja-domena.example/verification/callback
```

W Cloudflare Turnstile utwórz widget dla publicznej domeny bota, a site key i secret key umieść wyłącznie w zmiennych środowiskowych. W produkcji używaj HTTPS. Sekret Turnstile nigdy nie trafia do przeglądarki.

Panel jest dostępny pod `/dashboard.html`. Logowanie wymaga konta z uprawnieniem Administrator na wybranym serwerze.

## Bezpieczeństwo komend

- Komendy konfiguracyjne wymagają `Manage Server` lub roli ustawionej jako rola administratora bota.
- Komendy moderacyjne wymagają uprawnień moderatora lub skonfigurowanej roli moderatora.
- Publiczne pozostają m.in. pomoc, status, zgłaszanie scamów i wysyłanie odwołania.
- Kontrola działa jednocześnie po stronie Discorda i w kodzie bota.
- Na serwerze `SUPPORT_GUILD_ID` wszystkie komendy są prywatne: dostęp ma tylko `OWNER_ID` oraz `DEVELOPER_ID` lub `DEVELOPER_ROLE_ID`.
- Publiczne przyciski weryfikacji, języka i otwierania ticketów nadal działają dla użytkowników supportu.

Jeżeli rola Developer nie ma systemowego uprawnienia wymaganego przez daną komendę, zezwól jej na komendy w **Ustawienia serwera → Integracje → FenixExelent → Komendy**.

Po aktualizacji koniecznie wykonaj `npm run deploy`, aby Discord otrzymał nowe ograniczenia uprawnień.

## Dashboard

Panel obsługuje:

- publiczne statystyki na żywo oraz zapamiętywany wybór 15 języków,
- AntiSpam, AntiRaid i lockdown,
- AntiScam, OCR oraz białą/czarną listę domen,
- AntiAlt i punkty ryzyka,
- Reaction Roles oraz tworzenie panelu ról,
- Channel Guard oraz wyjątki ról,
- Fenix Secure Verification v4: metody pluginowe, Discord OAuth2, Cloudflare Turnstile, jednorazowe linki, limity prób, logi i wysyłanie panelu Verify,
- tickety i wysyłanie panelu ticketów,
- role administratora/moderatora i kanały logów,
- Emergency Mode,
- kanały i role ignorowane przez filtry,
- odwołania, backupy i przywracanie ustawień,
- warn, clearwarns, unmute, kick, ban, unban oraz podgląd risk score.

## PostgreSQL

Ustaw:

```env
DATABASE_URL=postgresql://user:password@host:5432/database
DATABASE_SSL=true
```

Bot sam tworzy tabele konfiguracji, audytu i sesji dashboardu. Bez PostgreSQL używa lokalnego katalogu `data/`, który należy zachować między restartami.

## Render

```text
Build Command: npm install
Start Command: npm start
```

Ustaw `NODE_ENV=production`, bezpieczny `SESSION_SECRET` (minimum 32 znaki), publiczne adresy HTTPS w `DASHBOARD_URL`, `REDIRECT_URI` i `VERIFICATION_REDIRECT_URI`, klucze `TURNSTILE_SITE_KEY` i `TURNSTILE_SECRET_KEY` oraz `DATABASE_URL` do PostgreSQL.

Na Renderze lokalny `json-file` nie jest trwałym magazynem. Bez `DATABASE_URL` konfiguracja serwerów, w tym włączona weryfikacja i wybrane role, może zniknąć po restarcie lub wdrożeniu.

## Kontrola działania

```bash
npm run check
npm run db:check
npm run smoke
```

Endpoint zdrowia:

```text
GET /ping
```

Zwraca m.in. stan połączenia Discord i używany magazyn danych.

## Fenix Secure Verification v4

Standardowy przepływ na wszystkich serwerach:

```text
przycisk Discord → jednorazowy link → Cloudflare Turnstile
→ Discord OAuth2 (scope identify) → porównanie ID użytkownika
→ nadanie roli → usunięcie roli niezweryfikowanej → audyt i log Discord
```

Link domyślnie wygasa po 5 minutach i nie może zostać ponownie użyty. Token jest przechowywany w postaci skrótu. Limity użytkownika i połączenia można ustawić w dashboardzie.

Na oficjalnym serwerze `SUPPORT_GUILD_ID` po etapie WWW wymagany jest dodatkowo istniejący wybór języka PL/EN/TR/DE/FR. Plugin językowy nie jest oferowany na innych serwerach.

Szczegóły interfejsu pluginów znajdują się w `src/modules/verification/README.md`.

## Ważne

Nie publikuj `.env`, katalogu `data/`, tokenów ani prywatnych konfiguracji. ZIP wydania ich nie zawiera.
