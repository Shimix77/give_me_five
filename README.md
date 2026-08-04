# Give Me Five Video Editor

Lokálna webová aplikácia pre Google Chrome. Video a audio zostávajú v počítači; natívny FFmpeg vytvára waveformy, AI denoise, presný náhľad aj výsledný MP4.

## Spustenie

1. Dvakrát kliknite na `Give Me Five Editor.app` (odporúčané).
2. Ak macOS aplikáciu neotvorí, použite `start.command`; v jeho okne zostane zobrazená prípadná chyba.
3. Pri prvom spustení počkajte na inštaláciu lokálnych závislostí.
4. Chrome otvorí adresu `http://127.0.0.1:4173`.

Launcher nepotrebuje povolenie na ovládanie Terminálu cez AppleScript. Súbor `start.command` otvorí štandardným macOS spôsobom; ten spustí server, počká na jeho pripravenosť a až potom otvorí Chrome.

Pri každom spustení sa porovná verzia projektu s verziou už bežiaceho lokálneho enginu. Ak po aktualizácii zostal otvorený starší server, launcher ho bezpečne ukončí a spustí aktuálny. Server zároveň posiela presne tú istú HTML verziu, ku ktorej vytvoril bezpečnostný CSP podpis, takže Chrome po aktualizácii nezablokuje uploadové tlačidlá.

## Súkromie a dočasné súbory

Každé načítanie editora vytvorí novú pracovnú session. Nahrané video, hudba, vyčistené audio, analýzy a nedownloadované exporty sa po zatvorení karty automaticky odstránia. Aj obyčajný reload začne odznova a pôvodné nastavenia neobnoví. Ak Chrome spadne bez odoslania informácie o zatvorení, záložné čistenie prebehne po 30 minútach bez heartbeat-u.

Pri spustení server odstráni aj dočasné zvyšky z predchádzajúceho procesu. AI model pre slovenský prepis zostáva v cache, aby sa pri každom videu nemusel znovu sťahovať.

Samotný súbor `give_me_five.html` lokálny engine nespustí. Ak ho otvoríte priamo, editor zobrazí pokyn na spustenie aplikácie a po zapnutí servera sa automaticky znovu pripojí.

## Pracovný postup

Editor sa otvorí iba ako krokový sprievodca. V každom kroku zobrazí náhľad a ovládače, ktoré práve potrebujete:

1. vloženie portrétového MOV/MP4 do 90 sekúnd, voľba stáleho alebo dynamického detailu a vloženie licencovanej hudby; bez hudby možno pokračovať nenápadnou samostatnou voľbou. Prvý záber zostane viditeľný pod tmavou vrstvou s percentami a aktuálnou činnosťou, prehrávanie sa odomkne až po dokončení presného náhľadu,
2. AI denoise celého videa s automatickým návrhom parametrov a reálnym A/B náhľadom na spoľahlivo rozpoznanej hovorenej vete,
3. spoločná kontrola všetkých markerov na jednom waveforme; reč sa hľadá až vo vyčistenej stope a začiatok obrazu sa navrhne približne 0,3 sekundy pred vizuálnym vstupom človeka,
4. ľubovoľné oblasti na waveforme so stíšením 0 až −36 dB alebo úplným tichom,
5. svetelný prechod s fast-whoosh efektom,
6. hudba, tri automaticky navrhnuté dropy, hlasitosť úvodu/podmazu/záveru a spoločný náhľad finálneho mixu v jednom kroku,
7. jednoduché farebné presety a rozbaliteľné pokročilé farby, ostrosť či zoom,
8. nastavenie obrazu po reči, blur/fade, čistého čierneho záveru a priamy export MP4. Náhľad ostáva počas úprav stále vľavo, preto sa na konci neopakuje ako samostatný krok.

