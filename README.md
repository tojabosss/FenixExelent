# FenixExelent Security 3.2

Bot Discord z panelem WWW, ochroną AntiSpam/AntiRaid/AntiScam/AntiAlt, OCR obrazów, weryfikacją, ticketami, backupami, odwołaniami i moderacją.

## Wymagania

- Node.js 20.11 lub nowszy,
- aplikacja i bot utworzone w Discord Developer Portal,
- opcjonalnie PostgreSQL (Render, Neon, Supabase lub własny serwer).

Bez `DATABASE_URL` bot automatycznie zapisuje dane w `data/config.json`. W produkcji zalecany jest PostgreSQL.

## Instalacja

1. Skopiuj `.env.example` jako `.env`.
2. Uzupełnij co najmniej `BOT_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, `SESSION_SECRET`, `DASHBOARD_URL` i `REDIRECT_URI`.
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

## Konfiguracja Discord OAuth2

W Discord Developer Portal dodaj adres przekierowania identyczny z `REDIRECT_URI`, np.:

```text
https://twoja-domena.example/callback
```

Panel jest dostępny pod `/dashboard.html`. Logowanie wymaga konta z uprawnieniem Administrator na wybranym serwerze.

## Bezpieczeństwo komend

- Komendy konfiguracyjne wymagają `Manage Server` lub roli ustawionej jako rola administratora bota.
- Komendy moderacyjne wymagają uprawnień moderatora lub skonfigurowanej roli moderatora.
- Publiczne pozostają m.in. pomoc, status, zgłaszanie scamów i wysyłanie odwołania.
- Kontrola działa jednocześnie po stronie Discorda i w kodzie bota.

Po aktualizacji koniecznie wykonaj `npm run deploy`, aby Discord otrzymał nowe ograniczenia uprawnień.

## Dashboard

Panel obsługuje:

- publiczne statystyki na żywo oraz zapamiętywany wybór 15 języków,
- AntiSpam, AntiRaid i lockdown,
- AntiScam, OCR oraz białą/czarną listę domen,
- AntiAlt i punkty ryzyka,
- Reaction Roles oraz tworzenie panelu ról,
- Channel Guard oraz wyjątki ról,
- weryfikację i wysyłanie panelu Verify,
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

Ustaw `NODE_ENV=production`, bezpieczny `SESSION_SECRET` (minimum 32 znaki) oraz publiczne adresy HTTPS w `DASHBOARD_URL` i `REDIRECT_URI`.

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

## Ważne

Nie publikuj `.env`, katalogu `data/`, tokenów ani prywatnych konfiguracji. ZIP wydania ich nie zawiera.
