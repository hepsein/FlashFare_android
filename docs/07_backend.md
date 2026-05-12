# 07 — Backend (Node.js JS)

## Stack

| Outil | Usage |
|---|---|
| Node.js 22 LTS | Runtime · `--env-file=.env` natif (pas de `dotenv`) |
| **JavaScript** (pas TS) | Pas de build step, simplicité |
| Fastify v5 | Framework HTTP |
| `postgres` (postgres-js) | Driver SQL direct, tagged templates |
| Zod | Validation |
| `lru-cache` | Caches in-memory (ETA, config, zones, flights freshness) |
| `node-cron` | Jobs périodiques (refresh vols) |
| pino (intégré Fastify) | Logs JSON |
| `bcryptjs` | Hash refresh tokens (pure JS, évite node-gyp sur Windows) |
| `@fastify/jwt`, `@fastify/helmet`, `@fastify/rate-limit` | Plugins Fastify |
| Vitest | Tests |

**Pas de Redis. Pas de BullMQ. Pas d'ORM. Pas de TypeScript. Pas de `dotenv`.**

## Règles d'or

1. **Simplicité** : un fichier par sujet, pas de hiérarchie de modules/services/schemas
2. **Rapidité** : la course Uber disparaît en 10-15s, le backend doit ajouter 0 latence détectable
   - Cache in-memory agressif
   - Pool DB chaud
   - Réponses < 30ms hors APIs externes
3. **Pas d'abstraction prématurée** : du code lisible, pas de DRY excessif

## Structure du projet

```
backend/
├── src/
│   ├── app.js             # buildApp() — factory, retournée pour app.inject() en tests
│   ├── server.js          # Entry point — appelle buildApp + listen + startJobs
│   ├── env.js             # Validation des variables d'env (Zod)
│   ├── db.js              # Connexion postgres-js + helpers
│   ├── auth.js            # Routes auth + JWT helpers + assignDeviceGroup
│   ├── config.js          # Route /config + LRU cache + invalidate helper
│   ├── zones.js           # Route /zones + LRU snapshot 1h + invalidate helper
│   ├── eta.js             # getEta() + Route /eta (debug/admin) + LRU 60s + 504 fallback
│   ├── flights.js         # getFlightsCount() + Route /flights/adp (debug/admin) + client FlightView + parser TZ-aware
│   ├── ride-evaluate.js   # Route /ride/evaluate — pipeline complet (parser + score + INSERT OFFER_VISIBLE)
│   ├── events.js          # Route /events + Zod discriminated union (sans OFFER_VISIBLE) + aggregateRide + trackEvent fire-and-forget
│   ├── version.js         # Route /version/latest (force-update gate Android)
│   ├── amplitude.js       # initAmplitude / getConfigVariant / trackEvent (Experiment local eval + Analytics)
│   ├── admin.js           # Routes /admin/* (zones, configs, métriques, /admin/version)
│   └── jobs.js            # node-cron (refresh vols 5min × {CDG, ORY, BVA})
├── migrations/
│   ├── 001_users.sql
│   ├── 002_remote_configs.sql       (+ seed cfg-2025-04-001 control)
│   ├── 003_postal_zones.sql
│   ├── 004_offer_events.sql
│   ├── 005_flights_cache.sql
│   ├── 006_add_bva_to_config.sql    (jsonb_set BVA windows + tiers)
│   ├── 007_rides.sql
│   ├── 008_users_pii.sql            (email/name/phone/address/password_hash columns)
│   ├── 009_parser_rules.sql         (jsonb_set parser block dans cfg-2025-04-001)
│   ├── 010_app_versions.sql         (table app_versions pour /version/latest)
│   └── 011_offer_events_parser_backend_version.sql  (commit SHA du backend par row)
├── seeds/
│   ├── postal_zones.csv   # 528 CP IDF (copie de FlashFare_Codes_Postaux_IDF.csv)
│   └── seed.js            # parse + upsert (npm run seed)
├── scripts/
│   ├── migrate.js         # Applique les migrations en ordre, table _migrations
│   ├── rebuild-rides.js   # Reconstruit la table rides depuis offer_events
│   └── smoke-flightview.mjs  # Smoke live FlightView CDG/ORY/BVA (debug)
├── tests/
│   ├── globalSetup.js     # crée flashfare_test + applique migrations
│   ├── setup.js           # injecte env vars test-safe
│   ├── helpers.js         # registerAndLogin(app, overrides?) — réutilisé partout
│   └── *.test.js
├── docker-compose.yml     # Postgres 16 sur host:5433 → conteneur:5432
├── .env.example
├── package.json
└── README.md
```

