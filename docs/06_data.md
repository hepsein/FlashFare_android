# 06 — Données et remote config

## Principe

Events bruts collectés par proposition pour permettre :
- Calibration des paramètres du calcul
- Mesure concordance verdict prédit ↔ taux horaire réel

Paramètres pilotés via **remote config** avec **groupes A/B** (configs différentes par sous-ensemble de devices).

## Architecture dataset

### Events bruts (source de vérité)

```sql
CREATE TABLE offer_events (
  id              UUID PRIMARY KEY,
  offer_id        UUID NOT NULL,
  user_id         UUID NOT NULL,
  type            TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  app_version     TEXT NOT NULL,
  parser_version  TEXT NOT NULL,
  config_version  TEXT NOT NULL,
  device_group    TEXT NOT NULL,
  payload         JSONB NOT NULL,
  ingestion_batch UUID
);

CREATE INDEX idx_offer_events_offer       ON offer_events(offer_id);
CREATE INDEX idx_offer_events_user_time   ON offer_events(user_id, occurred_at DESC);
CREATE INDEX idx_offer_events_type        ON offer_events(type);
CREATE INDEX idx_offer_events_config_ver  ON offer_events(config_version);
```

Colonne optionnelle ajoutée par la migration `011_offer_events_parser_backend_version.sql` : `parser_backend_version TEXT` (commit SHA du backend ayant produit la row, lu via `process.env.GIT_SHA`).

Pour les rows `OFFER_VISIBLE` (insérées par `POST /ride/evaluate`), le `payload` JSONB embarque `driver_location` issu de `tree.meta.location` du dump :

```json
{
  "ride_offer": { ... },
  "eta": { ... },
  "flights": { ... },
  "score_predicted": { ... },
  "driver_location": {
    "lat": 48.8566, "lng": 2.3522, "accuracy_m": 12.5,
    "provider": "fused", "captured_at": 1736245195000
  },
  "overlay_displayed_partial": false
}
```

`driver_location` permet (a) la résolution de zone fallback côté backend si l'extraction du CP `dropoff_address` échoue, (b) la cohérence (driver loin du pickup déclaré = warning loggué), (c) la segmentation géo dans Amplitude (`driver_lat` / `driver_lng` event properties).

### Vue `rides` (1 ligne = 1 proposition)

Reconstruite à partir des events bruts. **Agrégation synchrone** appelée à chaque event terminal (REFUSED, TIMEOUT, TRIP_ENDED, NEXT_OFFER) reçu dans `POST /events`. La ligne OFFER_VISIBLE de référence est insérée par `POST /ride/evaluate` (cf. `02_architecture.md` § Endpoints). Pas de queue, volume cible faible, la ligne `rides` est visible immédiatement par les outils admin. Réversible via `npm run rebuild-rides`.

```sql
CREATE TABLE rides (
  offer_id              UUID PRIMARY KEY,
  user_id               UUID NOT NULL,
  device_group          TEXT NOT NULL,
  config_version        TEXT NOT NULL,
  parser_version        TEXT NOT NULL,
  app_version           TEXT NOT NULL,
  occurred_at           TIMESTAMPTZ NOT NULL,
  ride_offer            JSONB NOT NULL,
  eta                   JSONB,
  flights               JSONB,
  score_predicted       JSONB,
  decision              TEXT,
  reaction_ms           INTEGER,
  trip_started_at       TIMESTAMPTZ,
  trip_ended_at         TIMESTAMPTZ,
  duree_reelle_min      INTEGER,
  next_offer_id         UUID,
  delai_avant_next_min  INTEGER,
  is_complete           BOOLEAN NOT NULL DEFAULT false,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rides_user_time         ON rides(user_id, occurred_at DESC);
CREATE INDEX idx_rides_complete          ON rides(is_complete) WHERE is_complete = true;
CREATE INDEX idx_rides_config_decision   ON rides(config_version, decision);
```

> `eta`, `flights`, `score_predicted` rendus nullable — un event terminal peut arriver avant l'OFFER_VISIBLE complet (ex. timeout précoce, parsing partiel).

`is_complete = true` quand outcome reçu :
- `decision = REFUSED` ou `TIMEOUT` → tout de suite (pas de course)
- `decision = ACCEPTED` → uniquement après réception de TRIP_ENDED **et** NEXT_OFFER (lifecycle complet, le `delai_avant_next_min` est nécessaire pour calculer le vrai taux horaire)

