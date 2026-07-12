# Architektura FenixExelent v3.1

## Warstwy

### `index.js`
Minimalny punkt wejścia aplikacji.

### `src/application.js`
Aktualny moduł integracyjny Discord + HTTP. Kolejny etap refaktoryzacji może rozdzielić go na `commands`, `events`, `dashboard` i moduły funkcjonalne bez zmiany warstwy bazy.

### `src/services/database.js`
Asynchroniczna warstwa PostgreSQL oparta o `pg.Pool`.

- inicjalizuje schemat,
- ładuje konfigurację wszystkich serwerów,
- zapisuje JSONB przez UPSERT,
- kolejkuje zapisy,
- zapisuje audit log,
- migruje stary `config.json`.

### `src/services/logger.js`
Pino z redakcją sekretów oraz metodami do logowania błędów komend i przycisków.

### `src/config/defaultGuildConfig.js`
Domyślna konfiguracja nowego serwera.

## Model danych

`guild_config.config_json` jest typu JSONB. Pozwala zachować zgodność z dotychczasowym modelem konfiguracji, a później stopniowo wydzielać często używane dane do osobnych tabel.

## Następny etap modułowości

```text
src/
  commands/
  events/
  modules/
    verification/
    tickets/
    antispam/
    antiraid/
    antiscam/
    moderation/
  dashboard/
  services/
```

Przenoszenie powinno następować moduł po module, z testami regresji po każdym kroku.
