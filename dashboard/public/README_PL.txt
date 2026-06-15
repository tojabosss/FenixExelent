FenixExelentSecurity - poprawiony dashboard.html

Co było źle:
1. Do pliku dashboard.html został wklejony cały skrypt Pythona:
   from pathlib import Path
   dashboard_html = r'''...
   Dlatego ten tekst wyświetlał się w lewym górnym rogu strony.

2. Do HTML był też doklejony backend_patch.
   Kod app.get(...) i app.post(...) NIE może być w dashboard.html.
   Ten kod należy wkleić do index.js wewnątrz function startDashboard().

3. Logo było łamane i miało złe kolory przez CSS:
   .brand span { color: var(--gold) }

Poprawiono:
- usunięto cały wrapper Pythona z dashboard.html
- usunięto backend_patch z dashboard.html
- dodano osobny plik indexjs-dashboard-backend-patch.js
- poprawiono logo na jedną linię: FenixExelentSecurity
- Fenix = biały, Exelent = złoty, Security = niebieski

Jak użyć:
1. Podmień:
   dashboard/public/dashboard.html
   na plik dashboard.html z ZIP-a.

2. Pliku indexjs-dashboard-backend-patch.js NIE wrzucaj do public.
   To tylko instrukcja/patch do index.js.

3. Potem:
   git add .
   git commit -m "Clean dashboard html and fix logo"
   git push

4. Na Render:
   Manual Deploy / Redeploy

5. W przeglądarce:
   Ctrl + F5
