# correction_android.md — Changements backend pour la phase Android

> Analogue à `correction.md` (qui couvrait la migration Amplitude).
> Ce fichier liste les évolutions à apporter au backend pour entrer en phase
> avec la posture **app dumb / backend cerveau** définie dans `android.md` et
> `09_planning_android.md`.
>
> Lire avant d'attaquer le code : `android.md` § 6 (contrat `/ride/evaluate`),
> § 8 (state machine), § 14 (impact backend), et `09_planning_android.md`
> Phase 2 (checklist tâches backend).

---

## Décision

L'app Android est **dumb** : elle capture l'arbre de vues d'Uber Driver, l'envoie
au backend, affiche ce que le backend renvoie. Toute la logique métier
(parser de l'arbre, scoring, résolution de zone, appel Google Maps + FlightView)
bascule côté backend dans une nouvelle route **`POST /ride/evaluate`**.

Conséquences directes pour le backend :

1. Nouvelle route `POST /ride/evaluate` qui orchestre tout le pipeline d'une proposition.
2. Nouveau payload `parser` dans la remote config (`cfg-2025-04-001`).
3. `OFFER_VISIBLE` est désormais **émis par le backend** dans `/ride/evaluate`,
   plus par l'app via `/events`.
4. `/eta` et `/flights/adp` deviennent des **endpoints internes** (debug/admin).
   `/ride/evaluate` appelle directement les fonctions `getEta()` et
   `getFlightsCount()` exportées par `eta.js` et `flights.js` — pas de HTTP imbriqué.
5. Nouvel endpoint `GET /version/latest` (force-update gate Android).
6. Nouvel endpoint admin `POST /admin/version` pour publier une nouvelle APK.

Rien d'autre ne bouge : auth, config (Amplitude + fallback DB), zones, events
(modulo le skip OFFER_VISIBLE doublon), rides, jobs flights — inchangés.

---

## Comment fonctionne `/ride/evaluate`

### Request

```http
POST /ride/evaluate
Authorization: Bearer <jwt>
Content-Encoding: gzip   ← OkHttp envoie gzippé, Fastify décompresse

{
  "captured_at": "ISO-8601",
  "app_version": "0.1.0",
  "tree": {
    "meta": { "event_type": "...", "window_class": "...", "window_title": "..." },
    "nodes": [
      { "id": 0, "parent": -1, "class": "FrameLayout", "vid": "...", "text": null, "desc": null, "bounds": [0,0,1080,2400] },
      ...
    ]
  }
}
```

### Pipeline interne

```
1. Zod validate body (tree.nodes array, meta object, captured_at ISO)
2. Charger le payload `parser` depuis la config du user
     - via getConfigVariant(user_id) Amplitude si dispo
     - sinon fallback DB remote_configs.payload.parser
3. Filtre `parser.screen_detection`
     - package match ? must_have_any_view_id présent ? text regex ?
     - SI échec → return { is_offer: false } immédiat (court-circuit, pas d'ETA/flights)
4. Itérer parser.ride_types, trouver le match (premier ride_type dont la
   `detection` passe sur l'arbre)
     - SI aucun match → log parse_failed_backend (level warn)
       → return { is_offer: true, display: { show_overlay: false, error: "parsing_failed" } }
5. Extraire les champs via les viewIds + regex du ride_type
   (montant, pickup_min, pickup_km, course_km, destination)
     - SI extraction échoue sur un champ requis → idem 4
6. Résoudre la zone (mot-clé aéroport prioritaire, sinon lookup CP)
     - airport ∈ {CDG, ORY, BVA} → airport_for_flights
     - airport = LBG → fallback_score 85 inline
     - sinon zone_score lookup table postal_zones
7. Promise.all([
     getEta({ origin, destination }),
     airport_for_flights ? getFlightsCount(airport, eta_arrivee, windows_minutes[airport]) : null
   ]) avec timeout global 1500 ms
     - SI eta timeout → return { is_offer: true, display: { show_overlay: false, error: "eta_timeout", user_message: "Données indisponibles" } }
8. Calculer score composite (formules `03_calcul.md`)
9. Générer offer_id UUID (côté backend)
10. INSERT offer_event de type OFFER_VISIBLE dans la même transaction
    - payload = { ride_offer, eta, flights, score (predicted), overlay_displayed_partial: false }
    - parser_version = `parser.rules_version` (du payload remote config)
    - parser_backend_version = commit SHA du backend (cf. § Versioning ci-dessous)
11. trackEvent Amplitude `ride_offer_evaluated` (fire-and-forget)
12. Return { offer_id, is_offer: true, display: { show_overlay, score, verdict, label, color, taux_horaire_text, taux_km_text } }
```

### Réponses possibles (résumé)

| Cas | Body |
|---|---|
| Proposition reconnue, affichage complet | `{ offer_id, is_offer: true, display: { show_overlay: true, score, verdict, label, color, taux_horaire_text, taux_km_text } }` |
| Proposition reconnue, ETA timeout | `{ offer_id, is_offer: true, display: { show_overlay: false, error: "eta_timeout", user_message } }` |
| Filtre local côté app était un faux positif | `{ is_offer: false }` (pas d'offer_id, pas d'event) |
| Killswitch backend actif | `{ is_offer: true, display: { show_overlay: false } }` |
| Parsing backend a échoué | `{ is_offer: true, display: { show_overlay: false, error: "parsing_failed" } }` |

Budget latence : **p95 < 1500 ms** (parsing + ETA + flights + scoring + INSERT).
À mesurer en charge.

---

## Nouveau fichier : `src/ride-evaluate.js`

Estimé ~250 lignes. Pattern identique aux autres routes (`eta.js`, `flights.js`).

**Exports :**
- `rideEvaluateRoutes(app)` — plugin Fastify qui enregistre `POST /ride/evaluate`
- Helpers internes (parseTree, applyScreenDetection, matchRideType, extractFields) non exportés sauf besoin tests

**Utilise (imports) :**
- `getEta` depuis `eta.js` (à exporter si pas déjà fait)
- `getFlightsCount` depuis `flights.js` (déjà exporté)
- `getConfigVariant` depuis `amplitude.js` + fallback DB via `config.js`
- `sql` depuis `db.js`
- `trackEvent` depuis `amplitude.js`

**Rate-limit :** 60 req/min/user (pattern keyGenerator JWT-decode comme `/eta`).

---

## Migration `009_parser_rules.sql`

Ajoute le champ `parser` au seed `cfg-2025-04-001` via `jsonb_set`.

```sql
-- migrations/009_parser_rules.sql
UPDATE remote_configs
SET payload = jsonb_set(
  payload,
  '{parser}',
  '{
    "rules_version": "pr-2026-05-001",
    "screen_detection": {
      "package": "com.ubercab.driver",
      "must_have_any_view_id": [],
      "must_have_text_matching": ["\\d+[,.]\\d{2}\\s*€"]
    },
    "ride_types": [],
    "trip_active_activity_classes": [],
    "trip_ended_activity_classes": [],
    "heartbeat_interval_minutes": 10,
    "overlay_dismiss_after_seconds": 10,
    "backend_timeout_ms": 2500
  }'::jsonb,
  true
)
WHERE config_version = 'cfg-2025-04-001';
```

Le seed est **volontairement vide** sur `must_have_any_view_id` et `ride_types`
au démarrage : les valeurs concrètes (viewIds, regex) ne seront connues qu'après
la **campagne de capture Phase 1 Android**. Le backend renverra
`{ is_offer: false }` sur 100 % des trees tant que ces tableaux sont vides — ce
qui est le comportement souhaité (kill-switch implicite jusqu'au remplissage).

Une fois la campagne terminée, on remplit `parser_rules_v1.json` à la racine
(cf. `09_planning_android.md` Phase 1.D) puis on bump la `rules_version` et on
re-applique la même migration avec les nouvelles valeurs (ou directement via
Amplitude en prod).

---

## Mise à jour `src/events.js`

Si un client envoie un `OFFER_VISIBLE` via `/events` avec un `offer_id` déjà
inséré par `/ride/evaluate`, le INSERT existant `ON CONFLICT (id) DO NOTHING`
suffit (l'`id` côté DB = `event_id` côté client, les UUIDs sont distincts).
Mais on veut explicitement **empêcher** que l'app envoie un OFFER_VISIBLE en
doublon en plus du POST `/ride/evaluate`. Trois options :

- **Option A** : Zod rejette `type = "OFFER_VISIBLE"` dans `/events` → 400.
  Force l'app à ne plus envoyer cet event. Simple, propre. **Préféré.**
- **Option B** : `/events` accepte mais skip silencieusement les
  `OFFER_VISIBLE` dont l'`offer_id` existe déjà côté DB.
- **Option C** : ne rien changer, laisser le `ON CONFLICT` faire.

→ **Choisir Option A** : interdit explicitement le type `OFFER_VISIBLE` dans
`/events`, retire le variant correspondant du Zod discriminated union, et fait
qu'un client buggé est détecté tout de suite par 400 plutôt que de produire des
events fantômes.

Tous les autres event types (`ACCEPTED, REFUSED, TIMEOUT, TRIP_STARTED,
TRIP_ENDED, NEXT_OFFER`) restent gérés via `/events`.

---

## Nouvel endpoint `GET /version/latest`

Force-update gate (cf. `android.md` § 10 et `09_planning_android.md` Phase 8.A).

```http
GET /version/latest
Authorization: Bearer <jwt>

→ 200 {
    "latest_version": "0.4.2",
    "latest_version_code": 42,
    "min_required_version": "0.3.0",
    "min_required_version_code": 30,
    "apk_url": "https://flashfare.app/apk/flashfare-0.4.2.apk?sig=...&exp=...",
    "release_notes": "Corrections détection écran",
    "force_update": false
  }
```

Source de vérité : table `app_versions` (migration `010_app_versions.sql`) ou
variant Amplitude `flashfare-version`. Choix : **table DB**, plus simple à
auditer et indépendant des SDKs Amplitude. Endpoint admin `POST /admin/version`
pour publier (cf. ci-dessous).

```sql
-- migrations/010_app_versions.sql
CREATE TABLE app_versions (
  version_code              INTEGER PRIMARY KEY,
  version_name              TEXT NOT NULL,
  min_required_version_code INTEGER NOT NULL,
  apk_url                   TEXT NOT NULL,
  apk_sha256                TEXT,
  release_notes             TEXT,
  force_update              BOOLEAN NOT NULL DEFAULT false,
  published_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by              TEXT NOT NULL
);

CREATE INDEX idx_app_versions_published ON app_versions(published_at DESC);
```

`GET /version/latest` retourne la row avec le `version_code` le plus élevé,
plus le `min_required_version_code` de cette même row.

---

## Nouvel endpoint admin `POST /admin/version`

Permet de publier une nouvelle APK (manuel ou via CI). Auth via `X-Admin-Token`
(pattern admin existant).

```http
POST /admin/version
X-Admin-Token: <token>

{
  "version_code": 42,
  "version_name": "0.4.2",
  "min_required_version_code": 30,
  "apk_url": "https://...",
  "apk_sha256": "abc123...",
  "release_notes": "...",
  "force_update": false
}

→ 201 { version_code, published_at }
```

À ranger dans `src/admin.js` (Phase 9 actuelle, à inclure dans le scope admin).

---

## Versioning embarqué dans `offer_events`

Aujourd'hui les rows `offer_events` portent `parser_version` (fourni par le
client). Avec le parser côté backend, on garde la colonne mais sa sémantique
change :

- **Avant** : version du parser embarqué dans l'APK (constante client).
- **Après** : `parser.rules_version` du payload remote config au moment de
  l'évaluation (ex. `pr-2026-05-001`). Permet de rejouer les arbres bruts avec
  d'autres règles si on archive les trees (à voir si on fait).

Nouvelle colonne **optionnelle** : `parser_backend_version` (commit SHA du
backend, lu via `process.env.GIT_SHA` injecté au build). Migration
`011_offer_events_parser_backend_version.sql` :

```sql
ALTER TABLE offer_events
  ADD COLUMN parser_backend_version TEXT;
```

NULLable pour la compat avec les rows existantes. Renseigné par
`/ride/evaluate` à chaque insertion.

---

## Fixtures de test

La campagne de capture Phase 1 Android (cf. `09_planning_android.md` § 1.B–C)
produit des fixtures JSON dans `captures/{session}/{seq}.json` + `.truth.json`.
Elles sont copiées dans `backend/tests/fixtures/uber/` et alimentent
`tests/ride-evaluate.test.js`.

Cible : pour chaque fixture, vérifier que :

- `is_offer=true` → `display.show_overlay=true` + champs corrects vs `.truth.json`
- `is_offer=false` (écrans non-propositions, map, login, paramètres) →
  retour `{ is_offer: false }` (filtre screen_detection rejette bien)

Mock `getEta` et `getFlightsCount` dans ces tests (testés ailleurs).

---

## Renumérotation du planning backend

`08_planning_backend.md` actuel :

| # | Sujet | État |
|---|---|:-:|
| 8 | Admin et calibration v0 | ⬜ |
| 9 | Sécurité, observabilité, déploiement | ⬜ |

Devient :

| # | Sujet | État |
|---|---|:-:|
| 8 | **`/ride/evaluate` + parser backend** | ⬜ |
| 9 | Admin et calibration v0 + `GET /version/latest` + `POST /admin/version` | ⬜ |
| 10 | Sécurité, observabilité, déploiement | ⬜ |

La nouvelle Phase 8 backend est **dépendante** de la Phase 1 capture Android
(fixtures + parser_rules_v1.json). Tant que la campagne n'est pas terminée, on
peut écrire la route + le seed vide + les tests d'infra, mais on ne validera
pas le pipeline d'extraction sur des cas réels.

---

## Checklist tâches backend (à reporter dans `08_planning_backend.md` Phase 8)

- [ ] `migrations/009_parser_rules.sql` — seed vide du champ `parser`
- [ ] `migrations/010_app_versions.sql` — table `app_versions`
- [ ] `migrations/011_offer_events_parser_backend_version.sql` — colonne nullable
- [ ] `src/ride-evaluate.js` — route `POST /ride/evaluate`, pipeline complet
- [ ] Exporter `getEta(origin, destination)` depuis `src/eta.js` si pas déjà
- [ ] Vérifier que `getFlightsCount(airport, eta, windowMinutes)` est exportable proprement depuis `src/flights.js`
- [ ] `src/app.js` — enregistrer `rideEvaluateRoutes`
- [ ] `src/events.js` — retirer `OFFER_VISIBLE` du Zod discriminated union
- [ ] `src/version.js` (nouveau) — route `GET /version/latest`
- [ ] `src/admin.js` — route `POST /admin/version` (à inclure dans le scope Phase 9 admin)
- [ ] `tests/ride-evaluate.test.js` — rejoue les fixtures `tests/fixtures/uber/`
- [ ] `tests/version.test.js` — happy path + min_required + force_update
- [ ] Bench p95 < 1500 ms sur charge légère (10 req/s)

---

## Ce qui ne change PAS

- Auth (register, login, refresh, /me)
- `/config` (continue de servir le payload Amplitude / fallback DB, incluant maintenant le champ `parser`)
- `/zones` (snapshot CP, ETag)
- `/eta` et `/flights/adp` — **endpoints conservés** comme outils debug/admin, le code reste, mais le **contrat client** n'en a plus besoin
- `/events` — sauf le retrait d'`OFFER_VISIBLE` du discriminated union
- Agrégation `rides` (déclenchée par les terminaux REFUSED/TIMEOUT/TRIP_ENDED/NEXT_OFFER, donc inchangée)
- Jobs `node-cron` flights
- Amplitude (Experiment + Analytics)
- Stack : Node 22 + Fastify + postgres-js, pas de TypeScript, pas de Redis

---

## Contraintes

- Stack inchangée — pas de nouvelle dépendance majeure. Si besoin d'un parseur
  HTML/DOM, écrire à la main sur le `tree.nodes[]` plat (JSON déjà parsé). Pas
  de `cheerio` ni équivalent.
- `getConfigVariant` reste **synchrone** mémoire — `/ride/evaluate` doit pouvoir
  charger le `parser` sans appel réseau.
- `trackEvent` Amplitude reste **fire-and-forget** — jamais d'`await` dans la
  route.
- `npm test` vert et `npm run lint` propre après chaque étape.
- Commits atomiques (Conventional Commits) : `feat(backend): POST /ride/evaluate`,
  `feat(backend): GET /version/latest`, etc.

---

## Mises à jour MD à faire pendant l'implémentation

Suivant la règle 1 de `00_contexte.md` (spec-first), chaque tâche backend doit
mettre à jour le MD correspondant **dans le même PR** :

| Fichier | Changement |
|---|---|
| `07_backend.md` | Ajouter `src/ride-evaluate.js`, `src/version.js` dans l'arbo + endpoints dans le tableau + bloc « `/ride/evaluate` » décrivant le pipeline |
| `06_data.md` | Préciser que `OFFER_VISIBLE` est émis par `/ride/evaluate` côté backend, plus par l'app. Ajouter colonne `parser_backend_version` dans `offer_events`. |
| `08_planning_backend.md` | Renumérotation Phases 8/9/10 + checklist tâches |
| `SUIVI.md` | Nouvelle ligne dans la table d'avancement, décisions de phase |

Pas de mise à jour ad-hoc de `01_produit.md`, `02_architecture.md`, `03_calcul.md`,
`04_zones.md`, `05_apis.md`, `09_planning_android.md`, `android.md`, `GUIDE.md` —
ces fichiers sont déjà alignés sur la posture dumb-client à la date d'écriture
de cette correction.
