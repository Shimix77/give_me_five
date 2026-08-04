# Bezpečnosť lokálnej verzie

Stav auditu: 4. august 2026

## Zamýšľaný režim

Give Me Five Editor je osobný lokálny nástroj. Server počúva iba na `127.0.0.1` a nie je určený na zverejnenie do internetu ani na použitie ako viacpoužívateľská služba.

## Ochrana médií

- Každé načítanie editora vytvorí náhodnú pracovnú session.
- Uploady používajú náhodné interné názvy; pôvodný názov sa používa iba na pomenovanie stiahnutého exportu.
- Server pred spracovaním overuje podpis súboru, typ streamov, portrétovú orientáciu, dĺžku, rozlíšenie a FPS.
- Video môže mať najviac 90 sekúnd a hudba 15 minút.
- FFmpeg a DeepFilterNet dostávajú argumenty ako pole bez spúšťania shell príkazov.
- Video, hudba, denoise cache a nedownloadované exporty sa mažú po zatvorení karty, reloade, 30 minútach nečinnosti, štarte a korektnom ukončení servera.
- AI model zostáva v lokálnej cache, aby sa nemusel znovu sťahovať; diagnostika ponúka jeho vedomé vymazanie.

## Ochrana lokálneho servera

- Server sa viaže na loopback rozhranie a nie je dostupný z lokálnej siete.
- API a citlivé médiá používajú `Cache-Control: no-store`.
- Session a job endpointy kontrolujú vlastníctvo podľa náhodného identifikátora relácie.
- CSP zakazuje neautorizovaný JavaScript, iframe, externé pripojenia a nepotrebné browser permissions.
- Uploady, analýzy, prepis a export majú veľkostné, súbežné a časové limity.

## Zostávajúce riziká

- Nahrané médiá dekóduje FFmpeg. Závislosti a binárky treba pravidelne aktualizovať.
- Pri tvrdom páde procesu nemusí prebehnúť okamžité čistenie. Zvyšky sa odstránia pri ďalšom štarte.
- CSP povoľuje inline CSS, pretože rozhranie používa dynamické štýly. Inline JavaScript povoľuje iba presný SHA-256 hash aktuálneho editora.
- Aplikácia nesťahuje hudbu z YouTube. Používateľ musí vložiť lokálny súbor, ku ktorému má oprávnenie.

## Kontrola pred vydaním

1. Spustiť syntax, unit a integračné testy.
2. Urobiť produkčný audit závislostí.
3. Otestovať reálny MOV upload, denoise, markery, hudobný mix, náhľad a MP4 export.
4. Overiť dual-mono hlas, zachovanie rozlíšenia a FPS a odstránenie session dát.
5. Commitnúť tematický balík do samostatnej vetvy a pushnúť ho na GitHub.
