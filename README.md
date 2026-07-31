# Give Me Five Video Editor

Webová aplikácia pre Google Chrome. V lokálnom režime video a audio ostávajú v počítači; natívny FFmpeg vytvára waveformy, AI denoise, presný náhľad aj výsledný MP4. Cloudová verzia bude používať rovnaký serverový render a médiá spracuje iba dočasne počas otvorenej relácie.

## Spustenie

1. Dvakrát kliknite na `Give Me Five Editor.app` (odporúčané).
2. Ak macOS aplikáciu neotvorí, použite `start.command`; v jeho okne zostane zobrazená prípadná chyba.
3. Pri prvom spustení počkajte na inštaláciu lokálnych závislostí.
4. Chrome otvorí adresu `http://127.0.0.1:4173`.

Launcher nepotrebuje povolenie na ovládanie Terminálu cez AppleScript. Súbor `start.command` otvorí štandardným macOS spôsobom; ten spustí server, počká na jeho pripravenosť a až potom otvorí Chrome.

## Súkromie a dočasné súbory

Každé načítanie editora vytvorí novú pracovnú session. Nahrané video, hudba, vyčistené audio, analýzy a nedownloadované exporty sa po zatvorení karty automaticky odstránia. Aj obyčajný reload začne odznova a pôvodné nastavenia neobnoví. Ak Chrome spadne bez odoslania informácie o zatvorení, záložné čistenie prebehne po 30 minútach bez heartbeat-u.

Pri spustení server odstráni aj dočasné zvyšky z predchádzajúceho procesu. AI model pre slovenský prepis zostáva v cache, aby sa pri každom videu nemusel znovu sťahovať.

Samotný súbor `give_me_five.html` lokálny engine nespustí. Ak ho otvoríte priamo, editor zobrazí pokyn na spustenie aplikácie a po zapnutí servera sa automaticky znovu pripojí.

## Pracovný postup

Editor sa otvorí iba ako krokový sprievodca. V každom kroku zobrazí náhľad a ovládače, ktoré práve potrebujete:

1. vloženie portrétového MOV/MP4 do 90 sekúnd a voliteľnej licencovanej hudby; pôvodné video sa dá prehrať okamžite počas analýzy a od prvej sekundy sa zobrazuje spoločný odhad až do hotového presného náhľadu,
2. AI denoise celého videa s automatickým návrhom parametrov a reálnym A/B náhľadom na spoľahlivo rozpoznanej hovorenej vete,
3. spoločná kontrola všetkých markerov na jednom waveforme; reč sa hľadá až vo vyčistenej stope a začiatok obrazu sa navrhne približne 0,1 sekundy pred vizuálnym vstupom človeka,
4. ľubovoľné oblasti na waveforme so stíšením 0 až −36 dB alebo úplným tichom,
5. svetelný prechod s fast-whoosh efektom,
6. hudba, tri automaticky navrhnuté dropy, hlasitosť úvodu/podmazu/záveru a spoločný náhľad finálneho mixu v jednom kroku,
7. jednoduché farebné presety a rozbaliteľné pokročilé farby, ostrosť či zoom,
8. nastavenie obrazu po reči, blur/fade, čistého čierneho záveru a priamy export MP4. Náhľad ostáva počas úprav stále vľavo, preto sa na konci neopakuje ako samostatný krok.

Ak je prestávka medzi „Give Me Five“ a pokračovaním reči dlhšia než zvolený prechod, editor jej stred automaticky odstráni v najjasnejšom bode. Vo vrchole sa približne 0,5 sekundy prekryje záber pred strihom so záberom po strihu pod neutrálnym čisto bielym svetlom. Prechod tak skončí presne pri začiatku druhej reči. Pri kratšej prestávke sa svetelný efekt automaticky skráti, najmenej na 0,5 sekundy.

Prvá manuálna zmena ktoréhokoľvek markeru prepne všetky markery do manuálneho režimu. AI ich už následne neposúva, takže ručné doladenie zostane zachované.

AI denoise (DeepFilterNet3) vyčistí súvislo celý pôvodný zvuk. Aplikácia z hlučnosti, nízkofrekvenčného vetra a aktivity reči navrhne silu čistenia, dolnú hranicu aj jemné zvýraznenie hlasu. Vyčistená stopa sa ukladá do cache aktuálnej session a rovnaká verzia sa použije v náhľade aj exporte. Klikateľné informačné tlačidlá pri parametroch vysvetľujú, čo zmeniť pri kovovom, tlmenom alebo stále hlučnom hlase.

Hudobný analyzátor prejde celú skladbu, odporučí tri dropy, zobrazí BPM/beat mriežku a umožní zoom 1–32×. Tlačidlo **Prehrať mix** prehráva aktuálny finálny zvuk: vyčistený hlas, lokálne stíšené miesta, hudbu s automatickým stíšením, whoosh +5 dB aj všetky fade efekty.