## Variables d'env (`.env.example`)

```env
# Server
PORT=3100                     # 3000 souvent occupé en dev (Next.js, etc.)
NODE_ENV=development
LOG_LEVEL=info

# Auth (32+ chars random, distinct entre secrets)
JWT_SECRET=
JWT_REFRESH_SECRET=
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=30d
ADMIN_TOKEN=                  # token simple pour endpoints admin

# DB — IPv4 explicite : sur Windows, "localhost" peut résoudre vers ::1 (WSL relay)
DATABASE_URL=postgresql://flashfare:flashfare@127.0.0.1:5433/flashfare

# APIs
# Vols (CDG/ORY/BVA) via FlightView (URL en dur dans flights.js, pas de clé requise)
GOOGLE_MAPS_API_KEY=
GOOGLE_MAPS_TIER=advanced     # basic | advanced (advanced = TRAFFIC_AWARE, recommandé)

# Amplitude (Experiment local eval + Analytics) — both optional
# Sans ces vars : initAmplitude() log un warning, /config retombe sur remote_configs DB,
# trackEvent() devient un no-op. Voir section "Amplitude" plus bas.
AMPLITUDE_API_KEY=                              # Analytics — track events
AMPLITUDE_EXPERIMENT_DEPLOYMENT_KEY=            # Experiment — deployment server-side

# Misc
DEVICE_GROUP_HASH_SALT=       # random (utilisé en fallback si Amplitude Experiment absent)
```

`src/env.js` valide tout au démarrage avec Zod, refus de boot si var manque. Le runtime utilise `node --env-file=.env src/server.js` (Node 22 natif) — pas de package `dotenv`.

## Migrations SQL

Fichiers SQL bruts numérotés. Script `migrate.js` lit `migrations/`, applique en ordre, track dans table `_migrations`.

