# Najważniejsze naprawy 3.2

## Aktualizacja: Fenix Secure Verification v4

- zastąpiono natychmiastowe nadawanie roli bezpieczną weryfikacją WWW,
- dodano Discord OAuth2 `identify` i kontrolę zgodności konta,
- dodano obowiązkową walidację Cloudflare Turnstile po stronie serwera,
- dodano hashowane, jednorazowe tokeny z czasem wygaśnięcia i jednorazowym OAuth2 `state`,
- dodano limity prób użytkownika i adresu połączenia,
- dodano audyt prób oraz opcjonalny kanał logów Discord,
- dodano rejestr pluginów metod `web` i `language`,
- zachowano języki PL/EN/TR/DE/FR wyłącznie dla oficjalnego serwera supportu jako drugi etap,
- rozbudowano dashboard o metody, TTL, limity i kanał logów,
- dodano test `npm run verification:check`.

- Aktywny punkt startowy korzysta z najnowszego kodu w `src/application.js`.
- Wszystkie 38 obsługiwanych komend jest wdrażanych z `src/commands.js`.
- Dodano dwustopniową kontrolę uprawnień komend.
- Naprawiono `/risk`, `/securitystats`, AntiAlt, backupy i `/refreshbot`.
- Raporty scam nie znikają już z konfiguracji po restarcie.
- Dashboard działa niezależnie od zdarzenia `clientReady` i ma pełne API.
- Panel otrzymał AntiScam/OCR, AntiAlt, Emergency, backupy, odwołania, wyjątki i moderację.
- Dodano walidację danych, limit rozmiaru JSON, rate limiting, nagłówki bezpieczeństwa i OAuth2 `state`.
- Usunięto przechowywanie tokenu OAuth2 w sesji.
- Link zaproszenia nie żąda już uprawnienia Administrator.
- Dodano trwałe sesje PostgreSQL oraz bezpieczniejsze ciasteczka produkcyjne.
- PostgreSQL jest opcjonalny; lokalnie działa zapis w `data/config.json`.
- Dodano komplet testów `npm test`.
- Zastąpiono marketingowe liczby rzeczywistymi danymi Discord: serwery, członkowie, ping i czas działania.
- Dodano działający wybór 15 języków z automatycznym wykrywaniem, obsługą klawiatury i zapamiętywaniem ustawienia.
- Przywrócono przyciski językowe Discord na serwerze supportu; stary panel odzyskuje role i kanały po restarcie oraz odpowiada bez przekroczenia limitu czasu Discorda.
- Na oficjalnym serwerze supportu wszystkie komendy oraz administracyjne przyciski są dostępne wyłącznie dla właściciela bota i skonfigurowanego Developera; zasady na innych serwerach pozostają bez zmian.
