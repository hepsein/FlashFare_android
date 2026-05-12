# FlashFare — Suivi

> Document vivant. Mis à jour à chaque fin de phase et à chaque décision structurante.
> Dernière mise à jour : **2026-05-10** — passage à la phase Android : ajout `android.md` + `09_planning_android.md`, paradigme dumb-client propagé dans les MD, création `correction_android.md` (changements backend pour `/ride/evaluate`), insertion Phase 8 backend (Admin→9, Sec→10), formalisation des règles projet dans `00_contexte.md`.

---

## 📊 Avancement global

| Phase | Sujet | État | Tests | Commits |
|---|---|:-:|:-:|:-:|
| **0** | Setup (Fastify, Postgres, ESLint, Vitest, migrate) | ✅ | 1/1 | 6 |
| **1** | Auth — inscription landing PII + login email/password + refresh/delete | ✅ | 22/22 | 4 |
| **2** | Remote config + groupes A/B (fallback dev — voir Phase 2b) | ✅ | 10/10 | 3 |
| **2b** | Migration Amplitude (Experiment local eval + Analytics) | ✅ | 5/5 | 7 |
| **3** | Zones IDF (CSV → DB → `GET /zones`) | ✅ | 6/6 | 3 |
| **4** | Ingestion events (`POST /events`) | ✅ | 13/13 | 3 |
| **5** | Proxy ETA Google Maps (`POST /eta`) | ✅ | 10/10 | 3 |
| **6** | Vols **FlightView** — CDG + ORY + **BVA** (LBG → fallback). Fusion ex-Phase 6 (ADP) + ex-Phase 7 (AviationStack BVA) | ✅ | 19/19 | 4 |
| **7** | Agrégation `rides` | ✅ | 12/12 | 4 |
| **8** | `/ride/evaluate` + parser backend (déclenchée par phase Android) | ⬜ | – | – |
| **9** | Admin — édition zones, configs, métriques, `/admin/version` | ⬜ | – | – |
| **10** | Sécu, observabilité, déploiement | ⬜ | – | – |

**Total tests : 98/98 verts** · lint clean · 42+ commits sur `main` poussés sur GitHub.

---

## 📚 Passage docs — préparation phase Android (2026-05-10)

> Aucune modification de code ce jour : passe documentation pour mettre les MD en cohérence avec l'ajout d'`android.md` + `09_planning_android.md` et le shift architectural app dumb / backend cerveau.

