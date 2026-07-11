FenixExelentSecurity — Support Language Verification

Co dodaje:
- /supportlang setup — tworzy system językowy na support serwerze
- role językowe: Polski, English, Türkçe, Deutsch, Français
- kanały: chat-pl, chat-en, chat-tr, chat-de, chat-fr
- panel weryfikacji z przyciskami językowymi
- kliknięcie języka nadaje rolę językową, rolę Zweryfikowany i usuwa Niezweryfikowany
- działa tylko na serwerze SUPPORT_GUILD_ID
- nie używa tłumaczeń API, więc nie ma limitów LibreTranslate

Render Environment:
SUPPORT_GUILD_ID=ID_TWOJEGO_SUPPORT_SERWERA
AUTO_TRANSLATE_ENABLED=false

Instalacja:
1. Podmień index.js i deploy-commands.js w projekcie.
2. Uruchom:
   node --check .\index.js
   node --check .\deploy-commands.js
   node .\deploy-commands.js
3. Commit i push:
   git add .\index.js .\deploy-commands.js
   git commit -m "Add support language verification"
   git push origin main
4. Render: Manual Deploy -> Deploy latest commit
5. Na Discordzie użyj:
   /supportlang setup

Ważne uprawnienia bota:
- Administrator albo Manage Roles + Manage Channels
- rola bota musi być wyżej niż role, które tworzy/nadaje.
