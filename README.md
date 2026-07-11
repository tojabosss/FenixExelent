# FenixExelentSecurity — naprawiona paczka

1. `npm install`
2. Skopiuj `.env.example` do `.env` i uzupełnij dane.
3. W Discord Developer Portal dodaj Redirect URL identyczny jak `REDIRECT_URI`.
4. `npm run deploy`
5. `npm start`

Panel: `/dashboard.html`.

Najważniejsze poprawki: bezpieczny zapis configu, pełna obsługa błędów API, meta kanałów/ról, poprawione listy w dashboardzie i czytelny komunikat błędu zapisu.


## Dostęp do komend

- Komendy są rejestrowane globalnie na wszystkich serwerach.
- Na oficjalnym serwerze supportowym (`1492793536930910310`) komend mogą używać tylko Owner, Administrator lub rola Developer (`1514607845872631868`).
- Na pozostałych serwerach wszystkie komendy są dostępne dla każdego użytkownika.
