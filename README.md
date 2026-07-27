# Give Me Five Video Editor

Lokálna webová aplikácia pre Google Chrome. Video a audio ostávajú v počítači; natívny FFmpeg vytvára waveformy, spektrogramy, denoise aj výsledný MP4.

## Spustenie

1. Dvakrát kliknite na `Give Me Five Editor.app` (odporúčané).
2. Ak macOS aplikáciu neotvorí, použite `start.command`; v jeho okne zostane zobrazená prípadná chyba.
3. Pri prvom spustení počkajte na inštaláciu lokálnych závislostí.
4. Chrome otvorí adresu `http://127.0.0.1:4173`.

Samotný súbor `give_me_five.html` lokálny engine nespustí. Ak ho otvoríte priamo, editor zobrazí pokyn na spustenie aplikácie a po zapnutí servera sa automaticky znovu pripojí.

## Pracovný postup

1. Vložte portrétové MOV/MP4 do 60 sekúnd.
2. Na farebnom waveforme alebo spektrograme nastavte trim, začiatok reči, koniec „Give Me Five“, začiatok druhej reči a koniec hovoreného slova.
3. Rezátkom rozdeľte pôvodné audio. Každý segment má vlastnú hlasitosť, absolútne stíšenie a denoise.
4. Voliteľne vložte licencované MP3/WAV/M4A a nastavte drop skladby. Editor ho zarovná na začiatok druhej časti reči.
5. Skontrolujte synchronizovaný náhľad a exportujte MP4.

Predvolený hudobný podmaz je počas reči o 14 dB tichší. Bežne dobre funguje rozdiel 12–18 dB; manuálne posunutie ovládačov má vždy prednosť.

## Výstup

- H.264 video a AAC audio v MP4
- pôvodné rozlíšenie a FPS zdrojového videa
- svetelný prechod 0,5–4 s s priloženým fast-whoosh efektom
- 3-sekundový blur/fade do čierna a stíšenie hudby na konci
