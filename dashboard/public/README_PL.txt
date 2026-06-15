FenixExelent - realne statystyki na stronie

Co zmieniono:
- usunięto statyczne wartości typu 1K+, 50K+, <50ms
- strona pobiera teraz dane z endpointu:
  /api/stats
- dane odświeżają się automatycznie co 30 sekund
- aktualizowane są:
  serwery
  użytkownicy
  ping

Ważne:
- Podmień plik index.html w folderze publicznym strony.
- Najczęściej będzie to:
  dashboard/public/index.html
  albo public/index.html

Jeśli w index.js nie masz /api/stats:
- użyj pliku backend_stats_endpoint_patch.js
- wklej go wewnątrz funkcji startDashboard()

Po podmianie:
- restart/redeploy na Render
- w przeglądarce Ctrl + F5

Info techniczne:
Hero stats patch: 1
Stats band patch: 1
