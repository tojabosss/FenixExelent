# Fenix Secure Verification v4

Moduł odpowiada za bezpieczną weryfikację użytkowników Discord przez łańcuch niezależnych metod.

## Wbudowane metody

- `web` — dostępna na wszystkich serwerach: jednorazowy link, Cloudflare Turnstile, Discord OAuth2 `identify` i kontrola ID konta.
- `language` — dostępna wyłącznie na `SUPPORT_GUILD_ID`: wybór PL/EN/TR/DE/FR po ukończeniu metody `web`.

## Kontrakt pluginu

Plugin jest obiektem rejestrowanym w `PluginRegistry`:

```js
{
  id: 'math',
  label: 'Math Verification',
  description: 'Krótki opis metody.',
  version: '1.0.0',
  officialOnly: false,
  configurable: true,
  async validate({ session, evidence, officialGuild }) {
    return evidence.answer === evidence.expected
      ? { ok: true }
      : { ok: false, code: 'wrong_answer' };
  },
}
```

Identyfikator musi pasować do `^[a-z][a-z0-9_-]{0,31}$`. Plugin nie powinien sam nadawać głównej roli weryfikacyjnej. `VerificationManager` nadaje ją dopiero, gdy wszystkie wymagane metody zakończą się powodzeniem.

## Zasady bezpieczeństwa

- tokeny i OAuth2 `state` są generowane kryptograficznie i przechowywane jako SHA-256,
- token, `state` i odpowiedź Turnstile są jednorazowe,
- surowy token znika po pierwszym przekierowaniu i nie trafia do logów ani trwałej sesji dashboardu,
- OAuth2 musi zwrócić ID użytkownika, który kliknął przycisk Discord,
- Turnstile jest zawsze sprawdzany przez `siteverify` po stronie serwera,
- nieudane i udane etapy trafiają do audytu bez tokenów i sekretów,
- rola bota musi być wyżej niż rola po weryfikacji.

## Konfiguracja

Wymagane zmienne środowiskowe:

```env
CLIENT_ID=
CLIENT_SECRET=
DASHBOARD_URL=https://verify.example.com
VERIFICATION_REDIRECT_URI=https://verify.example.com/verification/callback
TURNSTILE_SITE_KEY=
TURNSTILE_SECRET_KEY=
TURNSTILE_EXPECTED_HOSTNAME=verify.example.com
```

`TURNSTILE_EXPECTED_HOSTNAME` jest opcjonalne, ale zalecane w produkcji.
