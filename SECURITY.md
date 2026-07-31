# Bezpečnosť a nasadenie

Stav auditu: 31. júl 2026

## Zamýšľaný režim

Aktuálna ochrana je navrhnutá pre súkromný editor jedného používateľa alebo malej skupiny, ktorá pozná spoločné prístupové heslo. Nie je to viacpoužívateľská služba s účtami, rolami, kvótami a oddeleným trvalým úložiskom.

## Zapracované ochrany

- Render sa bez `GMF_ACCESS_KEY` s minimálne 20 znakmi nespustí.
- Basic Auth sa porovnáva konštantným časom a neúspešné pokusy majú limit.
- Server používa CSP, zákaz iframe, `nosniff`, obmedzené browser permissions, `no-referrer`, HSTS na Renderi a `no-store` pre API a citlivé audio.
- CORS pre `null` origin je povolený iba v lokálnom režime.
- Upload má náhodný interný názov a limit; pôvodný názov sa nevracia ani neukladá do aplikačného záznamu.
- Server pred FFmpeg analýzou overí podpis súboru a následne dĺžku, audio/video stream, portrétovú orientáciu, maximálne rozlíšenie a FPS.
- Video môže mať najviac 60 sekúnd, hudba 30 minút a JSON požiadavka 256 kB.
- Analýza, prepis, denoise a export majú súbežné alebo časové limity.
- FFmpeg a DeepFilterNet sa spúšťajú cez pole argumentov bez shellu; používateľský vstup sa nevykonáva ako príkaz.
- Médiá, nedokončené exporty a denoise cache relácie sa mažú po zatvorení, nečinnosti, štarte a korektnom ukončení servera.
- Priame závislosti a Whisper model sú pripnuté na konkrétne verzie/revíziu.
- Render runtime je pripnutý na podporovaný Node.js 24 LTS; nepoužíva EOL Node.js 20 ani neohraničený rozsah verzií.
- Session a job endpointy kontrolujú vlastníctvo podľa náhodného identifikátora relácie.
- Server podporuje Render `PORT`, `0.0.0.0`, verejný health check a `SIGTERM`.

## Zostávajúce riziká a blokery

### Kritické pred verejným nasadením

1. `tools/deep-filter` je Mach-O ARM64 binárka pre macOS. Na Render Linuxe nebude fungovať. Treba pridať a overiť pripnutú Linux x86_64 verziu DeepFilterNet3 alebo denoise v cloud variante vypnúť.
2. Slovenský Whisper cache má približne 1,3 GB. Free Render s 512 MB RAM ho nespustí. Plný variant potrebuje väčšiu inštanciu; pre bezpečnú rezervu odporúčame 4 GB RAM.
3. Bezplatný Render filesystem je dočasný. Uploady tohto session editora môžu byť dočasné, ale opakované sťahovanie 1,3 GB modelu po uspávaní nie je praktické.

### Vysoké alebo stredné zvyškové riziká

- Basic Auth je jedno spoločné heslo. Je vhodné pre súkromný osobný nástroj, nie pre verejných používateľov. Heslo nastavte ako náhodných aspoň 32 znakov a neposielajte ho v URL ani v repozitári.
- Nahrané médiá spracúva FFmpeg. Limity zmenšujú dosah škodlivého súboru, ale neodstraňujú budúce chyby dekodérov. Závislosti a FFmpeg treba pravidelne aktualizovať a kontrolovať.
- Služba drží session a joby v pamäti. Musí bežať ako jedna inštancia; horizontálne škálovanie by bez spoločného job/session úložiska spôsobilo chyby.
- Pri tvrdom páde procesu nemusí prebehnúť okamžité čistenie. Render ephemeral disk zvyšky odstráni pri výmene inštancie; pri persistentnom disku ich odstráni štart aplikácie.
- CSP zatiaľ povoľuje inline CSS, pretože rozhranie používa veľa dynamických štýlov. Inline JavaScript povolený nie je; hlavný skript je autorizovaný SHA-256 hashom.
- Videá na Renderi opustia používateľov počítač a budú dočasne uložené na infraštruktúre Renderu. Pred použitím s osobnými údajmi treba upraviť text o súkromí a rozhodnúť, kto má k službe prístup.
- Aplikácia nesťahuje hudbu z YouTube. Používateľ musí vložiť lokálny súbor, ku ktorému má oprávnenie.

### Stav GitHub ochrany

- Secret Protection je zapnuté.
- Push protection pre podporované tajomstvá je zapnuté.
- Dependency graph a Dependabot alerts sú vypnuté, takže GitHub momentálne neposudzuje `pnpm-lock.yaml` a neposiela upozornenia na zraniteľné balíky.
- CodeQL nie je nakonfigurovaný.

## Checklist pred deployom

1. Zvoliť `light` alebo plný variant.
2. Pre plný variant pridať overenú Linux DeepFilterNet3 binárku a otestovať ju na Linuxe.
3. Zvoliť RAM podľa variantu; plný Whisper nenasadzovať na Free.
4. V Render Dashboarde nastaviť `GMF_ACCESS_KEY` ako Secret a nepoužiť heslo z inej služby.
5. Nastaviť health check na `/api/health`, jednu inštanciu a maximálne jeden súbežný export.
6. Pred každým deployom spustiť syntax/integration testy a aktuálny produkčný dependency audit.
7. Zapnúť GitHub Dependabot alerts a pravidelné aktualizácie závislostí.
8. Po deployi otestovať 401 bez hesla, HTTPS/HSTS, reálny MOV upload, denoise, prepis, náhľad mixu, export a vymazanie dát po zatvorení session.
9. Nezverejňovať aplikáciu bez prístupového hesla ani na dočasné testovanie.

## Odporúčané premenné

- `GMF_ACCESS_KEY`: povinné na Renderi, aspoň 20 znakov; odporúčanie 32+ náhodných znakov.
- `GMF_ACCESS_USER`: voliteľné, predvolené `give-me-five`.
- `GMF_MAX_UPLOAD_MB`: na Renderi predvolené 300.
- `GMF_MAX_RUNNING_ANALYSES`: predvolené 1.
- `GMF_MAX_RUNNING_EXPORTS`: predvolené 1.
- `GMF_MAX_RUNNING_TRANSCRIPTS`: predvolené 1.
- `GMF_PROCESS_TIMEOUT_MS`: predvolené 15 minút.
- `GMF_EXPORT_TIMEOUT_MS`: predvolené 30 minút.
- `GMF_TRANSCRIPT_TIMEOUT_MS`: predvolené 30 minút.
- `GMF_DEEPFILTER_PATH`: cesta k binárke pre platformu.
- `GMF_WORK_DIR`: voliteľné pracovné úložisko; na Renderi sa inak používa systémový dočasný adresár.
