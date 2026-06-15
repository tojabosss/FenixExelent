FenixExelentSecurity - poprawka logo

Problem:
Screen pokazuje stronę główną, a tam logo było w pliku index.html jako:
Fenix + Exelent bez Security.

Poprawka:
- index.html ma już logo: FenixExelentSecurity
- Security jest niebieskie
- przygotowany jest też skrypt PowerShell fix_logo_security.ps1

Jak użyć:
1. Najpewniej podmień plik:
   dashboard/public/index.html
   na index.html z ZIP-a.

ALBO:
1. Wrzuć fix_logo_security.ps1 do głównego folderu projektu.
2. Uruchom w PowerShell:
   .\fix_logo_security.ps1

Potem:
git add .
git commit -m "Add Security to logo"
git push

Na Render:
Manual Deploy / Redeploy

Na stronie:
Ctrl + F5
