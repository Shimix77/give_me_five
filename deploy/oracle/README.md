# Oracle Cloud nasadenie

Tento priečinok je úplne samostatná vrstva pre online prevádzku. Lokálna macOS verzia zostáva v koreňovom priečinku a naďalej sa spúšťa cez `Give Me Five Editor.app` alebo `start.command`. Obe verzie používajú rovnaký aplikačný kód, aby sa opravy editora nemuseli udržiavať dvakrát, ale majú rozdielne spúšťanie, heslá a pracovné úložisko.

## Odporúčaná Oracle VM

- Ubuntu 24.04 ARM64,
- `VM.Standard.A1.Flex`, 2 OCPU a 12 GB RAM,
- boot volume aspoň 50 GB,
- verejne otvorené iba TCP 80/443 a UDP 443,
- port 4173 sa nesmie otvoriť do internetu.

## Prvé nasadenie

Na VM nainštalujte Docker Engine a Docker Compose plugin podľa aktuálneho oficiálneho návodu pre Ubuntu. Potom:

```bash
git clone https://github.com/Shimix77/give_me_five.git
cd give_me_five
cp deploy/oracle/.env.example deploy/oracle/.env
nano deploy/oracle/.env
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yml config
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yml up -d --build
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yml ps
```

V `.env` nastavte doménu a náhodné heslo s minimálne 32 znakmi. Súbor je ignorovaný Gitom. Caddy po správnom DNS nastavení automaticky získa HTTPS certifikát.

## Oddelenie dát

- uploady, denoise medzisúbory a exporty sú iba v 2 GB dočasnom `tmpfs`; reštart kontajnera ich bezpodmienečne odstráni,
- aplikácia ich navyše maže pri zatvorení/reloadnutí session a po 30 minútach nečinnosti,
- iba AI modely majú vlastný persistentný volume `gmf-models`,
- lokálny adresár `.gmf-work` sa do kontajnera nepripája a cloud k nemu nemá prístup,
- port aplikácie je dostupný len v internej Docker sieti; do internetu komunikuje výhradne Caddy cez HTTPS.
- `Dockerfile.dockerignore` používa prísny allowlist, takže Git história, lokálne modely, `node_modules`, `.gmf-work` ani `.env` nevstupujú do cloudového image alebo build contextu.

## Aktualizácia

```bash
cd give_me_five
git pull --ff-only
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yml up -d --build
```

## Kontrola

```bash
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yml ps
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yml logs --tail=200 editor
docker compose --env-file deploy/oracle/.env -f deploy/oracle/compose.yml logs --tail=100 caddy
```

Po nasadení otestujte neprihlásenú odpoveď 401, upload reálneho MOV, DeepFilter denoise, prepis, presný náhľad, export a vymazanie session. Health endpoint je `/api/health`.
