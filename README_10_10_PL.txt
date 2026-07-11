# FenixExelentSecurity 10/10 Update

Zawartość ZIP:
- index.js — główny bot z Public Launch Pack, ServerCheck, Backup, Appeal, Security Ignore i setup wizard.
- deploy-commands.js — rejestracja nowych slash commands.
- package.json — zależności z OCR.
- dashboard/public/dashboard.html — dashboard z sekcją Security Pro.

Nowe komendy:
/privacy, /terms, /about, /support
/servercheck
/securityignore channel|role|removechannel|removerole|list
/backup create|list|restore
/appeal setup|submit|review

Po podmianie plików:
npm install
node --check .\index.js
node .\deploy-commands.js
git add .
git commit -m "Add public launch pack backups appeals and servercheck"
git push origin main

Render: Manual Deploy -> Deploy latest commit
