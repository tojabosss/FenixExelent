# FenixExelentSecurity — naprawiona paczka

1. `npm install`
2. Skopiuj `.env.example` do `.env` i uzupełnij dane.
3. W Discord Developer Portal dodaj Redirect URL identyczny jak `REDIRECT_URI`.
4. `npm run deploy`
5. `npm start`

Panel: `/dashboard.html`.

Najważniejsze poprawki: bezpieczny zapis configu, pełna obsługa błędów API, meta kanałów/ról, poprawione listy w dashboardzie i czytelny komunikat błędu zapisu.


## Panel weryfikacji z wyborem języka

Panel zawiera przycisk weryfikacji oraz przyciski: Polski, English, Türkçe, Deutsch i Français.
Role językowe są tworzone automatycznie przy pierwszym wyborze i zapisywane osobno dla każdego serwera.
Użytkownik może mieć jedną rolę językową naraz. Po weryfikacji bot nadaje skonfigurowaną rolę Member i usuwa rolę Niezweryfikowany.
