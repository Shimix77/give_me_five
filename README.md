# Give Me Five Video Editor

Lokálna webová aplikácia pre Google Chrome. Video a audio ostávajú v počítači; natívny FFmpeg vytvára waveformy, denoise aj výsledný MP4.

## Spustenie

1. Dvakrát kliknite na `Give Me Five Editor.app` (odporúčané).
2. Ak macOS aplikáciu neotvorí, použite `start.command`; v jeho okne zostane zobrazená prípadná chyba.
3. Pri prvom spustení počkajte na inštaláciu lokálnych závislostí.
4. Chrome otvorí adresu `http://127.0.0.1:4173`.

Samotný súbor `give_me_five.html` lokálny engine nespustí. Ak ho otvoríte priamo, editor zobrazí pokyn na spustenie aplikácie a po zapnutí servera sa automaticky znovu pripojí.

## Pracovný postup

1. Vložte portrétové MOV/MP4 do 60 sekúnd.
2. V kompaktnom pracovnom priestore sú stopa videa A1 a hudba A2 priamo pod sebou. Na farebnom waveforme nastavte trim, začiatok reči, koniec „Give Me Five“, začiatok druhej reči a koniec hovoreného slova.
   - Rýchla kontrola značiek prejde všetkých šesť bodov v poradí. Každý bod môžete jednorazovo vypočuť a doladiť o 0,1 s.
3. AI denoise (DeepFilterNet3) vyčistí súvislo celý pôvodný zvuk. Silu, odrezanie vetra a jemnú prítomnosť hlasu môžete doladiť a overiť skutočným A/B náhľadom. Vyčistená stopa sa ukladá do lokálnej cache a rovnaká verzia sa použije v exporte.
4. Rezátkom rozdeľte pôvodné audio. Každý segment má vlastnú hlasitosť a absolútne stíšenie.
5. V pravom Inspectore nastavte samostatný zoom/polohu segmentu a globálne farby, teplotu, intenzitu či ostrosť. Slidery farieb majú aj celočíselný vstup.
6. Voliteľne vložte licencované MP3/WAV/M4A. Editor analyzuje celú skladbu, odporučí tri dropy, zobrazí BPM/beat mriežku a umožní zoom 1–32×.
7. Informačný slovenský prepis vytvára fine-tuned Whisper Large v3 Turbo trénovaný na slovenskej reči. Pri prvom použití sa stiahne model; ďalšie prepisy ho používajú z počítača.
8. Tlačidlo **Prehrať mix** prehráva priebežne aktuálny finálny zvuk: rovnaký DeepFilterNet3 hlas ako export, hudbu s automatickým stíšením, whoosh +5 dB a záverečný fade. Úseky **Úvod**, **Počas reči**, **Drop** a **Záver** sa prehrajú raz. Aktívna hudobná úroveň sa zvýrazní a každý režim má vlastné tlačidlo ▶.
9. Zvoľte **Celé**, skontrolujte video od začiatku až po dve sekundy čierneho obrazu a exportujte MP4.

Tlačidlá **Späť** a **Vpred** alebo skratky `⌘/Ctrl+Z` a `⇧⌘/Ctrl+Z` vracajú a obnovujú posledných 80 úprav. Tlačidlo **? Návod** kedykoľvek otvorí stručný postup.

10. Ak chcete zefektívniť ďalší workflow, v spodnom paneli otvorte **Diagnostika workflow · export logu** a stiahnite anonymný JSON report. Obsahuje poradie krokov, časy, opakované nastavenia, blokované exporty a automatické návrhy na zjednodušenie. Neobsahuje médiá, prepis, názvy súborov ani lokálne cesty.

Predvolený hudobný podmaz je počas reči o 14 dB tichší. Bežne dobre funguje rozdiel 12–18 dB; manuálne posunutie ovládačov má vždy prednosť.
Predvolená hlasitosť hovoreného slova je **+8 dB**. Náhľady jednotlivých úsekov sa prehrávajú raz; automatické opakovanie je vypnuté.

## Výstup

- H.264 video a AAC audio v MP4
- pôvodné rozlíšenie a FPS zdrojového videa
- svetelný prechod 0,5–4 s s priloženým fast-whoosh efektom
- 2-sekundový plynulo silnejúci blur/fade, ďalšie 2 sekundy čistého čierneho obrazu a hudba doznievajúca až do konca

AI denoise používa lokálny DeepFilterNet3. Pribalený nástroj beží bez odosielania zvuku na internet; licenčné informácie sú v `THIRD_PARTY_NOTICES.md`. RNNoise zostáva pomocným predčistením pre lokálny prepis.