Tlačidlá **Späť** a **Vpred** alebo skratky `⌘/Ctrl+Z` a `⇧⌘/Ctrl+Z` vracajú a obnovujú posledných 80 úprav. Tlačidlo **? Návod** kedykoľvek otvorí stručný postup.

Predvolený preset **Živé farby** sa použije už v okamžitom náhľade aj pri rýchlom exporte; v kroku farieb ho možno zmeniť na neutrálny alebo doladiť. Zoom a poloha sa pre každé video automaticky navrhnú podľa stabilne rozpoznanej tváre a postavy. Ak detekcia nie je dostatočne istá, aplikácia nepribližuje, ponechá 100 % a viditeľne na to upozorní. Automatický zoom možno iba zvyšovať. Poloha X/Y sa počíta ako percento práve dostupného priestoru po zväčšení; krajné hodnoty preto skončia presne na hrane a v náhľade ani exporte nevytvoria čierny okraj. Výstupné rozlíšenie a FPS sa nemenia.

Ak chcete zefektívniť ďalší workflow, v spodnom paneli otvorte **Diagnostika workflow · export logu** a stiahnite anonymný JSON report. Obsahuje poradie krokov, časy, opakované nastavenia, blokované exporty a automatické návrhy na zjednodušenie. Neobsahuje médiá, prepis, názvy súborov ani lokálne cesty.

Predvolený hudobný podmaz je počas reči o 14 dB tichší. Bežne dobre funguje rozdiel 12–18 dB; manuálne posunutie ovládačov má vždy prednosť.
Výsledný mix sa predvolene cieli na **−11 LUFS** – profil „Hlasnejšie +5“, ktorý je približne o 5 LU hlasnejší než −16 LUFS profil. Jemná kompresia a bezpečnostný limiter zabránia digitálnemu klipovaniu; aplikácia po renderi urobí druhý normalizačný priechod a pri náhľade ukáže skutočne nameranú hodnotu. Voliteľne možno zvoliť −14 alebo −16 LUFS a korekciu hlasu ±12 dB. Náhľady jednotlivých úsekov sa prehrávajú raz; automatické opakovanie je vypnuté.

## Výstup

- H.264 video a AAC audio v MP4
- pôvodné rozlíšenie a FPS zdrojového videa
- svetelný prechod 0,5–4 s s priloženým fast-whoosh efektom
- predvolene 4 sekundy obrazu po reči, 2-sekundový plynulo silnejúci blur/fade a ďalšie 2 sekundy čistého čierneho obrazu; všetky tri hodnoty možno zmeniť a hudba doznieva až do konca
- cieľová finálna hlasitosť −11 LUFS (voliteľne −14/−16 LUFS), nameraná hodnota sa zobrazí po renderi
- počas exportu sa priebežne zobrazuje percento aj uplynutý čas

AI denoise používa lokálny DeepFilterNet3. Pribalený nástroj beží bez odosielania zvuku na internet; licenčné informácie sú v `THIRD_PARTY_NOTICES.md`. Rovnaký DeepFilter výstup sa použije aj pred lokálnym slovenským prepisom a určovaním markerov.

## Cloud: aktuálny stav

Server už podporuje `PORT`, bindovanie na `0.0.0.0`, bezpečnostné hlavičky, serverové overovanie uploadov, časové a súbežné limity, vyčistenie dočasných médií a korektné ukončenie pri reštarte. V cloudovom režime sa bez premennej `GMF_ACCESS_KEY` s minimálne 20 znakmi úmyselne nespustí. Prihlásenie používa meno `give-me-five` a hodnotu tejto premennej ako heslo.

Plnú verziu zatiaľ nenasadzujte z tohto checkoutu priamo na Linux. Slovenský Whisper model má v lokálnej cache približne 1,3 GB ešte pred započítaním Node.js a samotnej inferencie. Pribalený `tools/deep-filter` je navyše macOS ARM binárka, nie Linux binárka. Pre Oracle Cloud zostáva doplniť pripnutý Linux ARM64 DeepFilterNet a kontajnerový deployment; lokálna macOS verzia zostane zachovaná.

Podrobný audit a deployment checklist sú v [SECURITY.md](SECURITY.md).
V prvom kroku sú importy videa a hudby kompaktne pod sebou vľavo a portrétový prehrávač 360 × 640 vpravo. Pôvodný súbor sa v ňom dá prehrať ihneď; upload, obrazová analýza, AI denoise/prepis, analýza hudby a presný render pokračujú na pozadí. Jeden spoločný ukazovateľ od začiatku zobrazuje uplynutý čas, odhad zostávajúceho času a približný čas dokončenia. Po prijatí FFmpeg progresu sa odhad priebežne spresňuje. Staršiu verziu bežiaceho servera editor rozpozná a namiesto nefunkčného spracovania vypíše presný pokyn na reštart. Základný profil bol zmeraný na kombinácii `18_A.MOV` a `Friend of God - Instrumental with lyrics.mp3`.