Ak je prestávka medzi „Give Me Five“ a pokračovaním reči dlhšia než zvolený prechod, editor jej stred automaticky odstráni vo svetelnom vrchole. Predvolený prechod má 1 sekundu a podľa referencie z `18_A_davinci.mov` používa skutočný additive dissolve: záber pred strihom a záber po strihu sa v RGB kanáloch postupne sčítajú, vo vrchole sú oba na plnej sile a potom prvý plynulo zmizne. Farby tak zostanú sýte a najjasnejšie miesta sa krátko prepália; nejde o obyčajnú polopriehľadnú bielu vrstvu. Whoosh aj drop hudby vrcholia v rovnakom bode. Po skončení svetla zostane 0,1 sekundy priestoru a potom začne druhá reč. Pri kratšej prestávke sa efekt automaticky skráti, najmenej na 0,5 sekundy.

Prvá manuálna zmena ktoréhokoľvek markeru prepne všetky markery do manuálneho režimu. AI ich už následne neposúva, takže ručné doladenie zostane zachované.

AI denoise (DeepFilterNet3) vyčistí súvislo celý pôvodný zvuk. Aplikácia z hlučnosti, nízkofrekvenčného vetra a aktivity reči navrhne silu čistenia, dolnú hranicu aj jemné zvýraznenie hlasu. Po oddelení hlasu pridá miernu kompresiu, ktorá vyrovná hovorené slovo podobne ako automatické „studio voice“ nástroje. Vyčistená stopa sa ukladá do cache aktuálnej session a rovnaký reťazec sa použije v náhľade aj exporte. Klikateľné informačné tlačidlá pri parametroch vysvetľujú, čo zmeniť pri kovovom, tlmenom alebo stále hlučnom hlase.

Hudobný analyzátor prejde celú skladbu, odporučí tri dropy, zobrazí BPM/beat mriežku a umožní zoom 1–32×. Tlačidlo **Prehrať mix** prehráva aktuálny finálny zvuk: vyčistený hlas, lokálne stíšené miesta, hudbu s automatickým stíšením, whoosh +5 dB aj všetky fade efekty.

Tlačidlá **Späť** a **Vpred** alebo skratky `⌘/Ctrl+Z` a `⇧⌘/Ctrl+Z` vracajú a obnovujú posledných 80 úprav. Tlačidlo **? Návod** kedykoľvek otvorí stručný postup.

Predvolený preset **Živé farby** sa použije už v prvom presnom náhľade aj pri rýchlom exporte; v kroku farieb ho možno zmeniť na neutrálny alebo doladiť. Zoom a poloha sa pre každé video automaticky navrhnú podľa stabilne rozpoznanej tváre a postavy. **Stály detail** používa rovnaké priblíženie celý čas. **Dynamický záber** začne na 100 %, pri začiatku prvej reči urobí 0,4-sekundový zoom-blur, detail drží počas hovoreného slova a po posledných slovách sa za 0,3 sekundy oddiali. Rozmazaná motion vrstva sa primieša iba počas týchto dvoch krátkych prechodov; ostatné snímky zostávajú úplne ostré. Obe dĺžky možno neskôr upraviť. Ak detekcia nie je dostatočne istá, aplikácia nepribližuje, ponechá 100 % a viditeľne na to upozorní. Automatický zoom možno iba zvyšovať. Poloha X/Y sa počíta ako percento práve dostupného priestoru po zväčšení; krajné hodnoty preto skončia presne na hrane a v náhľade ani exporte nevytvoria čierny okraj. Výstupné rozlíšenie a FPS sa nemenia.

Ak chcete zefektívniť ďalší workflow, v spodnom paneli otvorte **Diagnostika workflow · export logu** a stiahnite anonymný JSON report. Obsahuje poradie krokov, časy, opakované nastavenia, blokované exporty a automatické návrhy na zjednodušenie. Neobsahuje médiá, prepis, názvy súborov ani lokálne cesty.