- **Nouveau fichier `correction_android.md`** à la racine : spec complète des changements backend nécessaires pour la phase Android (route `POST /ride/evaluate`, migrations `009` / `010` / `011`, endpoint `GET /version/latest`, retrait d'`OFFER_VISIBLE` de `/events`, checklist tâches). Analogue à `correction.md` (qui couvrait Amplitude).
- **Règles projet formalisées dans `00_contexte.md`** § Règles : 14 règles transversales (documentation, architecture, sécurité, process). La règle 1 cadre la séparation **fichiers de définition intemporels** ↔ **`SUIVI.md` seul journal d'évolution**.
- **Propagation du paradigme dumb-client** dans `02_architecture.md` (composants, flux, state machine, endpoints), `03_calcul.md` (calcul backend-side), `04_zones.md` (résolution backend), `05_apis.md` (`/eta` et `/flights/adp` deviennent debug/admin), `06_data.md` (`OFFER_VISIBLE` émis par `/ride/evaluate`, ajout `parser_backend_version`), `07_backend.md` (arbo `src/ride-evaluate.js`, `src/version.js`, migrations 009-011, tableaux endpoints).
- **`08_planning_backend.md` renuméroté** : nouvelle Phase 8 = `/ride/evaluate`, Admin shifté en Phase 9 (avec `POST /admin/version`), Sécu/Déploiement en Phase 10.
- **`GUIDE.md` réécrit timeless** : suppression des sections "Ce qui est déjà fait Phase 0-7" (cela vit ici dans `SUIVI.md`), refonte du parcours chauffeur pour refléter le pipeline `/ride/evaluate`, mention force-update gate et règle dumb-client.
- **Nettoyage marqueurs d'évolution** dans les fichiers de définition : disparition de "5ème catégorie ajoutée", "ajouté plus tard par 008", "ex-Phase 6", "vs 1250 visés initialement", "LBG retiré du payload", etc. — formulation au présent / état actuel.

---

## 🎯 Décisions à valider de ton côté

> Trié par phase. ⚠️ = peut affecter la prod, à trancher avant déploiement.

### Phase 0 — Setup
- **Repo git à `FlashFare/`** (englobe specs MD + dossier `backend/`).
- **`node --env-file=.env` natif** (Node 22), pas `dotenv`. Plus simple.
- **Pattern `buildApp()` factory** dans `src/app.js`, `src/server.js` mince qui appelle `listen`. Permet `app.inject()` en tests.
- **`PORT=3100`** par défaut (collision avec ton Next.js MACOME sur 3000).
- **`docker-compose.yml`** Postgres 16 local avec volume nommé `flashfare_pg_data`.

### Phase 1 — Auth
- **Pivot architectural** : abandon de `/auth/bootstrap` anonyme. Désormais le user **doit** s'inscrire sur la landing page web (`POST /users/register`, PII complète : email, password, nom, prénom, téléphone, adresse) avant de pouvoir se connecter dans l'app mobile (`POST /auth/login`). Justification : on récolte la donnée d'inscription à la source pour le contact / facturation / conformité, et on évite le double flux "anonyme + identifié plus tard".
- **`migrations/008_users_pii.sql`** ajoute les colonnes PII en NULLable pour ne pas casser les rows existantes (test fixtures). Le code applicatif (Zod) garantit qu'aucune INSERT ne laisse de NULL email/password.
- **UNIQUE INDEX case-insensitive** sur `LOWER(email)` (partial pour ignorer les rows legacy sans email). Race-safe via le catch `23505` côté insert.
- **Login timing-constant** : si l'email n'existe pas en DB, on lance quand même `bcrypt.compare` contre un hash factice → temps de réponse identique pour un mot de passe correct ou faux, empêche l'énumération d'emails.
- **Rate-limit IP par route** : 5/h sur `/users/register`, 10/min sur `/auth/login`. Désactivé en `NODE_ENV=test` (toutes les requêtes inject sortent de 127.0.0.1, un cap strict bloquerait la suite).
- **`bcryptjs`** au lieu de `bcrypt` natif (évite node-gyp Windows). Cost 10 pour password + refresh hash.
- **Pré-hash SHA-256 avant bcrypt** sur les refresh tokens uniquement (ils sont des JWT longs > 72 octets — la limite bcrypt). Pas nécessaire pour les passwords (toujours < 72 chars).
- **Refresh token = JWT signé par `JWT_REFRESH_SECRET`** (pattern canonique deux namespaces `@fastify/jwt`). Empreinte bcrypt en DB pour invalidation à la rotation.
- **`app.inject()` Fastify-natif** au lieu de `supertest` HTTP. Sémantiquement équivalent, plus rapide, pas besoin de bind un port.
- **Test DB isolée `flashfare_test`** créée par `tests/globalSetup.js`, migrations appliquées auto. `TRUNCATE` entre tests. `fileParallelism: false` pour éviter les races.
- **Helper partagé `tests/helpers.js`** : `registerAndLogin(app, overrides?)` réutilisé par tous les autres fichiers de tests. Centralise le flux register → login + le format de la fiche valide.

### Phase 2 — Remote config + A/B (solution maison, devenue fallback dev local)
- **⚠️ Migration vers Amplitude (Phase 2b)** : la solution maison reste en place comme fallback dev local. En production, Amplitude Experiment local eval (variant `flashfare-config`) est la source de vérité, Amplitude Analytics récupère les events. Voir `correction.md` à la racine pour la justification.
- **Seed `cfg-2025-04-001` MVP-strict** : `windows_minutes` et `tiers` contiennent **uniquement CDG et ORY** au seed. BVA ajouté via migration `006_add_bva_to_config.sql` (Phase 6). Pas de LBG (FlightView ne couvre pas).
- **ETag = SHA-256 du payload JSON** tronqué à 32 hex chars (pas le `config_version`). Garantit invalidation si l'admin modifie un payload sans bump de version.
- **`invalidateConfigCache(group?)` exporté** prêt pour la Phase 8 admin. Avec Amplitude, le cache per-user est aussi vidé (on ne sait pas quels users sont impactés par un changement de variant).
- **`assignDeviceGroup` exporté** depuis `auth.js`. **Reste utilisé en fallback** quand Amplitude Experiment ne renvoie aucun variant, et permet à la Phase 8 admin de forcer un groupe (`PATCH /admin/users/:id/group` avec `forced=true`) — cet override prime sur Amplitude.

### Phase 2b — Migration Amplitude (Experiment + Analytics)
- **Décision** : remplacer la solution maison de remote config + A/B testing par Amplitude. Justification, fonctionnement complet et flux end-to-end documentés dans `correction.md` à la racine du projet.
- **Deux SDKs** :
  - `@amplitude/experiment-node-server` (local evaluation server-side) — pulle les flag rules au boot, poll Amplitude toutes les 30s en arrière-plan, évaluation par user = lookup mémoire **synchrone ~0ms** (jamais d'appel réseau dans le chemin critique de `/config`).
  - `@amplitude/analytics-node` — fire-and-forget tracking. Mirroire chaque event nouvellement persisté dans `offer_events` vers Amplitude Analytics → dashboards Ahmed (funnels, segmentation par groupe, taux acceptation par verdict).
- **Variables d'env optionnelles** : `AMPLITUDE_API_KEY` (Analytics) et `AMPLITUDE_EXPERIMENT_DEPLOYMENT_KEY` (Experiment, distincte de l'API key). Absentes → `getConfigVariant` retourne `null`, `trackEvent` no-op, fallback DB activé. **Les 81 tests existants passent sans ces vars** (5 tests Amplitude additionnels couvrent explicitement le path fallback).
- **Flag `flashfare-config`** : un seul flag multi-variant (control / test_a / test_b...). Le payload de chaque variant suit le schéma de `remote_configs.payload` (weights, normalization, thresholds, flights...). Ahmed gère tout depuis le dashboard Amplitude — pas de redéploiement.
- **Bootstrap** : `device_group` provient de `variant.key` Amplitude si dispo, sinon `assignDeviceGroup` hash modulo. La row `device_group_assignments` est insérée dans tous les cas (admin override Phase 8).
- **Per-user LRU cache `configByUser`** (max 10 000, TTL 10min) côté backend pour éviter de re-hasher l'ETag à chaque requête `/config` pour le même user. Vidé entièrement à chaque `invalidateConfigCache`.
- **Tracking duplicate-safe** : on n'envoie à Analytics que les events dont `event_id` figure dans le `RETURNING id` de l'INSERT (ON CONFLICT DO NOTHING). Évite le double-comptage sur retry.
- **Tables `remote_configs` + `device_group_assignments` conservées** (cf. correction.md) :
  1. Plan B si Amplitude Experiment indisponible au boot
  2. Source unique en dev local sans secret tiers (les 86 tests tournent dans ce mode)
  3. Support de l'override admin (`forced=true`) qui prime sur Amplitude

### Phase 3 — Zones
- **CSV à 528 CP** (pas 1250 comme indiqué dans le planning). Suffisant pour MVP, sera complété par Ahmed.
- **3 codes postaux aéroport conservés en table** (`93350` Le Bourget, `94310` Orly, `95700` Roissy) avec catégorie `AEROPORT_ADP`. Diverge légèrement de `04_zones.md` qui dit "les aéroports ne sont pas dans cette table". Justification : le client détecte d'abord les aéroports par mot-clé dans l'adresse (Roissy, Orly, etc.) → priorité au scoring dynamique vols. La présence en table sert uniquement de fallback géographique si une adresse résidentielle dans ces CP est détectée.
- **5 catégories** stockées (vs 4 dans `04_zones.md` qui omet `AEROPORT_ADP`). Schéma DB sans CHECK constraint — accepte des catégories libres pour évolutivité.
- **DATABASE_URL en `127.0.0.1`** au lieu de `localhost` : Postgres-js sur Windows résout `localhost` → `::1` (IPv6) qui passe par WSL relay et timeoute. Forçage IPv4 résout. Mis à jour aussi dans `.env.example`, `tests/setup.js`, `tests/globalSetup.js`.
- **ETag = SHA-256(MAX(updated_at) + COUNT(*))** : pas seulement `MAX(updated_at)` car une suppression n'avance pas le max → on ajoute le row count pour invalider.
- **Cache LRU 1 entrée TTL 1h** comme spécifié. `invalidateZonesCache()` exporté pour Phase 8 admin (PATCH zones).
- **`npm run seed`** ajouté aux scripts. Idempotent (UPSERT par `postal_code`), peut être ré-exécuté à volonté.

### Phase 4 — Events
- **Schéma Zod en discriminated union** sur `type` (7 variantes : OFFER_VISIBLE, ACCEPTED, REFUSED, TIMEOUT, TRIP_STARTED, TRIP_ENDED, NEXT_OFFER). Champs communs stricts (UUIDs, timestamp ISO), payloads par type avec `passthrough()` pour absorber les champs futurs sans rejet.
- **Idempotence par `event_id`** via `INSERT ... ON CONFLICT (id) DO NOTHING RETURNING id`. Réponse `{ accepted, duplicates }`.
- **403 si user_id ≠ JWT user_id** sur **n'importe quel** event du batch (all-or-nothing, aucun event inséré). Sécurité contre un device qui forgerait des events au nom d'un autre user.
- **Limite : 500 events par batch · max 1 minute pour 30 batches par user**. Volumétrie réelle attendue : ~30 propositions × 5 events ≈ 150 events/jour/chauffeur, donc 1-2 batches/min en pic. Marge confortable.
- **Rate-limit `keyGenerator` décode le JWT manuellement** (sans vérification de signature, juste pour extraire `user_id`). Raison : `@fastify/rate-limit` s'exécute en `onRequest` (avant l'auth `preHandler`), donc `req.user` n'est pas encore peuplé. Sans ça, en tests `app.inject()`, `req.ip = '127.0.0.1'` partagé entre tous les tests → compteur global et déclenchement faux positif. Le décodage non-vérifié est sans risque sécuritaire ici (seule la clé du bucket est concernée).
- **`offer_events` sans FK vers `users`** (comme spec). Volonté : pouvoir conserver les events d'un user supprimé pour la calibration (à voir avec toi : suppression RGPD = drop user mais garder events anonymisés ? À trancher avant prod).
- **Mapping client → DB** : `event_id` → `id`, `timestamp` → `occurred_at`, autres colonnes 1:1.