Seules les courses complètes alimentent la calibration.

**Cas particulier NEXT_OFFER** : son propre `offer_id` est celui de la NOUVELLE proposition (qui aura sa propre OFFER_VISIBLE plus tard), mais `payload.previous_offer_id` pointe vers l'offer qui se termine. C'est cette PREVIOUS qui est agrégée à la réception du NEXT_OFFER.

## Champs de versioning embarqués (chaque event)

| Champ | Source | Usage |
|---|---|---|
| `app_version` | `BuildConfig.VERSION_NAME` | Debug, segmentation |
| `parser_version` | `parser.rules_version` du payload remote config (Amplitude variant ou DB fallback) | Isoler les events traités par version de règles donnée |
| `parser_backend_version` | commit SHA backend (`process.env.GIT_SHA`) | Identifier la version du code parser backend pour les OFFER_VISIBLE émis par `/ride/evaluate` |
| `config_version` | remote config reçue | Rejouer calculs avec d'autres pondérations |
| `device_group` | variant Amplitude (sinon hash modulo) | A/B testing |
| `user_id` | UUID interne (inscription landing) | Dédup, segmentation chauffeur |

## Remote config

### Mécanisme

**Source de vérité en prod : [Amplitude Experiment](https://amplitude.com/experiment) en local evaluation server-side.** Le SDK pulle les règles de flag au boot (`server.js → initAmplitude`) puis re-poll Amplitude toutes les 30 s en arrière-plan. L'évaluation pour un user = lookup synchrone en mémoire, ~0 ms, aucun appel réseau dans le chemin critique de `/config` ni de `/ride/evaluate`. Les variants du flag `flashfare-config` portent le `payload` JSON identique au schéma ci-dessous. Ahmed crée / modifie / active un variant via le dashboard Amplitude sans déploiement. Détail : `07_backend.md` § "Amplitude".

**Tables `remote_configs` + `device_group_assignments` = fallback dev local** : utilisées si les variables `AMPLITUDE_*` sont absentes, ou si l'Experiment SDK ne renvoie aucun variant. Permettent aussi à l'admin de **forcer un groupe** pour un device pilote via `PATCH /admin/users/:id/group` (override prime sur Amplitude).

- Backend expose `GET /config`
- Client récupère au démarrage et toutes les 6 h, ETag
- Pipeline : 1) `getConfigVariant(user_id)` Amplitude → 2) si null, fallback DB sur le groupe assigné au user_id (hash modulo `DEVICE_GROUP_HASH_SALT`)
- Override admin pris en compte via la table `device_group_assignments` même quand Amplitude est actif

### Schéma
```json
{
  "config_version": "cfg-2025-04-001",
  "device_group": "control",
  "weights": { "horaire": 0.60, "km": 0.15, "zone": 0.25 },
  "normalization": { "horaire_divisor": 3, "km_multiplier": 5, "zone_divisor": 10 },
  "thresholds": { "rentable": 7, "limite": 4 },
  "fallback_timeout_ms": 1500,
  "flights": {
    "fallback_score": 85,
    "windows_minutes": { "CDG": 50, "ORY": 40, "BVA": 25 },
    "tiers": { /* CDG, ORY, BVA — cf. 05_apis.md */ }
  },
  "parser": {
    "rules_version": "pr-2026-05-001",
    "screen_detection": { /* package, score_threshold, features (text/class/bounds), cf. android.md § 5 */ },
    "extraction": { /* price, pickup_eta, trip_distance_km, driver_rating, addresses, action_label, vehicle_type, tags */ },
    "noise_labels_by_locale": { "fr": ["Montant net de frais"] },
    "trip_active_activity_classes": [ /* ... */ ],
    "trip_ended_activity_classes": [ /* ... */ ],
    "heartbeat_interval_minutes": 10,
    "overlay_dismiss_after_seconds": 10,
    "backend_timeout_ms": 2500
  }
}
```

Le bloc `parser` est consommé par `POST /ride/evaluate` côté backend pour parser l'arbre Uber, et par l'app pour le filtre local `ScreenSignals` + la state machine.

### Côté client
1. Si remote config injoignable → dernières valeurs en cache
2. Si pas de cache → valeurs par défaut figées dans le code

