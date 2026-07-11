FenixExelentSecurity v2.2 — Discord.js cleanup + Steam reaction roles + gaming language selection

NAPRAWIONE:
- ephemeral: true -> flags: MessageFlags.Ephemeral
- ready -> clientReady
- RoleManager#create color -> colors.primaryColor
- zachowane role Steam przez reakcje
- wybór języka działa również na gaming serwerze 1462330169669980244

KOMENDY TEKSTOWE:
!role setup          - tworzy panel ról Steam
!role status         - status panelu ról
!role off            - wyłącza reakcje
!language setup      - tworzy role/kanały i panel języków
!language panel      - wysyła ponownie panel
!language status     - status wyboru języka
!language off        - wyłącza wybór języka

RENDER ENVIRONMENT:
GAMING_SETUP_GUILD_ID=1462330169669980244
AUTO_TRANSLATE_ENABLED=false

Bot potrzebuje: Manage Roles, Manage Channels, Add Reactions, Read Message History, Send Messages, Embed Links.
Rola bota musi być wyżej niż role tworzone/nadawane przez bota.
