# Oracle Cloud Always Free – plná verzia

Lokálna macOS verzia zostáva nezmenená a naďalej sa spúšťa cez `Give Me Five Editor.app` alebo `start.command`. Súbory `Dockerfile.oracle` a `docker-compose.oracle.yml` sú samostatný Linux ARM64 variant pre Oracle Ampere A1.

## Čo budete potrebovať

- Oracle Cloud VM tvaru `VM.Standard.A1.Flex` s Ubuntu 24.04 ARM64,
- odporúčané 2 OCPU a 12 GB RAM,
- aspoň 50 GB boot volume,
- doménu alebo subdoménu smerujúcu na verejnú IP VM,
- otvorené TCP porty 80 a 443 v Oracle Security Liste/NSG; port 4173 sa verejne neotvára.

Oracle Always Free poskytuje Ampere A1 kapacitu v rámci mesačného bezplatného limitu. Dostupnosť konkrétneho tvaru sa môže v domovskom regióne meniť.

## Prvé nasadenie

Na VM nainštalujte Docker Engine a Docker Compose plugin podľa aktuálneho oficiálneho návodu pre Ubuntu. Potom:

```bash
git clone https://github.com/Shimix77/give_me_five.git
cd give_me_five
cp .env.oracle.example .env.oracle
nano .env.oracle
docker compose --env-file .env.oracle -f docker-compose.oracle.yml up -d --build
docker compose --env-file .env.oracle -f docker-compose.oracle.yml ps
```

V `.env.oracle` nastavte svoju doménu a dlhé jedinečné heslo. Caddy po správnom DNS nastavení automaticky získa a obnovuje HTTPS certifikát. Editor je verejne dostupný iba cez porty 80/443 a pred zobrazením vyžiada Basic Auth.

Prvý prepis môže trvať dlhšie, pretože sa do volume `gmf-data` jednorazovo stiahne približne 1,3 GB model. Model v tomto volume zostane aj po reštarte kontajnera. Uploady, denoise cache a exporty sa mažú po zatvorení alebo reloadnutí session; záložné čistenie odstráni opustenú session po 30 minútach.

## Aktualizácia z GitHubu

```bash
cd give_me_five
git pull --ff-only
docker compose --env-file .env.oracle -f docker-compose.oracle.yml up -d --build
```

## Kontrola a logy

```bash
docker compose --env-file .env.oracle -f docker-compose.oracle.yml ps
docker compose --env-file .env.oracle -f docker-compose.oracle.yml logs --tail=200 editor
docker compose --env-file .env.oracle -f docker-compose.oracle.yml logs --tail=100 caddy
```

Health check aplikácie je `/api/health`. V poriadku sú hodnoty `ffmpeg`, `ffprobe`, `whoosh` a `deepfilter` nastavené na `true`.

## Bezpečnostné vlastnosti

- Linux ARM64 DeepFilterNet 0.5.6 sa sťahuje iba pri builde a overuje SHA-256 `14e02a1c0028f3ca0bdf83b62b3336e56ba0556894ef295a95e8573f06557166`.
- Aplikačný kontajner beží ako používateľ bez root oprávnení, s read-only root filesystemom, bez Linux capabilities a s `no-new-privileges`.
- Caddy ukončuje HTTPS a do aplikačnej siete neposiela port 4173 na verejné rozhranie.
- Heslo patrí iba do `.env.oracle`, ktorý je ignorovaný Gitom.
- Dáta editora sú dočasné; trvalo zostáva iba cache AI modelu a technické dáta Caddy certifikátu.

Pred prvým ostrým použitím vykonajte checklist v `SECURITY.md` a otestujte upload, denoise, presný náhľad, export aj automatické vymazanie session.