### Tables backend (fallback dev local — source de vérité = Amplitude Experiment en production)
```sql
CREATE TABLE remote_configs (
  config_version TEXT PRIMARY KEY,
  device_group   TEXT NOT NULL,
  payload        JSONB NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     TEXT NOT NULL,
  notes          TEXT
);

CREATE TABLE device_group_assignments (
  user_id      UUID PRIMARY KEY,
  device_group TEXT NOT NULL,
  assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  forced       BOOLEAN NOT NULL DEFAULT false
);
```

- `remote_configs` : seedée avec `cfg-2025-04-001` pour `control`. Plan B si Amplitude Experiment est indisponible au boot, source unique en dev local sans secrets Amplitude.
- `device_group_assignments` : insérée à l'inscription (le `device_group` provient d'Amplitude si dispo, sinon du hash modulo). Support de l'override admin (`forced=true`), qui prime sur Amplitude.

## Pipeline de calibration

Job offline lit la base.

### Étapes
1. Charger `rides` complètes des 30 derniers jours
2. Calculer taux horaire réel : `montant / (pickup_min + duree_reelle_min + delai_avant_next_min) × 60`
3. Comparer au `score_predicted.taux_horaire`
4. Segmenter : zone, heure, jour de semaine, aéroport
5. Identifier biais systématiques
6. Proposer nouvelle config (zones, tiers aéroport, pondérations)
7. Déployer en groupe `test_b` avec nouveau `config_version`
8. Mesurer après N jours vs `control`
9. Promouvoir si gain significatif

### Métriques de suivi

| Métrique | Calcul | Seuil cible |
|---|---|---|
| MAE score prédit ↔ réel | moyenne(`abs(score_predit_taux_h - taux_h_reel/3)`) | < 1.5 |
| Taux d'acceptation | ACCEPTED / OFFER_VISIBLE | référence |
| Taux d'acceptation par verdict | groupé par verdict | RENTABLE > 80%, NON_RENTABLE < 20% |
| Délai moyen avant course suivante | par zone | input scoring zone |
| Concordance verdict ↔ intuition | enquête NPS | > 80% |

## Inscription + login

Pas de création anonyme : le user **doit** s'inscrire via la landing page web avant de pouvoir se connecter dans l'app mobile.

### `POST /users/register` (landing page)
Body :
```json
{
  "email":      "ada@example.com",
  "password":   "min8chars",
  "first_name": "Ada",
  "last_name":  "Lovelace",
  "phone":      "+33 6 12 34 56 78",
  "address":    "12 rue de Rivoli, 75001 Paris"
}
```
- Public, rate-limit 5/h/IP
- Email unique case-insensitive (409 sur duplicat)
- Password hashé bcrypt (cost 10), stocké en `password_hash`
- `device_group` calculé une fois et inséré dans `device_group_assignments` (variant Amplitude si dispo, sinon hash modulo `DEVICE_GROUP_HASH_SALT` parmi `[control, test_a, test_b]`)
- Retour : `201 { user_id, email }`. **Pas** de tokens — le client appelle ensuite `/auth/login`.

### `POST /auth/login` (1er lancement app mobile + à chaque expiration refresh)
Body : `{ email, password }`
- Public, rate-limit 10/min/IP
- Lookup case-insensitive sur `LOWER(email)`. bcrypt.compare lancé sur un hash factice si le user n'existe pas → temps de réponse constant pour empêcher l'énumération d'emails.
- Retour : `200 { user_id, access_token, refresh_token, device_group, config_version }`
- `config_version` = version active du groupe (peut être `null` si aucune config n'est seedée → le client tombe sur ses valeurs par défaut embarquées)
- Refresh token = JWT signé par `JWT_REFRESH_SECRET` (namespace distinct du JWT access). Empreinte bcrypt en DB (avec pré-hash SHA-256 pour contourner la troncature 72 octets) pour invalidation à la rotation.
- Client stocke `access_token`/`refresh_token` en EncryptedSharedPreferences

### Suppression
`DELETE /me` (auth JWT) supprime la ligne `users` complète (PII incluse) + sa ligne `device_group_assignments`. Les `offer_events` et `rides` du user **restent** (sans FK → décision RGPD à finaliser : delete cascade strict, ou anonymisation `user_id = NULL` ?).
