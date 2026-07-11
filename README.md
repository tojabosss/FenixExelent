# FenixExelentSecurity — naprawiona paczka

1. `npm install`
2. Skopiuj `.env.example` do `.env` i uzupełnij dane.
3. W Discord Developer Portal dodaj Redirect URL identyczny jak `REDIRECT_URI`.
4. `npm run deploy`
5. `npm start`

Panel: `/dashboard.html`.

Najważniejsze poprawki: bezpieczny zapis configu, pełna obsługa błędów API, meta kanałów/ról, poprawione listy w dashboardzie i czytelny komunikat błędu zapisu.


## Verification v2
1. Uruchom `npm run deploy`.
2. Na Discordzie użyj `/verify setup`.
3. Ustaw rolę bota wyżej niż role Member i Niezweryfikowany.
4. Nowy użytkownik automatycznie otrzyma rolę Niezweryfikowany, a po poprawnej weryfikacji rolę Member.


## Tryb wielu serwerów i publiczne komendy

- Komendy są rejestrowane globalnie, jeśli `DEPLOY_GUILD_ID` pozostaje puste.
- Każdy członek serwera może wywołać każdą komendę slash i używać przycisków administracyjnych.
- Bot nadal musi mieć odpowiednie uprawnienia Discorda i rolę ustawioną nad rolami, którymi zarządza.
- Uwaga: publiczny dostęp obejmuje także komendy destrukcyjne, takie jak ban, kick, backup restore, lockdown i konfiguracja zabezpieczeń.