Predvolený hudobný podmaz je počas reči o 17 dB tichší a hlavná korekcia hlasu začína na +8 dB. Bežne dobre funguje rozdiel 12–18 dB; manuálne posunutie ovládačov má vždy prednosť.
Výsledný mix sa predvolene cieli na **−11 LUFS** – profil „Hlasnejšie +5“, ktorý je približne o 5 LU hlasnejší než −16 LUFS profil. Jemná kompresia a bezpečnostný limiter s −2,2 dB true-peak rezervou zabránia aj AAC medzivzorkovému klipovaniu bez zbytočného stíšenia hlasného profilu; aplikácia po renderi urobí druhý normalizačný priechod a pri náhľade ukáže skutočne nameranú hodnotu. Voliteľne možno zvoliť −14 alebo −16 LUFS a korekciu hlasu ±12 dB. Náhľady jednotlivých úsekov sa prehrávajú raz; automatické opakovanie je vypnuté.

## Výstup

- H.264 video a AAC audio v MP4
- pôvodné rozlíšenie a FPS zdrojového videa
- predvolene 1-sekundový referenčný svetelný prechod (voliteľne 0,5–4 s) s priloženým fast-whoosh efektom
- predvolene 4 sekundy obrazu po reči, 2-sekundový plynulo silnejúci blur/fade a ďalšie 2 sekundy čistého čierneho obrazu; všetky tri hodnoty možno zmeniť a hudba doznieva až do konca
- cieľová finálna hlasitosť −11 LUFS (voliteľne −14/−16 LUFS), nameraná hodnota sa zobrazí po renderi
- počas exportu sa priebežne zobrazuje percento aj uplynutý čas

AI denoise používa lokálny DeepFilterNet3. Pribalený nástroj beží bez odosielania zvuku na internet; licenčné informácie sú v `THIRD_PARTY_NOTICES.md`. Rovnaký DeepFilter výstup sa použije aj pred lokálnym slovenským prepisom a určovaním markerov.

Prvý automatický návrh je už plnohodnotný MP4 v pôvodnom rozlíšení a FPS. Tlačidlo **Stiahnuť hotové MP4** použije presne tento súbor, takže export nespúšťa druhý rovnaký render. Počas spracovania Mac zostáva bdelý, zdrojové súbory sú uzamknuté proti náhodnej výmene a render možno bezpečne zrušiť. Po stiahnutí možno priamo z editora otvoriť priečinok Downloads.

Kontrola markerov zobrazuje pri každom bode stav **Spoľahlivé** alebo **Skontrolovať**. Každý bod sa dá prehrať raz od jednej sekundy pred po dve sekundy za markerom; prvá manuálna zmena uzamkne všetkých šesť bodov proti ďalšiemu automatickému posunu. Slovenský frázový model zostáva počas behu aplikácie zahriaty v pamäti. Jeho lokálnu cache možno vedome vymazať v diagnostike, no pri ďalšom videu sa bude musieť znovu stiahnuť.

V prvom kroku sú importy videa, hudby a rozhodnutie „upraviť alebo exportovať“ kompaktne pod sebou vľavo; pravý portrétový prehrávač má výšku týchto troch blokov. Informácia o zarámovaní je nad obrazom, play, časová os a fullscreen pod ním. Kým upload, obrazová analýza, AI denoise/prepis, analýza hudby a presný render pokračujú, video je uzamknuté a na jeho prvom zábere vidno kruhové percentá aj aktuálnu činnosť. Jeden spoločný ukazovateľ zobrazuje uplynutý čas, odhad zostávajúceho času a približný čas dokončenia. Po prijatí FFmpeg progresu sa odhad priebežne spresňuje. Staršiu verziu bežiaceho servera editor rozpozná a namiesto nefunkčného spracovania vypíše presný pokyn na reštart. Základný profil bol zmeraný na kombinácii `18_A.MOV` a `Friend of God - Instrumental with lyrics.mp3`.

Hovorený zvuk z nahratého videa sa v živom náhľade, AI denoise porovnaní aj exporte prevádza na dual-mono stereo: rovnaký hlas ide do ľavého aj pravého kanála. Hudba a whoosh zostávajú v pôvodnom stereo obraze.
