# Najważniejsze naprawy 3.2

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
