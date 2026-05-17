# 08 — Planning Backend (checklist agent)

Format : phase = section, tâche = checkbox courte. Avancer phase par phase. Ne pas commencer N+1 avant que la checklist N soit verte.

## Règles

1. Chaque tâche doit être finissable indépendamment et testable.
2. Si une tâche bloque (ex. URL d'un flux externe), passer à la phase suivante non bloquée et noter le blocage.
3. À la fin de chaque phase : commit + push + tests verts.

---

## Phase 0 — Setup

- [ ] `npm init -y` dans `backend/`
- [ ] Installer deps : `npm i fastify @fastify/jwt @fastify/rate-limit @fastify/helmet postgres zod lru-cache node-cron bcryptjs` (pas de `dotenv` — Node 22 `--env-file` natif)
- [ ] Installer dev deps : `npm i -D vitest supertest eslint prettier`
- [ ] Créer arbo : `src/`, `migrations/`, `seeds/`, `scripts/`, `tests/`
- [ ] `.gitignore` : `node_modules`, `.env`, `*.log`
- [ ] `.env.example` complet (cf. `07_backend.md`)
- [ ] `src/env.js` : Zod valide toutes les env, throw au démarrage si manque
- [ ] `docker run` Postgres 16 local OU `docker-compose.yml`
- [ ] `src/server.js` minimal : Fastify + `/health` qui répond `{ ok: true }`
- [ ] `npm run dev` (avec `node --watch`) lance le serveur
- [ ] `curl localhost:3000/health` → 200
- [ ] ESLint + Prettier configurés, `npm run lint` passe
- [ ] Vitest configuré, 1 test smoke `health.test.js` passe
- [ ] `scripts/migrate.js` : lit `migrations/*.sql` ordre alpha, applique en transaction, track dans `_migrations`

**✅ Phase OK quand** : serveur démarre, `/health` répond, migrate sur DB vide ne fait rien, tests passent.

---

## Phase 1 — Auth (inscription landing + login email/password)

> Pas de création anonyme depuis l'app : le user s'inscrit sur la **landing page web** (PII complète : nom, prénom, email, téléphone, adresse + password) avant de pouvoir se connecter dans l'app mobile.

- [x] `migrations/001_users.sql` : table `users` minimale (UUID, refresh hash, expires, is_admin)
- [x] `migrations/008_users_pii.sql` : ajout colonnes PII (`email`, `first_name`, `last_name`, `phone`, `address`, `password_hash`) + UNIQUE INDEX case-insensitive sur `LOWER(email)`
- [x] `src/db.js` : exporte `sql` (postgres-js), pool max 10
- [x] `src/auth.js` :
  - [x] Plugin Fastify `authenticate` (préHandler vérif JWT, expose `req.user.user_id`)
  - [x] Route `POST /users/register` (rate-limit 5/h/IP) : valide PII via Zod, hash bcrypt du password (cost 10), insert `users` + `device_group_assignments` en une transaction, retour `201 { user_id, email }`. 409 sur email dupliqué (case-insensitive, race-safe via 23505).
  - [x] Route `POST /auth/login` (rate-limit 10/min/IP) : lookup `LOWER(email)`, bcrypt.compare avec dummy hash si user absent (timing constant), retour `{ user_id, access_token, refresh_token, device_group, config_version }`
  - [x] Route `POST /auth/refresh` : rotate refresh token, retourne nouvelle paire
  - [x] Route `DELETE /me` : delete user (PII incluse) + assignment row
  - [x] Hash bcrypt du refresh_token en DB (jamais en clair, pré-hashé SHA-256 pour contourner la limite 72 octets de bcrypt)
- [x] Tests `tests/auth.test.js` : 22 cas couvrant register (succès + 6 cas d'invalid body + duplicate 409), login (succès, case-insensitive, wrong password, unknown email), refresh (rotation single-use, bogus token), DELETE /me (PII deletion), flow E2E complet
- [x] `tests/helpers.js` : `registerAndLogin(app, overrides?)` réutilisé par tous les autres fichiers de test

**✅ Phase OK quand** : flow complet register → login → refresh → delete fonctionne.

---

## Phase 2 — Remote config + groupes A/B (fallback dev local)

> Pose les tables `remote_configs` + `device_group_assignments` et la route `GET /config` en lecture DB. En production, Amplitude Experiment (Phase 2b) prend la main ; ces tables servent de fallback dev local + support de l'override admin.

- [x] `migrations/002_remote_configs.sql` : tables `remote_configs` + `device_group_assignments` (cf. `06_data.md`)
- [x] Migration de seed : insérer `cfg-2025-04-001` pour groupe `control` avec valeurs init (cf. `03_calcul.md`)
- [x] `src/auth.js` : au bootstrap, calculer `device_group` via hash modulo `(user_id, salt)` parmi `[control, test_a, test_b]`, insérer dans `device_group_assignments`
- [x] `src/config.js` :
  - [x] LRU cache `configByGroup` TTL 10min
  - [x] Route `GET /config` : récupère assignment user → cherche config active du groupe → retour avec ETag (hash JSON)
  - [x] Support `If-None-Match` → 304
- [x] `src/auth.js` : ajuster le bootstrap pour retourner le vrai `config_version`
- [x] Tests : bootstrap puis `GET /config` retourne la config attendue, 2e appel avec ETag → 304

**✅ Phase OK quand** : 2 devices distincts peuvent avoir des configs différentes selon leur groupe (validé via la table DB en fallback, et via les variants Amplitude en prod).

---

## Phase 2b — Amplitude (Experiment local eval + Analytics)

> Source de vérité production pour la remote config + tracking comportemental. Détails dans `07_backend.md` § "Amplitude" et `06_data.md` § "Remote config".

- [x] `npm i @amplitude/analytics-node @amplitude/experiment-node-server`
- [x] `src/env.js` : ajouter `AMPLITUDE_API_KEY` et `AMPLITUDE_EXPERIMENT_DEPLOYMENT_KEY` comme variables **optionnelles** (Zod `.optional()`)
- [x] `src/amplitude.js` :
  - [x] `initAmplitude(log)` — async, démarre Experiment local eval + init Analytics. Logs warning si une clé est absente. Jamais de throw.
  - [x] `getConfigVariant(userId)` — sync, ~0ms, retourne `{ key, payload }` ou `null`
  - [x] `trackEvent(userId, type, props)` — fire-and-forget, ne throw jamais, no-op si Analytics absent
- [x] `src/server.js` : `await initAmplitude(app.log)` avant `app.listen()`
- [x] `src/config.js` : `getConfigVariant` en priorité, fallback DB `remote_configs` si null. Per-user LRU cache 10min, ETag/304.
- [x] `src/auth.js` : `device_group` provient du variant Amplitude si dispo, sinon `assignDeviceGroup` hash modulo. La row `device_group_assignments` reste insérée (override admin Phase 8).
- [x] `src/events.js` : fire-and-forget `trackEvent` après `INSERT ... RETURNING id` (skip duplicates pour éviter le double-comptage sur retry)
- [x] Tests `tests/amplitude.test.js` : path fallback complet — `getConfigVariant` null, `trackEvent` no-op, init logs warnings, `GET /config` + `POST /events` continuent de fonctionner sans Amplitude

**✅ Phase OK quand** : avec `AMPLITUDE_*` dans l'env, `/config` sert le payload du variant en mémoire (~0ms) et chaque event arrive dans Amplitude Analytics. Sans ces vars, les tests + l'API restent verts (DB fallback).

---

## Phase 3 — Zones

- [ ] `migrations/003_postal_zones.sql` : table `postal_zones` (cf. `04_zones.md`)
- [ ] `seeds/postal_zones.csv` : ~1250 CP IDF visés (CSV initial fourni couvre **528 CP** — suffisant pour MVP, à compléter par Ahmed) + scores de catégorie
- [ ] `seeds/seed.js` : charge le CSV → upsert dans `postal_zones`
- [ ] Optionnel : `seeds/exceptions_ahmed.json` → override scores
- [ ] `src/zones.js` :
  - [ ] LRU cache zones TTL 1h (1 entrée `'all'`)
  - [ ] Route `GET /zones` : retourne tableau `{ postal_code, category, score }`, ETag = hash de `MAX(updated_at)`
  - [ ] Support `If-None-Match` → 304
- [ ] Tests : seed → `GET /zones` retourne ~1250 lignes

**✅ Phase OK quand** : client peut récupérer le snapshot zones, ETag fonctionne.

---

## Phase 4 — Events ingestion

- [ ] `migrations/004_offer_events.sql` : table `offer_events` + indexes (cf. `06_data.md`)
- [ ] `src/events.js` :
  - [ ] Schéma Zod discriminated union sur `type` (un schéma par type d'event)
  - [ ] Route `POST /events` : valide le batch, insert idempotent (`ON CONFLICT (event_id) DO NOTHING`)
  - [ ] Vérif sécurité : tous `event.user_id` doivent matcher `req.user_id` du JWT, sinon 403
  - [ ] Retour : `{ accepted, duplicates }`
- [ ] Rate limit `/events` : 30 batch / user / minute
- [ ] Tests : batch valide, batch avec doublons (idempotence), batch avec event d'un autre user (403)

**✅ Phase OK quand** : un client peut envoyer des batchs d'events, idempotent.

---

## Phase 5 — Proxy ETA Google Maps

- [ ] Obtenir clé Google Maps API (Routes API activée), ajouter au `.env`
- [ ] `src/eta.js` :
  - [ ] LRU cache TTL 60s (cf. exemple `07_backend.md`)
  - [ ] Route `POST /eta` : Zod valide body, check cache, sinon call Google avec timeout 1500ms
  - [ ] Si timeout/erreur → retour `{ source: 'fallback' }` + status 504
  - [ ] Si succès → cache + retour `{ duree_min, distance_km, source: 'google_maps' }`
- [ ] Rate limit `/eta` : 60 / user / minute
- [ ] Métriques : compteur req par source (`google_maps` vs `fallback`)
- [ ] Tests : succès avec mock fetch, timeout (signal abort), 504, cache hit

**✅ Phase OK quand** : `/eta` répond < 30ms en cache, < 2000ms via Google, fallback propre en timeout.

---

## Phase 6 — Vols (CDG / ORY / BVA via FlightView)

> FlightView (endpoint JSON public, sans clé) couvre CDG, ORY et BVA d'un seul provider. LBG (Le Bourget) reste hors scope (peu couvert, faible volume pax) → ride vers LBG bascule sur `flights.fallback_score` côté client, pas d'appel route.

- [x] `migrations/005_flights_cache.sql` : table `flights_cache` (PK composite `airport+flight+scheduled`)
- [x] Migration follow-up `006_add_bva_to_config.sql` : ajout BVA aux `windows_minutes` + `tiers` du seed `cfg-2025-04-001`
- [x] `src/flights.js` :
  - [x] Client FlightView : `GET https://app-api.flightview.com/api/airport/{IATA}/arrivals` → JSON array. Heures locales Europe/Paris reconstruites en UTC en testant les 2 offsets DST.
  - [x] Fonction refresh : pull FlightView, upsert dans `flights_cache` avec `source='flightview'` et `fetched_at=now()`. Si `updatedTime` présent → utilisé comme `scheduled_at` effectif (sinon `scheduledTime`).
  - [x] Fonction `getCount(airport, eta_iso, window_minutes)` : `SELECT COUNT(*) FROM flights_cache WHERE airport=$1 AND scheduled_at BETWEEN $2 AND $3`
  - [x] Route `GET /flights/adp?airport={CDG|ORY|BVA}&eta=ISO` : lit la config (window_minutes), appelle `getCount`, retour `{ count, source, window_minutes }`
  - [x] Si `flights_cache` vide ou `MAX(fetched_at)` > 30 min → retour `{ source: 'default' }`
- [x] `src/jobs.js` : cron 5min × 3 (CDG, ORY, BVA)
- [x] Tests (19) : parser, conversions DST, refresh + idempotence, getCount par fenêtre, route happy path + stale + 400/401

**✅ Phase OK quand** : après 30 min de service, `flights_cache` a des données fraîches, `/flights/adp` retourne un count cohérent pour CDG/ORY/BVA.

---

## Phase 7 — Agrégation rides

- [ ] `migrations/007_rides.sql` : table `rides` (cf. `06_data.md`)
- [ ] `src/events.js` :
  - [ ] Fonction `aggregateRide(offer_id)` :
    - [ ] Lit tous les events du `offer_id`
    - [ ] Reconstruit la ligne `rides` (decision, durations, outcomes)
    - [ ] Upsert (`ON CONFLICT (offer_id) DO UPDATE`)
    - [ ] Cas spécial : event `NEXT_OFFER` → met à jour la ligne `rides` du `previous_offer_id`
  - [ ] À l'ingestion d'un event terminal (REFUSED, TIMEOUT, TRIP_ENDED, NEXT_OFFER) → appel synchrone `aggregateRide(offer_id)` (pas de queue)
- [ ] `scripts/rebuild-rides.js` : rebuild full depuis `offer_events` (utile en cas de bug logique)
- [ ] Tests : scénarios variés (refus, timeout, course complète + suivante)

**✅ Phase OK quand** : la table `rides` se remplit automatiquement, rebuild reproduit le même résultat.

---

## Phase 8 — `/ride/evaluate` + parser backend

> Cf. `correction_android.md` pour la justification, le pipeline complet et le contrat d'API. Dépend de la Phase 1 capture Android (fixtures + `parser_rules_v1.json`) pour valider l'extraction sur cas réels.

- [ ] `migrations/009_parser_rules.sql` — seed initial du champ `parser` dans `cfg-2025-04-001`. Source de vérité : `parser_rules_v1.json` à la racine du repo capture (features score 3/4 + règles extraction text+structure). Seuil `score_threshold` mis à `99` au seed = killswitch implicite tant que pas activé via admin/Amplitude.
- [ ] `migrations/010_app_versions.sql` — table `app_versions` (utilisée par la route `/version/latest` ci-dessous + Phase 9 admin)
- [ ] `migrations/011_offer_events_parser_backend_version.sql` — colonne nullable `parser_backend_version` (commit SHA du backend)
- [ ] Exporter `getEta(origin, destination)` depuis `src/eta.js` (factoriser le code de la route existante)
- [ ] Vérifier que `getFlightsCount(airport, eta, windowMinutes)` est exportable proprement depuis `src/flights.js`
- [ ] `src/ride-evaluate.js` :
  - [ ] Route `POST /ride/evaluate`, JWT, rate-limit 60/min/user (keyGenerator JWT-decode comme `/eta`)
  - [ ] Zod : `tree.nodes[]` array, `tree.meta` object (dont `schema_version` accepté `=== 1` sinon 400, `location` optionnel `{lat, lng, accuracy_m, provider, captured_at}`), `captured_at` ISO, `app_version`
  - [ ] Charger le `parser` du user via `getConfigVariant` puis fallback DB
  - [ ] Appliquer `parser.screen_detection` → score features ≥ `score_threshold` ? Si fail → return `{ is_offer: false }`
  - [ ] Appliquer `parser.extraction` (regex texte + filtres structurels class/bounds), `vehicle_type`/`tags` dérivés runtime
  - [ ] Résoudre zone (mot-clé aéroport prioritaire, sinon lookup CP `dropoff_address` dans `postal_zones`, fallback `meta.location` lat/lng → shapefile zones IDF)
  - [ ] `Promise.all([getEta(...), getFlightsCount(...)])` avec timeout global 1500 ms
  - [ ] Calculer score composite (formules `03_calcul.md`)
  - [ ] Générer `offer_id` UUID, INSERT `offer_event` OFFER_VISIBLE
  - [ ] `trackEvent` Amplitude `ride_offer_evaluated` (fire-and-forget)
  - [ ] Retour `{ offer_id, is_offer, display }`
- [ ] `src/events.js` : retirer `OFFER_VISIBLE` du Zod discriminated union (rejet 400)
- [ ] `src/version.js` : route `GET /version/latest` (JWT), retour de la row `app_versions` au `version_code` le plus élevé
- [ ] Tests `tests/ride-evaluate.test.js` :
  - [ ] Rejoue chaque fixture `tests/fixtures/uber/*.json` avec son `.truth.json`
  - [ ] `is_offer=true` : `display.show_overlay=true` + champs corrects
  - [ ] `is_offer=false` : retour `{ is_offer: false }`
  - [ ] Mock `getEta` et `getFlightsCount`
  - [ ] Cas ETA timeout → `display.show_overlay=false, error: "eta_timeout"`
  - [ ] Cas parsing_failed → `display.show_overlay=false, error: "parsing_failed"`
- [ ] Tests `tests/version.test.js` : happy path, min_required, force_update
- [ ] Bench p95 < 1500 ms en charge légère (10 req/s)

**✅ Phase OK quand** : `npm test` passe avec 100% des fixtures vertes, latence p95 < 1500 ms.

---

## Phase 9 — Admin et calibration v0

- [ ] `src/admin.js` :
  - [ ] Middleware `requireAdmin` : vérifie header `X-Admin-Token` == `env.ADMIN_TOKEN`
  - [ ] `GET /admin/zones` (liste paginée, filtres dept/category)
  - [ ] `PATCH /admin/zones/:cp` : update score, invalide cache zones
  - [ ] `GET /admin/configs` (liste)
  - [ ] `POST /admin/configs` : créer une nouvelle config_version
  - [ ] `POST /admin/configs/:version/activate` : active sur un groupe (désactive l'ancienne du même groupe)
  - [ ] `PATCH /admin/users/:id/group` : forcer un groupe pour un device (avec `forced=true`)
  - [ ] `GET /admin/rides` : pagination, filtres (date, decision, config_version, group)
  - [ ] `GET /admin/metrics/concordance` : MAE prédit ↔ réel, taux acceptation par verdict, distribution erreurs (cf. `06_data.md`)
  - [ ] `POST /admin/version` : publier une APK dans `app_versions` (consommé par `GET /version/latest`)
- [ ] `src/jobs.js` : cron quotidien 04:00 → calcule snapshot métriques, log
- [ ] Tests : flow admin complet

**✅ Phase OK quand** : Ahmed peut consulter les métriques de concordance via curl/Postman, ajuster les zones et configs, publier une nouvelle APK.

---

## Phase 10 — Sécurité, observabilité, déploiement

- [ ] Helmet activé + CSP basique
- [ ] Rate limits finalisés et testés
- [ ] Refresh token strict (one-shot, rotation)
- [ ] CORS restrictif
- [ ] Audit `npm audit` sans high/critical
- [ ] Logs : niveau `info` prod, exclure payloads complets events
- [ ] Endpoint `/metrics` (format Prometheus simple, count req par route + latencies)
- [ ] `pg_dump` chiffré quotidien (cron côté hôte) + procédure restore documentée
- [ ] VPS Paris (OVH/Scaleway) provisionné
- [ ] Caddy reverse proxy avec TLS auto
- [ ] systemd unit pour le serveur
- [ ] Variables d'env via `/etc/flashfare/.env` chmod 600
- [ ] CI GitHub Actions : lint + test sur PR
- [ ] CD : deploy SSH sur tag `v*`, migrations auto-appliquées
- [ ] README : setup, deploy, runbook (que faire si X plante)

**✅ Phase OK quand** : déployé sur domaine public, healthcheck OK depuis Internet, 3 chauffeurs pilotes peuvent l'utiliser.

---

## Critères de succès MVP

- [ ] Un device peut bootstrap, recevoir une config, envoyer des events
- [ ] Events terminaux génèrent une ligne `rides` complète en < 1s
- [ ] Coûts Google Maps prédictibles (cache visible dans métriques)
- [ ] Admin peut modifier zones et config sans redéploiement
- [ ] Latence `/eta` < 30ms en cache hit, < 2000ms cache miss
- [ ] Latence `/events`, `/config`, `/zones` < 50ms p95

---

## Bloqueurs externes à débloquer en parallèle

Ces points ne bloquent pas le démarrage du dev mais doivent être traités tôt :

- [x] Source vols CDG/ORY/BVA confirmée (FlightView, endpoint public sans clé)
- [x] CSV des CP IDF avec scores de catégorie (528 CP fournis — suffisant MVP, à étendre + exceptions Ahmed à terme)
- [x] Clé Google Maps obtenue + Routes API activée
- [ ] Cap mensuel Google Maps à définir
- [ ] VPS provisionné + DNS + TLS (sinon Phase 9 stuck)