### Phase 5 — Proxy ETA Google Maps
- **Cache LRU 60s, 5000 entrées max**, clé = `(lat/lng arrondies au millième ≈ 100m, bucket 5min)`. Critique pour les coûts : 100 chauffeurs × 30 propositions/j sans cache = ~450 USD/mois (Routes Basic). Avec arrondi 100m + bucket 5min, plusieurs chauffeurs aux abords d'une même origine partagent la réponse.
- **Timeout 1500ms via `AbortController`**. Si Google met > 1.5s, on coupe et on retourne `{source: 'fallback', error: 'timeout'}` avec status **504**.
- **Fallback NON mis en cache** : si Google échoue (timeout, 5xx, no route), la réponse fallback n'est pas stockée → la requête suivante retentera Google. Évite de propager une erreur transitoire pendant 60s.
- **Métriques in-memory** : `getEtaMetrics() → { google_maps, fallback, cache_hit }`. Sera exposé via `/admin/metrics` en Phase 8.
- **Rate-limit 60/min/user** (même pattern keyGenerator que `/events` : décodage JWT manuel pour contourner l'ordre `onRequest` < `preHandler`).
- **`process.env.GOOGLE_MAPS_TIER`** lu à l'initialisation (`basic` → `TRAFFIC_UNAWARE`, `advanced` → `TRAFFIC_AWARE`). En dev/test on garde `basic` (5 USD/1000 req vs 10 USD/1000).
- **Mocking en tests** : `vi.stubGlobal('fetch', ...)` permet de simuler Google sans appel réseau. Test du timeout réel via une promesse qui ne résout que sur `signal.addEventListener('abort', ...)` → vérifie le câblage AbortController de bout en bout (1500ms réels).
- **Smoke test live** : la clé fournie retourne **403** sur Routes API → l'API Routes n'est probablement pas activée sur le projet GCP, ou la clé a des restrictions. **Action attendue de ton côté** : activer "Routes API" sur la console GCP du projet associé à la clé. Le code fonctionne (fallback OK), seule la donnée Google est inaccessible pour l'instant.
- **Bug `lat/lng` vs `latitude/longitude`** trouvé grâce au logging détaillé : Routes API rejetait notre payload car attend `{latitude, longitude}` (proto), pas `{lat, lng}`. L'exemple dans `07_backend.md` était faux. Fixé. Live validé : Paris République → CDG = 48 min, 25,4 km.
- **`GOOGLE_MAPS_TIER` passé à `advanced`** (TRAFFIC_AWARE). Sans trafic, le score était irréaliste en heures pleines (38min vs 80min réels). Surcoût ~315 USD/mois pour 100 chauffeurs, mais score crédible.
- **Logging structuré sur fallback** (pino) avec capture du body Google complet (`google_status`, `google_detail` avec `status`, `message`, `fieldViolations`). Permet le diagnostic post-mortem sans redéployer.

### Phase 6 — Vols FlightView (CDG + ORY + BVA)
- **Pivot source** : ADP open-data abandonné (URL/format jamais confirmés). Bascule sur **FlightView** (`https://app-api.flightview.com/api/airport/{IATA}/arrivals`) après benchmark live des 3 vraies APIs JSON publiques :
  - FlightView : 100–400 ms, no auth, JSON propre, couvre CDG/ORY/BVA. **LBG = 404** (Le Bourget pas dans leur catalogue).
  - Skyscanner : bloqué par PerimeterX (CAPTCHA).
  - FlightRadar24 : bloqué (Cloudflare/auth).
- **Schéma `flights_cache`** : inchangé. PK composite `(airport, flight_number, scheduled_at)` → upsert idempotent. Index sur `(airport, scheduled_at)` pour le `getCount`, et sur `fetched_at DESC` pour la vérif freshness. La colonne `source` passe de `'adp'` à `'flightview'`.
- **Parser `parseFlightviewResponse()`** : input = array d'arrivées FlightView. Reconstruit chaque vol :
  - `flight_number` = `airlineCode` + `flightNumber` (ex. `AF1234`)
  - `scheduled_at` = `flightDate` + `scheduledTime` reconstruits en UTC depuis local Europe/Paris (round-trip via `Intl.DateTimeFormat` qui choisit automatiquement +01 ou +02 selon DST). Testé sur cas CEST (mai) et CET (janvier).
  - `estimated_at` = idem avec `updatedTime` si présent
  - `airport_origin` = `airportCode`, `status` = `displayStatus`
  - Records sans `airlineCode`/`flightNumber` ou date malformée → ignorés silencieusement.
- **`refreshFlights(airport)`** : fetch FlightView avec timeout 5s, parse, **upsert avec `effective = estimated_at ?? scheduled_at`** (= heure d'arrivée la plus récente connue). Si un vol est retardé entre 2 refresh, son `scheduled_at` en DB reflète la nouvelle estimation. Trade-off accepté : la PK composite peut créer un doublon si l'estimation bouge de ≥ 1 minute, mais avec un cron 5 min sur ~150 vols/h, le bruit est marginal.
- **`getCount(airport, eta, windowMinutes)`** : inchangé.
- **Route `GET /flights/adp?airport=CDG&eta=ISO`** :
  - Path conservé `/flights/adp` (pas de breaking change client) malgré la nouvelle source
  - Validation Zod : `airport` doit être `CDG`, `ORY` ou `BVA` (LBG → 400, le client tombera sur `flights.fallback_score: 85`)
  - Lit `windows_minutes[airport]` depuis la config du **groupe du user** (fallback control)
  - Si cache vide ou `MAX(fetched_at) > 30 min` → `{source: 'default', window_minutes}`
  - Sinon → `{count, source: 'flightview', window_minutes}`
- **Cron node-cron `*/5 * * * *`** sur CDG + ORY + BVA. Justification du 5 min vs proposition 20 min : à intervalle 20 min un seul échec cron suffit à dépasser le `STALE_THRESHOLD_MS=30min` → fallback ; à 5 min il faut 6 échecs consécutifs. La latence client est la même (lecture DB), seule la fraîcheur change.
- **`startJobs()` appelé uniquement dans `server.js`** → pas de cron pendant les tests.
- **Métriques** `getFlightsMetrics() → { refresh_success, refresh_failure, count_default, count_flightview }`. Phase 8 admin les exposera.
- **Rate-limit 60/min/user** sur la route (pattern keyGenerator JWT-decode inchangé).
- **Migration `006_add_bva_to_config.sql`** : `jsonb_set` ajoute `windows_minutes.BVA = 25` et `tiers.BVA = [...]` au payload de `cfg-2025-04-001`. Idempotent.
- **`ADP_DATASET_URL` retiré de l'env** (et de `env.js` Zod). URL FlightView en dur dans `flights.js` comme l'URL Google Routes dans `eta.js`. `AVIATIONSTACK_API_KEY` aussi retiré (Phase 7 abandonnée).
- **Smoke live validé** (`scripts/smoke-flightview.mjs`) : CDG=124 vols / ORY=84 / BVA=6 en < 500 ms. Conversion TZ correcte sur cas été et hiver.

### Phase 7 — Agrégation `rides`
- **Schéma** : `migrations/007_rides.sql` — PK `offer_id`, 19 colonnes (versioning embarqué : `config_version`/`parser_version`/`app_version`/`device_group`), JSONB pour `ride_offer`/`eta`/`flights`/`score_predicted`. 3 index (`(user_id, occurred_at DESC)`, partial sur `is_complete=true`, `(config_version, decision)`).
- **`aggregateRide(offer_id)` exporté** depuis `events.js` : lit tous les events de l'offer + le NEXT_OFFER pointant vers lui, reconstruit la ligne, fait un upsert. Idempotent par construction (`ON CONFLICT (offer_id) DO UPDATE` qui ré-écrit toutes les colonnes + `updated_at = now()`).
- **Sémantique `is_complete`** : `true` si decision=REFUSED/TIMEOUT, OU si decision=ACCEPTED ET TRIP_ENDED reçu ET NEXT_OFFER reçu (lifecycle complet pour calibration). Le post-ride delay est important pour calculer le vrai taux horaire.
- **Appel synchrone** depuis `POST /events` après chaque event terminal (REFUSED/TIMEOUT/TRIP_ENDED/NEXT_OFFER). Pas de queue : volume cible faible (~quelques events terminaux par minute par user max), et on veut que la ligne `rides` soit visible immédiatement par les outils admin.
- **NEXT_OFFER** : event terminal SPÉCIAL — son propre `offer_id` est celui de la NOUVELLE offer (qui aura sa propre OFFER_VISIBLE plus tard), mais `payload.previous_offer_id` pointe vers l'offer qui se termine. C'est cette PREVIOUS qu'on agrège (pour mettre à jour `next_offer_id` et `delai_avant_next_min`).
- **Erreurs d'agrégation non-bloquantes** : `aggregateRide` qui throw est attrapé et logué (`req.log.warn`) sans faire rater l'INSERT du batch d'events. Les events bruts restent la source de vérité, le rebuild peut tout reconstruire.
- **`scripts/rebuild-rides.js`** :
  - `npm run rebuild-rides` → TRUNCATE `rides` puis re-aggrège tout
  - `npm run rebuild-rides <offer_id>` → rebuild d'une seule ligne
  - **Filtre côté SQL** : ne rebuild que les offers ayant un event terminal (sinon on créerait des lignes que le flux live ne créerait jamais — divergence). Filtrage via UNION sur `type IN (REFUSED, TIMEOUT, TRIP_ENDED)` + `previous_offer_id` extrait des NEXT_OFFER.
- **Live test** : flow complet OFFER_VISIBLE → ACCEPTED → TRIP_STARTED → TRIP_ENDED → NEXT_OFFER → ride avec `decision=ACCEPTED`, `duree_reelle_min=31`, `is_complete=true`, `next_offer_id` + `delai_avant_next_min=7` corrects.

### Stack & dépendances
- ✅ Stack imposée respectée : Node 22, Fastify v5, postgres-js, Zod, lru-cache, node-cron (pas encore utilisé), Vitest.
- ➕ Ajouté hors checklist : `bcryptjs`, `@fastify/helmet`, `@fastify/jwt`, `@fastify/rate-limit` (helmet + rate-limit étaient dans `07_backend.md`).
- ➖ Pas installé bien que dans la checklist : `dotenv` (remplacé par `--env-file` natif Node 22).

### Incohérences MD signalées
- **Numérotation des migrations** : `07_backend.md` liste `001_users, 002_postal_zones, 003_remote_configs, ...`. `08_planning_backend.md` impose un ordre aligné sur les phases : `001_users` (Phase 1), `002_remote_configs` (Phase 2), `003_postal_zones` (Phase 3), etc. → **je suis l'ordre du planning**. Migrations actuelles : `001_users.sql`, `002_remote_configs.sql`.

---

## 📁 Arborescence backend

```
backend/
├── docker-compose.yml          Postgres 16 local
├── package.json                deps + scripts (dev, test, migrate, lint, format)
├── eslint.config.js            flat config + globals + prettier
├── .prettierrc.json
├── .env / .env.example         secrets (32 chars random) + GOOGLE_MAPS_API_KEY
├── vitest.config.js            globalSetup + setup + fileParallelism: false
├── migrations/
│   ├── 001_users.sql               Phase 1 ✅
│   ├── 002_remote_configs.sql      Phase 2 ✅ (+ seed cfg-2025-04-001 control)
│   ├── 003_postal_zones.sql        Phase 3 ✅
│   ├── 004_offer_events.sql        Phase 4 ✅
│   ├── 005_flights_cache.sql       Phase 6 ✅
│   ├── 006_add_bva_to_config.sql   Phase 6 ✅ (jsonb_set BVA windows + tiers)
│   ├── 007_rides.sql               Phase 7 ✅
│   └── 008_users_pii.sql           Phase 1 (révision) ✅ (email + PII + password_hash)
├── scripts/
│   ├── migrate.js                  transactionnel, table _migrations, ordre alpha
│   ├── rebuild-rides.js            re-aggrège la table rides depuis offer_events (Phase 7)
│   └── smoke-flightview.mjs        appel live FlightView CDG/ORY/BVA (debug)
├── src/
│   ├── env.js                  Zod, refus de boot si var manquante
│   ├── db.js                   postgres-js (max 10)
│   ├── app.js                  buildApp() — helmet + rate-limit + JWT × 2 + routes
│   ├── server.js               entry point (appelle buildApp + listen)
│   ├── auth.js                 /users/register, /auth/login, /auth/refresh, /me + assignDeviceGroup
│   ├── config.js               /config + LRU cache + invalidate helper
│   ├── zones.js                /zones + LRU snapshot 1h + invalidate helper
│   ├── events.js               /events + Zod discriminated union + idempotence + aggregateRide + rate-limit user
│   ├── eta.js                  /eta + Google Routes proxy + LRU 60s + 504 fallback + metrics
│   ├── flights.js              /flights/adp + FlightView client + parser TZ-aware + refreshFlights + getCount + metrics
│   ├── amplitude.js            initAmplitude + getConfigVariant (sync mémoire) + trackEvent (fire-and-forget)
│   └── jobs.js                 node-cron 5min × {CDG, ORY, BVA} (lancé via server.js, pas dans buildApp)
├── tests/
│   ├── globalSetup.js          crée flashfare_test + applique migrations
│   ├── setup.js                injecte env vars test-safe
│   ├── helpers.js              registerAndLogin(app, overrides?) — réutilisé partout
│   ├── health.test.js          smoke (1)
│   ├── auth.test.js            register / login / refresh / delete (22)
│   ├── config.test.js          /config + ETag + assignDeviceGroup (10)
│   ├── zones.test.js           /zones + ETag + invalidation (6)
│   ├── events.test.js          /events + idempotence + 403 + rate-limit (13)
│   ├── eta.test.js             /eta + cache + timeout + 504 + Google body (10)
│   ├── flights.test.js         /flights + parser + refresh + getCount + 504/default/adp (19)
│   ├── rides.test.js           aggregateRide live ingestion + rebuild parity (12)
│   └── amplitude.test.js       fallback path : init warnings + null variant + trackEvent no-op + /config DB + /events ingest (5)
└── seeds/
    ├── postal_zones.csv        528 CP IDF (copie de FlashFare_Codes_Postaux_IDF.csv)
    └── seed.js                 parse + upsert (npm run seed)
```

---

## 🗄️ Base de données — état actuel

### Schéma `flashfare` (dev) et `flashfare_test`

| Table | Phase | Lignes (dev) | Description |
|---|:-:|:-:|---|
| `_migrations` | 0 | 8 | Track migrations appliquées |
| `users` | 1 | * | UUID + PII (email/first_name/last_name/phone/address) + password_hash + refresh_token_hash |
| `device_group_assignments` | 2 | * | user_id → control / test_a / test_b |
| `remote_configs` | 2 | 1 | `cfg-2025-04-001` pour `control` (active) |
| `postal_zones` | 3 | 528 | 21 Paris + 121 petite couronne + 383 grande couronne + 3 aéroports |
| `offer_events` | 4 | * | events bruts par proposition (idempotents par `id`) |
| `flights_cache` | 6 | * | vols FlightView CDG/ORY/BVA refresh 5min (PK composite, source/fetched_at) |
| `rides` | 7 | * | 1 ligne par proposition agrégée (PK `offer_id`), is_complete + outcomes |

`*` = volumes variables au gré des bootstraps de test.

---

## 🌐 Endpoints actifs

| Méthode | Route | Auth | Status | Phase |
|---|---|:-:|:-:|:-:|
| GET | `/health` | – | ✅ | 0 |
| POST | `/users/register` | – (rate-limit 5/h/IP) | ✅ landing inscription PII | 1 |
| POST | `/auth/login` | – (rate-limit 10/min/IP) | ✅ login email+password | 1 |
| POST | `/auth/refresh` | – | ✅ | 1 |
| DELETE | `/me` | JWT | ✅ supprime PII | 1 |
| GET | `/config` | JWT | ✅ ETag/304 | 2 |
| GET | `/zones` | JWT | ✅ ETag/304 | 3 |
| POST | `/events` | JWT | ✅ idempotent + rate-limit 30/min/user + agrégation `rides` synchrone | 4+7 |
| POST | `/eta` | JWT | ✅ cache 60s + 504 fallback + rate-limit 60/min/user | 5 |
| GET | `/flights/adp` | JWT | ✅ CDG/ORY/BVA, source=`flightview`, default si stale/empty | 6 |
| `/admin/*` | – | X-Admin-Token | ⬜ | 8 |

---

## 🧪 Tests

```
$ npm test
 ✓ tests/health.test.js  (1 test)
 ✓ tests/auth.test.js    (22 tests)
 ✓ tests/config.test.js  (10 tests)
 ✓ tests/zones.test.js   (6 tests)
 ✓ tests/events.test.js  (13 tests)
 ✓ tests/eta.test.js     (10 tests)
 ✓ tests/flights.test.js (19 tests)
 ✓ tests/rides.test.js   (12 tests)
 ✓ tests/amplitude.test.js (5 tests)

 Test Files  9 passed (9)
      Tests  98 passed (98)
```

Couverture par sujet :
- **Health** : 200 + body
- **Auth** : register (succès avec PII, 409 duplicate email case-insensitive, 6 cas 400 invalid body, missing field), login (succès, case-insensitive email, wrong password 401, unknown email 401, missing body 400), refresh (rotation, single-use, bogus token, body invalide), delete /me (401 sans JWT, 401 JWT invalide, suppression DB avec PII), flow E2E register→login→refresh→delete
- **Config** : 401 sans JWT, payload control attendu (vérifie absence LBG/BVA), ETag → 304, ETag obsolète → 200, routing per-group (test_a → cfg-test-a-001), 404 si groupe sans config
- **Hash A/B** : groupe valide retourné, déterministe, distribution ~33% sur 3000 IDs
- **Bootstrap intégration** : assignment row insérée, config_version réel pour control / null pour test_a/test_b
- **Zones** : 401 sans JWT, snapshot 528 lignes avec ETag, ETag → 304, ETag obsolète → 200, 4 catégories canoniques présentes, ETag change après UPDATE
- **Events** : 401 sans JWT, OFFER_VISIBLE valide accepté, batch multi-types (OFFER_VISIBLE+REFUSED+TRIP_ENDED), idempotence event_id, batch partiellement dupliqué (1 nouveau + 1 doublon), 403 user_id étranger, 403 batch hybride (all-or-nothing), 400 sur required field manquant / type inconnu / timestamp invalide / events array vide / ingestion_batch manquant, rate-limit 30/min/user déclenche au 31ème
- **ETA** : 401 sans JWT, 400 body invalide (destination manquante / lat-lng hors range), succès Google → `duree_min + distance_km + source: 'google_maps'`, cache hit (2ème appel n'appelle pas fetch), timeout AbortError → 504 fallback (1.5s réels), 5xx Google → 504 fallback, no route → 504 fallback, fallback non-mis-en-cache (le 2ème appel retente), forme exacte du body envoyé à Google (URL, headers `X-Goog-Api-Key`/`X-Goog-FieldMask`, `travelMode: DRIVE`)
- **Flights** : parser FlightView (array d'arrivées), reconstruction TZ Europe/Paris testée été (CEST) + hiver (CET), records sans `airlineCode`/`flightNumber` ou date malformée rejetés, payload non-array → `[]`, `refreshFlights` upsert + idempotence + URL FlightView correcte par aéroport, échec upstream → `refresh_failure++` et exception, `getCount` respecte la fenêtre temporelle, 401 sans JWT, 400 sur airport hors `[CDG, ORY, BVA]` (LBG → 400 explicite), 400 sur `eta` invalide, source=`default` si cache vide ou MAX(fetched_at) > 30min, source=`flightview` + count correct sur cache frais, fenêtres respectées (CDG=50min, ORY=40min, BVA=25min)
- **Rides** : REFUSED → row complet avec `is_complete=true`, TIMEOUT identique, ACCEPTED+TRIP_ENDED sans NEXT_OFFER → `is_complete=false`, lifecycle complet (OFFER_VISIBLE+ACCEPTED+TRIP_STARTED+TRIP_ENDED+NEXT_OFFER) → `is_complete=true` avec `next_offer_id` et `delai_avant_next_min`, OFFER_VISIBLE seul → pas de row, NEXT_OFFER orphelin (previous_offer_id inconnu) → pas de row, ingestion progressive (REFUSED arrive après OFFER_VISIBLE en batch séparé), promotion `is_complete` false→true quand NEXT_OFFER arrive en batch tardif, idempotence sur replay, `aggregateRide()` direct retourne `no_events`/`no_offer_visible`, parité rebuild ↔ live (3 offers consécutifs)
- **Amplitude (path fallback)** : `getConfigVariant` retourne `null` sans init, `trackEvent` ne throw pas, `initAmplitude` log `amplitude_experiment_skipped` + `amplitude_analytics_skipped` quand les vars absentes, `GET /config` continue de servir la config DB (cfg-2025-04-001 control), `POST /events` continue d'insérer + agréger les rides — l'API entière reste fonctionnelle sans Amplitude

---

## 🔑 Variables d'env (`.env`)

| Var | Set ? | Note |
|---|:-:|---|
| `PORT` | ✅ 3100 | |
| `NODE_ENV` | ✅ development | |
| `LOG_LEVEL` | ✅ info | |
| `JWT_SECRET` | ✅ 64 hex | random |
| `JWT_REFRESH_SECRET` | ✅ 64 hex | random distinct |
| `JWT_ACCESS_TTL` | ✅ 15m | |
| `JWT_REFRESH_TTL` | ✅ 30d | |
| `ADMIN_TOKEN` | ✅ 64 hex | |
| `DATABASE_URL` | ✅ | postgres://flashfare:flashfare@127.0.0.1:5432/flashfare (IPv4 forcé) |
| `GOOGLE_MAPS_API_KEY` | ✅ | clé fournie (Phase 5) |
| `GOOGLE_MAPS_TIER` | ✅ advanced | TRAFFIC_AWARE |
| `DEVICE_GROUP_HASH_SALT` | ✅ 64 hex | utilisé en fallback si Amplitude Experiment absent |
| `AMPLITUDE_API_KEY` | ✅ | Analytics — track events (Phase 2b) |
| `AMPLITUDE_EXPERIMENT_DEPLOYMENT_KEY` | ⚠️ vide | Experiment local eval. À récupérer dans le dashboard Amplitude (section Deployments) — sans elle, `/config` retombe sur `remote_configs` DB. |

> `AVIATIONSTACK_API_KEY` et `ADP_DATASET_URL` retirés en Phase 6 — la source FlightView (URL en dur dans `flights.js`) n'a besoin d'aucun secret.

---

## 🚀 Commandes utiles

```bash
# DB locale
docker compose up -d        # démarre Postgres
docker compose down         # arrête (sans perdre les données, volume nommé)

# Migrations & seeds
npm run migrate             # applique les migrations en attente
npm run seed                # seed postal_zones depuis seeds/postal_zones.csv (idempotent)
npm run rebuild-rides       # re-aggrège tous les rides depuis offer_events (filtre terminal events)
npm run rebuild-rides <id>  # rebuild une seule ligne par offer_id

# Dev
npm run dev                 # node --watch sur :3100
npm run start               # sans watch

# Qualité
npm run lint                # eslint
npm run format              # prettier --write
npm test                    # vitest run (98 tests)
npm run test:watch          # vitest interactif

# Smoke manuel
curl -X POST http://127.0.0.1:3100/auth/bootstrap
curl -H "Authorization: Bearer <token>" http://127.0.0.1:3100/config
```

---

## 📝 Historique des commits (`main`)

```
8612bbd  test(backend): config route + A/B assignment integration tests
d7fdb7f  feat(backend): GET /config with per-group lookup, LRU cache, ETag/304 + bootstrap A/B assignment
d6583c6  feat(backend): remote_configs + device_group_assignments tables + seed control config
1da9749  test(backend): integration tests for auth (bootstrap/refresh/delete) on isolated test DB
2941245  feat(backend): auth routes (bootstrap/refresh/delete) with JWT + bcrypt rotation
9c3bbc6  feat(backend): users table migration + postgres-js connection helper
9424f93  chore(backend): add bcryptjs (pure JS — avoids native build on Windows)
33b78c4  chore(backend): drop dotenv (use Node 22 --env-file natively), default PORT to 3100
3fe0c7b  feat(backend): migration runner (transactional, _migrations table, alphabetical order)
9abed96  test(backend): vitest setup + smoke test for GET /health
21a2475  chore(backend): ESLint flat config + Prettier
683593c  feat(backend): minimal Fastify server with /health route + Zod env validation
6f78b08  chore(backend): npm init + deps (...) + docker-compose Postgres 16
40d248b  chore: initial spec & data (00-08 + IDF postal codes CSV)
```

---

## ⏭️ Prochain : Phase 8 — `/ride/evaluate` + parser backend

Voir `08_planning_backend.md` § Phase 8 et `correction_android.md` à la racine pour la spec exhaustive (pipeline, migrations, contraintes, checklist).

Pré-requis :
- Phase 1 Android (capture sur Uber Driver via `flashfare-capture`) qui produit les fixtures `tests/fixtures/uber/` + le draft `parser_rules_v1.json`. Sans ces fixtures, on peut écrire la route + le seed vide + l'infra de tests, mais on ne peut pas valider l'extraction sur cas réels.
- 3 migrations : `009_parser_rules.sql` (seed vide du bloc `parser`), `010_app_versions.sql` (table `app_versions` pour `/version/latest`), `011_offer_events_parser_backend_version.sql` (colonne nullable commit SHA backend).

Phase 7 — finalisée :
- [x] Schéma `rides` (migration 007), 3 index
- [x] `aggregateRide(offer_id)` exporté + appel synchrone post-terminaux
- [x] `scripts/rebuild-rides.js` (full + par offer_id), filtre terminal events pour parité live
- [x] 12 tests rides (REFUSED/TIMEOUT/ACCEPTED partiel/complet/orphan/idempotence/rebuild parity)
- [x] Live test E2E : flow OFFER_VISIBLE→ACCEPTED→TRIP_ENDED→NEXT_OFFER produit `is_complete=true`

Phase 6 — finalisée (plus de bloqueur) :
- [x] Source vols confirmée : **FlightView** public JSON (CDG/ORY/BVA)
- [x] Fenêtre BVA (25 min) ajoutée à `cfg-2025-04-001` via migration `006_add_bva_to_config.sql`
- [x] Smoke live OK : `node scripts/smoke-flightview.mjs` retourne ~150 vols CDG / 80 ORY / 6 BVA en < 500 ms
- [ ] LBG : pas couvert par FlightView. Comportement attendu : route `/flights/adp?airport=LBG` → 400, le client doit tomber sur `flights.fallback_score: 85`. À documenter dans le client (Phase Android).

Pré-requis Phase 5 (côté GCP, géré) :
- [x] **Routes API activée** sur le projet GCP
- [x] **Restriction de clé levée** pour Routes API
- [ ] Définir un **cap mensuel** sur la clé (estimation ~315–630 USD/mois en advanced à 100 chauffeurs, selon ratio cache).

Pré-requis Phase 3 (à compléter à terme, pas bloquant) :
- [ ] Validation Ahmed des 528 CP seedés et du score par défaut
- [ ] Liste d'exceptions Ahmed (CP avec score qui diverge du défaut catégorie) — sera appliquée via la Phase 8 admin (`PATCH /admin/zones/:cp`) ou via un fichier `seeds/exceptions_ahmed.json` ré-importé.

Question Phase 4 ouverte :
- ⚠️ **Suppression RGPD (`DELETE /me`) doit-elle aussi supprimer les `offer_events` du user ?** Aujourd'hui : non (table sans FK, events conservés). Pour : conformité RGPD stricte. Contre : on perd les données pour la calibration. Compromis possible : anonymiser les events (mettre `user_id = NULL` + ajout colonne `is_deleted`) plutôt que delete. À discuter.
