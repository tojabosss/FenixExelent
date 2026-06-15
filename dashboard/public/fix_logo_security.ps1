# FenixExelentSecurity - poprawka logo przez PowerShell
# Uruchom w głównym folderze projektu.

$files = @(
  ".\dashboard\public\index.html",
  ".\dashboard\public\dashboard.html",
  ".\dashboard\public\setup.html",
  ".\dashboard\public\panel.html",
  ".\index.html",
  ".\dashboard.html",
  ".\setup.html",
  ".\panel.html"
)

foreach ($file in $files) {
  if (Test-Path $file) {
    $html = Get-Content $file -Raw -Encoding UTF8

    # Strona główna: logo-text
    $html = $html -replace '<span class="logo-text"><span>Fenix</span><span>Exelent</span></span>', '<span class="logo-text"><span class="logo-fenix">Fenix</span><span class="logo-exelent">Exelent</span><span class="security-word">Security</span></span>'

    # Dashboard / setup: brand/logo
    $html = $html -replace 'Fenix<span>Exelent</span><span class="security-word">Security</span>Security', 'Fenix<span>Exelent</span><span class="security-word">Security</span>'
    $html = $html -replace 'Fenix<span>Exelent</span>(?!<span class="security-word">Security</span>)', 'Fenix<span>Exelent</span><span class="security-word">Security</span>'

    # CSS dla strony głównej
    if ($html -notmatch 'FenixExelentSecurity logo fix') {
      $css = @'
/* FenixExelentSecurity logo fix */
.logo-text .logo-fenix{
  color: var(--text-primary) !important;
}
.logo-text .logo-exelent{
  color: var(--gold) !important;
}
.logo-text span.security-word{
  color: var(--blue-light) !important;
  margin-left: .16em;
}
.security-word{
  color:#60a5fa !important;
  margin-left:4px;
}
'@
      $html = $html -replace '</style>', "$css`n</style>"
    }

    Set-Content $file $html -Encoding UTF8
    Write-Host "✅ Poprawiono logo w: $file" -ForegroundColor Green
  }
}

Write-Host "`nGotowe. Teraz wykonaj:" -ForegroundColor Yellow
Write-Host "git add ."
Write-Host "git commit -m `"Add Security to logo`""
Write-Host "git push"
