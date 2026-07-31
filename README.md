# Give Me Five Video Editor

Webová aplikácia pre Google Chrome. V lokálnom režime video a audio ostávajú v počítači; natívny FFmpeg vytvára waveformy, denoise aj výsledný MP4. Pri budúcom nasadení na Render sa médiá budú cez HTTPS dočasne spracúvať na serveri Renderu.

## Spustenie

1. Dvakrát kliknite na `Give Me Five Editor.app` (odporúčané).
2. Ak macOS aplikáciu neotvorí, použite `start.command`; v jeho okne zostane zobrazená prípadná chyba.
3. Pri prvom spustení počkajte na inštaláciu lokálnych závislostí.
4. Chrome otvorí adresu `http://127.0.0.1:4173`.

Launcher nepotrebuje povolenie na ovládanie Terminálu cez AppleScript. Súbor `start.command` otvorí štandardným macOS spôsobom; ten spustí server, počká na jeho pripravenosť a až potom otvorí Chrome.

## Súkromie a dočasné súbory

Každá karta Chromu používa samostatnú pracovnú session. Nahrané video, hudba, vyčistené audio, analýzy a nedownloadované exporty sa po zatvorení karty automaticky odstránia. Obyčajný reload session zachová. Ak Chrome spadne bez odoslania informácie o zatvorení, záložné čistenie prebehne po 30 minútach bez heartbeat-u.

Pri spustení server odstráni aj dočasné zvyšky z predchádzajúceho procesu. AI model pre slovenský prepis zostáva v cache, aby sa pri každom videu nemusel znovu sťahovať.

Samotný súbor `give_me_five.html` lokálny engine nespustí. Ak ho otvoríte priamo, editor zobrazí pokyn na spustenie aplikácie a po zapnutí servera sa automaticky znovu pripojí.

## Pracovný postup

Editor sa predvolene otvorí ako desaťkrokový sprievodca. V každom kroku zobrazí iba náhľad a ovládače, ktoré práve potrebujete:

1. vloženie portrétového MOV/MP4 do 60 sekúnd a voliteľnej licencovanej hudby,
2. spoločná kontrola všetkých šiestich AI návrhov na jednom waveforme; upravujú sa iba body, ktoré treba,
3. AI denoise celého videa s reálnym A/B náhľadom,
4. ľubovoľné oblasti na waveforme so stíšením 0 až −36 dB alebo úplným tichom,
5. svetelný prechod s fast-whoosh efektom,
6. výber jedného z troch automaticky navrhnutých dropov hudby,
7. spoločný náhľad vyčisteného hlasu a hudby s živým duckingom,
8. jednoduché farebné presety a voliteľné pokročilé farby, ostrosť či zoom,
9. kontrola plynulého blur/fade záveru,
10. prehratie celého aktuálneho strihu a export MP4.

Ak je prestávka medzi „Give Me Five“ a pokračovaním reči dlhšia než zvolený prechod, editor jej stred automaticky odstráni v najjasnejšom bode. Vo vrchole sa približne 0,5 sekundy prekryje záber pred strihom so záberom po strihu pod neutrálnym čisto bielym svetlom. Prechod tak skončí presne pri začiatku druhej reči. Pri kratšej prestávke sa svetelný efekt automaticky skráti, najmenej na 0,5 sekundy.

Tlačidlo **Rozšírený režim** kedykoľvek zobrazí celý editor v jednom pracovnom priestore. Manuálne nastavenia majú vždy prednosť pred automatickými návrhmi.

AI denoise (DeepFilterNet3) vyčistí súvislo celý pôvodný zvuk. Vyčistená stopa sa ukladá do lokálnej cache a rovnaká verzia sa použije v náhľade aj exporte.

Hudobný analyzátor prejde celú skladbu, odporučí tri dropy, zobrazí BPM/beat mriežku a umožní zoom 1–32×. Tlačidlo **Prehrať mix** prehráva aktuálny finálny zvuk: vyčistený hlas, lokálne stíšené miesta, hudbu s automatickým stíšením, whoosh +5 dB aj všetky fade efekty.

Tlačidlá **Späť** a **Vpred** alebo skratky `⌘/Ctrl+Z` a `⇧⌘/Ctrl+Z` vracajú a obnovujú posledných 80 úprav. Tlačidlo **? Návod** kedykoľvek otvorí stručný postup.

Zoom obrazu začína na 100 % a dá sa iba zvyšovať. Poloha X/Y sa počíta ako percento práve dostupného priestoru po zväčšení; krajné hodnoty preto skončia presne na hrane a v náhľade ani exporte nevytvoria čierny okraj.

Ak chcete zefektívniť ďalší workflow, v spodnom paneli otvorte **Diagnostika workflow · export logu** a stiahnite anonymný JSON report. Obsahuje poradie krokov, časy, opakované nastavenia, blokované exporty a automatické návrhy na zjednodušenie. Neobsahuje médiá, prepis, názvy súborov ani lokálne cesty.

Predvolený hudobný podmaz je počas reči o 14 dB tichší. Bežne dobre funguje rozdiel 12–18 dB; manuálne posunutie ovládačov má vždy prednosť.
Predvolená hlasitosť hovoreného slova je **+8 dB**. Náhľady jednotlivých úsekov sa prehrávajú raz; automatické opakovanie je vypnuté.

## Výstup

- H.264 video a AAC audio v MP4
- pôvodné rozlíšenie a FPS zdrojového videa
- svetelný prechod 0,5–4 s s priloženým fast-whoosh efektom
- 2-sekundový plynulo silnejúci blur/fade, ďalšie 2 sekundy čistého čierneho obrazu a hudba doznievajúca až do konca
- počas exportu sa priebežne zobrazuje percento aj uplynutý čas

AI denoise používa lokálny DeepFilterNet3. Pribalený nástroj beží bez odosielania zvuku na internet; licenčné informácie sú v `THIRD_PARTY_NOTICES.md`. RNNoise zostáva pomocným predčistením pre lokálny prepis.

## Render: aktuálny stav

Server už podporuje `PORT`, bindovanie na `0.0.0.0`, bezpečnostné hlavičky, serverové overovanie uploadov, časové a súbežné limity, vyčistenie dočasných médií a korektné ukončenie pri reštarte. Na Renderi sa bez premennej `GMF_ACCESS_KEY` s minimálne 20 znakmi úmyselne nespustí. Prihlásenie používa meno `give-me-five` a hodnotu tejto premennej ako heslo.

Plnú verziu zatiaľ nenasadzujte na bezplatný plán. Bezplatná inštancia má len 512 MB RAM a 0,1 CPU, zatiaľ čo slovenský Whisper model má v lokálnej cache približne 1,3 GB ešte pred započítaním Node.js a samotnej inferencie. Pribalený `tools/deep-filter` je navyše macOS ARM binárka, nie Linux binárka pre Render. Bezplatný filesystem je dočasný, takže model by sa po uspávaní alebo novom deployi sťahoval znova.

Pred vytvorením `render.yaml` je preto potrebné zvoliť jednu z možností:

1. bezplatný „light“ variant bez lokálneho Whisper prepisu a bez DeepFilterNet3,
2. plný variant s Linux DeepFilterNet3 binárkou a platenou inštanciou s dostatočnou RAM, ideálne 4 GB.

Podrobný audit a deployment checklist sú v [SECURITY.md](SECURITY.md).
