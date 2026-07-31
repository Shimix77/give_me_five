# Bezpečnosť a nasadenie

Stav auditu: 31. júl 2026

## Zamýšľaný režim

Aktuálna ochrana je navrhnutá pre súkromný editor jedného používateľa alebo malej skupiny, ktorá pozná spoločné prístupové heslo. Nie je to viacpoužívateľská služba s účtami, rolami, kvótami a oddeleným trvalým úložiskom.

## Zapracované ochrany

- Verejne bindovaný server sa bez `GMF_ACCESS_KEY` s minimálne 20 znakmi nespustí.
- Basic Auth sa porovnáva konštantným časom a neúspešné pokusy majú limit.
- Server používa CSP, zákaz iframe, `nosniff`, obmedzené browser permissions, `no-referrer`, HSTS pri nakonfigurovanom HTTPS a `no-store` pre API a citlivé audio.
- CORS pre `null` origin je povolený iba v lokálnom režime.
- Upload má náhodný interný názov a limit; pôvodný názov sa nevracia ani neukladá do aplikačného záznamu.
- Server pred FFmpeg analýzou overí podpis súboru a následne dĺžku, audio/video stream, portrétovú orientáciu, maximálne rozlíšenie a FPS.
- Video môže mať najviac 90 sekúnd, hudba 30 minút a JSON požiadavka 256 kB.
- Analýza, prepis, denoise a export majú súbežné alebo časové limity.
- FFmpeg a DeepFilterNet sa spúšťajú cez pole argumentov bez shellu; používateľský vstup sa nevykonáva ako príkaz.
- Médiá, nedokončené exporty a denoise cache relácie sa mažú po zatvorení, nečinnosti, štarte a korektnom ukončení servera.
- Priame závislosti a Whisper model sú pripnuté na konkrétne verzie/revíziu.
- Runtime je pripnutý na podporovaný Node.js 24 LTS; nepoužíva EOL Node.js 20 ani neohraničený rozsah verzií.
- Session a job endpointy kontrolujú vlastníctvo podľa náhodného identifikátora relácie.
- Server podporuje cloudový `PORT`, `0.0.0.0`, reverznú proxy, verejný health check a `SIGTERM`.

## Zostávajúce riziká a blokery

### Nutné overenie pred verejným nasadením

1. `Dockerfile.oracle` sťahuje pripnutú Linux ARM64 binárku DeepFilterNet3 0.5.6 a kontroluje jej SHA-256. Celý image ešte treba zostaviť a integračne otestovať priamo na Oracle Ampere A1; macOS binárka `tools/deep-filter` sa do image nekopíruje.
2. Slovenský Whisper cache má približne 1,3 GB. Oracle VM potrebuje dostatok RAM aj stále úložisko modelu; odporúčaná konfigurácia je 2 OCPU, 12 GB RAM a boot volume aspoň 50 GB.
3. Compose oddeľuje trvalý modelový cache a dočasné session dáta vo volume `gmf-data`. Pred ostrým použitím treba na VM potvrdiť, že reload, zatvorenie karty a 30-minútová nečinnosť odstránia uploady a exporty, no nie model.

### Vysoké alebo stredné zvyškové riziká

- Basic Auth je jedno spoločné heslo. Je vhodné pre súkromný osobný nástroj, nie pre verejných používateľov. Heslo nastavte ako náhodných aspoň 32 znakov a neposielajte ho v URL ani v repozitári.
- Nahrané médiá spracúva FFmpeg. Limity zmenšujú dosah škodlivého súboru, ale neodstraňujú budúce chyby dekodérov. Závislosti a FFmpeg treba pravidelne aktualizovať a kontrolovať.
- Služba drží session a joby v pamäti. Musí bežať ako jedna inštancia; horizontálne škálovanie by bez spoločného job/session úložiska spôsobilo chyby.
- Pri tvrdom páde procesu nemusí prebehnúť okamžité čistenie. Pri persistentnom disku zvyšky odstráni štart aplikácie a časové čistenie session.
- CSP zatiaľ povoľuje inline CSS, pretože rozhranie používa veľa dynamických štýlov. Inline JavaScript povolený nie je; hlavný skript je autorizovaný SHA-256 hashom.
- Videá v cloude opustia používateľov počítač a budú dočasne uložené na Oracle VM. Pred použitím s osobnými údajmi treba rozhodnúť, kto má k službe prístup a ako sa bude informovať o spracovaní.
- Aplikácia nesťahuje hudbu z YouTube. Používateľ musí vložiť lokálny súbor, ku ktorému má oprávnenie.

### Stav GitHub ochrany

- Secret Protection je zapnuté.
- Push protection pre podporované tajomstvá je zapnuté.
- Dependency graph a Dependabot alerts sú vypnuté, takže GitHub momentálne neposudzuje `pnpm-lock.yaml` a neposiela upozornenia na zraniteľné balíky.
- CodeQL nie je nakonfigurovaný.

## Checklist pred deployom

1. Vytvoriť Oracle Ampere A1 ARM64 VM s odporúčanými 2 OCPU, 12 GB RAM a 50 GB diskom.
2. Zostaviť `Dockerfile.oracle` a overiť Linux DeepFilterNet3, systémový FFmpeg aj slovenský Whisper priamo na tejto VM.
3. Nastaviť doménu, DNS a povoliť iba porty 80/443; port 4173 nezverejňovať.
4. V Oracle Cloud nastaviť `GMF_ACCESS_KEY` ako tajnú premennú a nepoužiť heslo z inej služby.
5. Nastaviť health check na `/api/health`, jednu inštanciu a maximálne jeden súbežný export.
6. Pred každým deployom spustiť syntax/integration testy a aktuálny produkčný dependency audit.
7. Zapnúť GitHub Dependabot alerts a pravidelné aktualizácie závislostí.
8. Po deployi otestovať 401 bez hesla, HTTPS/HSTS, reálny MOV upload, denoise, prepis, náhľad mixu, export a vymazanie dát po zatvorení session.
9. Nezverejňovať aplikáciu bez prístupového hesla ani na dočasné testovanie.

## Odporúčané premenné

- `GMF_ACCESS_KEY`: povinné v cloudovom režime, aspoň 20 znakov; odporúčanie 32+ náhodných znakov.
- `GMF_ACCESS_USER`: voliteľné, predvolené `give-me-five`.
- `GMF_MAX_UPLOAD_MB`: v cloudovom režime predvolené 300.
- `GMF_MAX_RUNNING_ANALYSES`: predvolené 1.
- `GMF_MAX_RUNNING_EXPORTS`: predvolené 1.
- `GMF_MAX_RUNNING_TRANSCRIPTS`: predvolené 1.
- `GMF_PROCESS_TIMEOUT_MS`: predvolené 15 minút.
- `GMF_EXPORT_TIMEOUT_MS`: predvolené 30 minút.
- `GMF_TRANSCRIPT_TIMEOUT_MS`: predvolené 30 minút.
- `GMF_DEEPFILTER_PATH`: cesta k binárke pre platformu.
- `GMF_WORK_DIR`: voliteľné pracovné úložisko; v Oracle compose je `/var/lib/give-me-five`.
- `GMF_FFMPEG_PATH`, `GMF_FFPROBE_PATH`: cesty k systémovým Linux binárkam.
- `GMF_TRUST_PROXY=true`: dôverovať jednej HTTPS reverznej proxy.
- `GMF_HTTPS=true`: zapnúť HSTS pre nasadenie ukončené cez HTTPS.