Forme finale de la table `users` (résultat de l'application séquentielle de `001_users.sql` puis `008_users_pii.sql`) :
```sql
CREATE TABLE users (
  user_id            UUID PRIMARY KEY,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  refresh_token_hash TEXT,
  refresh_expires_at TIMESTAMPTZ,
  is_admin           BOOLEAN NOT NULL DEFAULT false,
  email              VARCHAR(254),
  first_name         VARCHAR(64),
  last_name          VARCHAR(64),
  phone              VARCHAR(32),
  address            TEXT,
  password_hash      TEXT
);

CREATE UNIQUE INDEX idx_users_email_lower
  ON users(LOWER(email))
  WHERE email IS NOT NULL;
```

Pour modifier un schéma : nouvelle migration, jamais de retouche en place.

## Code style — exemples concrets

### `db.js` (postgres-js direct)
```js
import postgres from 'postgres'
import { env } from './env.js'

export const sql = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 5,
})

// Usage dans un autre fichier :
//   const users = await sql`SELECT * FROM users WHERE user_id = ${id}`
```

### `eta.js` (cache LRU + Google Maps)
```js
import { LRUCache } from 'lru-cache'
import { z } from 'zod'

const cache = new LRUCache({ max: 5000, ttl: 60_000 })  // 60s

const Body = z.object({
  origin:      z.object({ lat: z.number(), lng: z.number() }),
  destination: z.object({ lat: z.number(), lng: z.number() }),
})

export async function etaRoutes(app) {
  app.post('/eta', { preHandler: app.authenticate }, async (req, reply) => {
    const body = Body.parse(req.body)
    const key = cacheKey(body)
    const cached = cache.get(key)
    if (cached) return cached

    const result = await callGoogleMaps(body)
      .catch(() => ({ source: 'fallback', error: 'timeout' }))

    if (result.source === 'google_maps') cache.set(key, result)
    if (result.source === 'fallback') reply.code(504)
    return result
  })
}

function cacheKey({ origin, destination }) {
  const r = (n) => Math.round(n * 1000) / 1000  // arrondi à 100m
  const bucket = Math.floor(Date.now() / 300_000)  // bucket 5min
  return `${r(origin.lat)},${r(origin.lng)}|${r(destination.lat)},${r(destination.lng)}|${bucket}`
}

async function callGoogleMaps({ origin, destination }) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters',
      },
      body: JSON.stringify({
        // Routes API attend { latitude, longitude } (proto), pas { lat, lng }.
        // L'API publique côté client garde { lat, lng } pour la concision.
        origin:      { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode:  'DRIVE',
        routingPreference: env.GOOGLE_MAPS_TIER === 'advanced' ? 'TRAFFIC_AWARE' : 'TRAFFIC_UNAWARE',
      }),
    })
    if (!res.ok) throw new Error(`google ${res.status}`)
    const json = await res.json()
    const route = json.routes?.[0]
    return {
      duree_min:   Math.round(parseInt(route.duration) / 60),
      distance_km: route.distanceMeters / 1000,
      source:      'google_maps',
    }
  } finally {
    clearTimeout(timer)
  }
}
```

### `app.js` + `server.js` (factory + entry point)

Pattern factory : `buildApp()` retourne une instance Fastify configurée mais
sans `listen()` ni `startJobs()`. Permet aux tests d'utiliser `app.inject()`
sans bind de port et sans démarrer les cron.

```js
// src/app.js
import Fastify from 'fastify'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import helmet from '@fastify/helmet'

import { env } from './env.js'
import { authRoutes, authenticate } from './auth.js'
import { configRoutes } from './config.js'
import { zonesRoutes } from './zones.js'
import { etaRoutes } from './eta.js'
import { flightsRoutes } from './flights.js'
import { eventsRoutes } from './events.js'
// import { adminRoutes } from './admin.js'    // Phase 8

export async function buildApp() {
  const app = Fastify({
    logger: env.NODE_ENV === 'test' ? false : { level: env.LOG_LEVEL },
  })

  await app.register(helmet)
  await app.register(rateLimit, { max: 1000, timeWindow: '1 minute' })

  // Deux namespaces JWT : access (default) + refresh, secrets distincts.
  await app.register(jwt, { secret: env.JWT_SECRET, sign: { expiresIn: env.JWT_ACCESS_TTL } })
  await app.register(jwt, {
    secret: env.JWT_REFRESH_SECRET,
    namespace: 'refresh',
    sign: { expiresIn: env.JWT_REFRESH_TTL },
  })
  app.decorate('authenticate', authenticate)

  await app.register(authRoutes)
  await app.register(configRoutes)
  await app.register(zonesRoutes)
  await app.register(etaRoutes)
  await app.register(flightsRoutes)
  await app.register(eventsRoutes)
  // await app.register(adminRoutes)            // Phase 8

  app.get('/health', async () => ({ ok: true }))
  return app
}
```

```js
// src/server.js
import { buildApp } from './app.js'
import { env } from './env.js'
import { startJobs } from './jobs.js'

const app = await buildApp()
await app.listen({ port: env.PORT, host: '0.0.0.0' })
startJobs(app)   // cron 5 min × {CDG, ORY, BVA}, jamais lancé en tests
```

Aucune magie, tout visible.

## Endpoints

### Auth & inscription

| Endpoint | Méthode | Auth | Body / Response |
|---|---|---|---|
| `/users/register` | POST | aucune (rate-limit 5/h/IP) | `{ email, password, first_name, last_name, phone, address }` → `201 { user_id, email }` |
| `/auth/login` | POST | aucune (rate-limit 10/min/IP) | `{ email, password }` → `{ user_id, access_token, refresh_token, device_group, config_version }` |
| `/auth/refresh` | POST | refresh | `{ refresh_token }` → nouvelle paire |
| `/me` | DELETE | JWT | suppression user (PII + assignment) |

> Le user s'inscrit sur la **landing page** (web) → `/users/register` crée la ligne `users` + le `device_group_assignments`, mais n'émet pas de tokens.
> Le user se connecte ensuite dans l'**app mobile** → `/auth/login` retourne la paire JWT et la config courante.
> Pas de bootstrap anonyme : le user doit s'inscrire en amont.

### Config & zones

| Endpoint | Méthode | Auth | Notes |
|---|---|---|---|
| `/config` | GET | JWT | ETag, 304 supporté |
| `/zones` | GET | JWT | ETag, 304 supporté |

### Évaluation d'une proposition (cœur du runtime)

| Endpoint | Méthode | Auth | Body |
|---|---|---|---|
| `/ride/evaluate` | POST | JWT | `{ captured_at, app_version, tree: { meta, nodes[] } }` |

Cf. `android.md` § 6 (contrat complet) et `correction_android.md` (pipeline interne). Pipeline résumé : Zod → `parser.screen_detection` → match `ride_type` → extract fields → résolution zone → `Promise.all([getEta, getFlightsCount])` 1500 ms → score → génère `offer_id` → INSERT `offer_event` OFFER_VISIBLE → `trackEvent` Amplitude → retour `{ offer_id, is_offer, display }`.

Budget : p95 < 1500 ms.

### APIs externes (debug/admin — pas appelées par l'app en routine)

| Endpoint | Méthode | Auth | Body / Query |
|---|---|---|---|
| `/eta` | POST | JWT | `{ origin: {lat,lng}, destination: {lat,lng} }` |
| `/flights/adp` | GET | JWT | `?airport=CDG\|ORY\|BVA&eta=ISO-8601` |

`/ride/evaluate` appelle directement les fonctions `getEta()` et `getFlightsCount()` exportées par `eta.js` et `flights.js` (pas de HTTP imbriqué). Ces routes restent exposées pour les tests manuels et l'admin.

[FlightView](https://app-api.flightview.com/api/airport/{IATA}/arrivals) (JSON public, sans clé) couvre CDG, ORY et BVA. LBG hors couverture → résolu inline par `/ride/evaluate` sur `flights.fallback_score: 85` (pas d'appel `getFlightsCount`).

### Events

| Endpoint | Méthode | Auth | Body |
|---|---|---|---|
| `/events` | POST | JWT | `{ ingestion_batch, events: [...] }` (idempotent par event_id) |

Types acceptés : `ACCEPTED`, `REFUSED`, `TIMEOUT`, `TRIP_STARTED`, `TRIP_ENDED`, `NEXT_OFFER`. `OFFER_VISIBLE` est rejeté (400) — il est inséré uniquement par `/ride/evaluate`.

### Version (force-update Android)

| Endpoint | Méthode | Auth | Retour |
|---|---|---|---|
| `/version/latest` | GET | JWT | `{ latest_version, latest_version_code, min_required_version, min_required_version_code, apk_url, release_notes, force_update }` |

### Admin (auth via `X-Admin-Token`)

| Endpoint | Méthode | Usage |
|---|---|---|
| `/admin/zones` | GET | Liste paginée + filtres |
| `/admin/zones/:cp` | PATCH | Modifier score CP |
| `/admin/configs` | GET / POST | Lister / créer config |
| `/admin/configs/:version/activate` | POST | Activer une config sur un groupe |
| `/admin/users/:id/group` | PATCH | Forcer groupe pour un device |
| `/admin/rides` | GET | Lecture vue rides (calibration) |
| `/admin/metrics/concordance` | GET | Métriques de calibration |
| `/admin/version` | POST | Publier une nouvelle APK (insert dans `app_versions`) |

## Cache in-memory

| Cache | Lib | TTL | Clé / contenu | Invalidation |
|---|---|---|---|---|
| ETA | `lru-cache` | 60s | `(latRound~100m, lngRound~100m, bucket5min)`, max 5000 | TTL only |
| Config par groupe | `lru-cache` | 10min | `device_group` → `{config_version, payload, etag}` | `invalidateConfigCache(group?)` (Phase 8 admin) |
| Zones snapshot | `lru-cache` | 1h | `'all'` (1 entrée), ETag = SHA-256(MAX(updated_at) + COUNT) | `invalidateZonesCache()` (Phase 8 admin PATCH) |

Métriques in-memory (objet exporté, lu par les futurs endpoints `/admin/metrics`) :
- `getEtaMetrics() → { google_maps, fallback, cache_hit }`
- `getFlightsMetrics() → { refresh_success, refresh_failure, count_default, count_flightview }`

Pas de Redis. Si un jour besoin de scaler horizontalement, on rajoute Redis.

## Amplitude (Experiment local eval + Analytics)

Source de vérité **en production** pour la remote config et l'A/B testing :
[Amplitude Experiment](https://amplitude.com/experiment) en mode local
evaluation server-side, couplé à [Amplitude Analytics](https://amplitude.com/analytics)
pour le tracking comportemental. **Les deux modules sont optionnels** —
absents, le backend retombe sur `remote_configs` DB et un no-op tracking.
Cette gracieuse dégradation maintient le dev local et le suite de tests verts
sans dépendance Amplitude.

### Deux modules, deux clés

| Module | Variable d'env | Rôle |
|---|---|---|
| **Experiment** | `AMPLITUDE_EXPERIMENT_DEPLOYMENT_KEY` | Évaluation des flag/variants. Le SDK télécharge les règles à `start()`, puis poll Amplitude toutes les 30s (par défaut) pour rester à jour. Évaluation par user = lookup mémoire **synchrone, ~0ms**, jamais d'appel réseau dans le chemin critique. |
| **Analytics** | `AMPLITUDE_API_KEY` | Tracking d'events comportementaux (proposition vue, acceptée, refusée…). Fire-and-forget, dashboards Amplitude affichent les funnels, segmentation par groupe, etc. |

### Flux boot → évaluation → tracking

```
server.js
  → await initAmplitude(app.log)
      → Experiment.initializeLocal(DEPLOYMENT_KEY) + .start()    ← pull initial des flag rules
      → init(API_KEY)                                            ← Analytics ready
  → app.listen()

GET /config (chaud, ~0ms)
  → getConfigVariant(user_id)
      → experimentClient.evaluateV2({ user_id }, ['flashfare-config'])  ← mémoire
      → renvoie { key, payload }
  → si null → fallback DB remote_configs
  → ETag + 304 supportés sur le payload final

POST /events (chaud, ~ms)
  → INSERT offer_events (logique inchangée)
  → pour chaque event nouvellement inséré :
      trackEvent(user_id, event.type, props)   ← fire-and-forget, aucune await
  → réponse au client

En arrière-plan (SDK Experiment, invisible)
  → poll Amplitude toutes les 30s → met à jour les flag rules en mémoire
    (si Ahmed ajuste un variant dans le dashboard, propagé au plus tard 30s plus tard)
```

### Le flag `flashfare-config`

Un seul flag, multi-variant (`control`, `test_a`, `test_b`...). Le **payload du
variant** est l'objet JSON complet de la config (mêmes champs que la colonne
`payload` de `remote_configs` : `weights`, `normalization`, `thresholds`,
`flights.windows_minutes`, `flights.tiers`, etc.). Ahmed peut créer / modifier /
activer / promouvoir des variants directement dans le dashboard Amplitude —
zéro déploiement, zéro accès SQL.

La clé du variant (`control` / `test_a` / ...) joue le rôle de `device_group`
dans le reste du code : embarquée dans chaque event, utilisée pour la
segmentation des `rides`.

### Mode dégradé (dev local sans Amplitude)

| `getConfigVariant` | retourne `null` |
| `trackEvent` | no-op silencieux |
| `GET /config` | fallback sur `remote_configs` + `device_group_assignments` (logique Phase 2 d'origine) |
| `POST /auth/bootstrap` | `device_group` calculé via `assignDeviceGroup` (hash modulo + `DEVICE_GROUP_HASH_SALT`) |
| Tests | les 86 tests existants restent verts sans variables Amplitude |

C'est cette dégradation qui justifie de **conserver les tables**
`remote_configs` et `device_group_assignments` même en prod : elles servent de
plan B si Amplitude est inaccessible au boot, et permettent au dev local de
tourner sans secret tiers.

## Jobs périodiques (`node-cron`)

```js
// jobs.js
import cron from 'node-cron'
import { refreshFlights } from './flights.js'

const REFRESH_AIRPORTS = ['CDG', 'ORY', 'BVA']  // FlightView couvre les 3, LBG hors scope

export function startJobs(app) {
  for (const airport of REFRESH_AIRPORTS) {
    cron.schedule('*/5 * * * *', () => safeRefresh(airport, app.log))
  }
  // Phase 8 : cron quotidien 04:00 → snapshot métriques de concordance
  // cron.schedule('0 4 * * *', () => calibrationDailySnapshot(app.log))
}
```

Les jobs tournent dans le **même process** que le serveur HTTP. **`startJobs()`
n'est appelé que dans `server.js`**, jamais dans `app.js` → pas de cron pendant
les tests qui utilisent `buildApp()` directement. Suffisant pour MVP. Si charge
→ split en process worker plus tard.

## Agrégation `rides`

Pas de queue : appel **synchrone** dans la route `POST /events` à chaque event terminal (REFUSED, TIMEOUT, TRIP_ENDED, NEXT_OFFER) → upsert dans `rides`. Idempotent.

```js
// events.js (extrait)
const TERMINAL = new Set(['REFUSED', 'TIMEOUT', 'TRIP_ENDED', 'NEXT_OFFER'])

async function ingestBatch(events, userId) {
  await sql`INSERT INTO offer_events ${sql(events)} ON CONFLICT DO NOTHING`
  const offerIdsToAggregate = new Set(
    events.filter(e => TERMINAL.has(e.type)).map(e => e.offer_id)
  )
  for (const offerId of offerIdsToAggregate) {
    await aggregateRide(offerId)  // upsert dans `rides`
  }
}
```

`aggregateRide(offer_id)` lit tous les events du `offer_id`, reconstruit la ligne, upsert. Réversible via script `rebuild-rides.js`.

## Healthcheck

```js
app.get('/health',       async () => ({ ok: true }))
app.get('/health/ready', async () => {
  await sql`SELECT 1`
  return { ok: true }
})
```

## Sécurité

- `helmet` (headers HTTP)
- `@fastify/rate-limit` global (1000/min/IP) + spécifiques **par user_id** (pas par IP — JWT décodé sans vérif dans le `keyGenerator`, juste pour le bucket) :
  - `/eta` : 60/min/user
  - `/events` : 30/min/user
  - `/flights/adp` : 60/min/user
  - `/auth/bootstrap` : à finaliser Phase 9 (5/h/IP visé)
- Refresh token = JWT signé avec `JWT_REFRESH_SECRET` (namespace distinct du JWT access). Le hash bcrypt (avec **pré-hash SHA-256** pour contourner la troncature 72 octets de bcrypt) en DB sert à invalider les anciens à la rotation.
- Validation Zod sur 100% des entrées
- TLS terminé par reverse proxy (Caddy/Cloudflare)
- Aucun secret dans le code (env only)
- Logs structurés JSON (pino) — fallbacks ETA capturent le body Google complet pour diagnostic

## Déploiement

### Dev local
```bash
# Postgres 16 via docker-compose (host:5433 → conteneur:5432, volume nommé flashfare_pg_data)
docker compose up -d

npm install
npm run migrate              # applique migrations en attente
npm run seed                 # 528 CP IDF dans postal_zones
npm run dev                  # node --watch --env-file=.env src/server.js (port 3100)

# Tests
npm test                     # vitest run, fileParallelism: false
npm run lint
```

> ⚠️ `127.0.0.1` au lieu de `localhost` dans `DATABASE_URL` : sur Windows,
> `localhost` peut résoudre vers `::1` (IPv6) qui passe par WSL relay et
> timeoute. Forçage IPv4 résout définitivement le problème.

### Prod cible
- VPS Linux **Paris** (OVH, Scaleway) → minimise latence depuis devices français
- Caddy en reverse proxy (TLS auto)
- Postgres : managed simple (Neon, Supabase) ou self-hosted avec backup `pg_dump` quotidien
- Process : systemd unit
- Logs : pino → fichier rotatif

### CI/CD
GitHub Actions : lint + test sur PR, deploy auto sur tag.
