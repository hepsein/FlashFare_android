# 02 — Architecture

## Vue d'ensemble

Posture : **app dumb, backend cerveau** (cf. `00_contexte.md` § Règles 5).
L'app détecte un écran Uber, envoie l'arbre brut au backend, affiche ce qu'il
renvoie. Toute la logique métier (parser, scoring, zones, APIs tierces) est
côté backend.

- **Client Android** (Kotlin) : capture l'arbre Uber via AccessibilityService, POST `/ride/evaluate`, rend l'overlay, émet events de cycle de vie, state machine
- **Backend** (Node.js JS, Fastify, Postgres) : `/ride/evaluate` (parser + scoring + orchestration ETA/flights), config, zones, ingestion events, agrégation `rides`
- **APIs externes** : Google Maps Routes (ETA + trafic) · FlightView (vols CDG/ORY/BVA, JSON public sans clé) — **appelées exclusivement côté backend**, jamais depuis l'APK

## Stack

### Client
Kotlin 2 · AccessibilityService · Compose + Material3 (UI app) · Views XML (overlay only, cold-start < 200 ms) · **manual DI** (`object Container` singleton, pas de Hilt) · Retrofit + OkHttp + CertificatePinner · Moshi (KSP codegen) · Room (queue events offline) · DataStore Preferences (état session, tokens, ETag config — pas de Proto) · WorkManager · Amplitude Android SDK (Analytics + Experiment) · Timber · JUnit Jupiter (MockK + Robolectric ajoutés à l'usage) · Detekt + ktlint

Cibles : Android 10+ (API 29), Xiaomi MIUI 13+, Samsung One UI 5+, Pixel.

### Backend
Voir `07_backend.md` pour le détail. Stack : Node 22 + `fastify` v5 + `postgres` (postgres-js) + `zod` + `lru-cache` + `node-cron` + `bcryptjs` + Amplitude (Experiment local eval + Analytics). **Pas de TypeScript, pas de Redis, pas de BullMQ, pas d'ORM, pas de `dotenv`** (Node 22 `--env-file` natif).

## Composants client

| Composant | Rôle |
|---|---|
| `FlashFareAccessibilityService` | Détecte écrans Uber Driver, déclenche serialize + POST `/ride/evaluate` |
| `TreeSerializer` | `AccessibilityNodeInfo` → JSON plat `{meta, nodes[]}` |
| `ScreenSignals` | Filtre local binaire (package + score multi-features text+structure) avant envoi |
| `RideEvaluator` | POST `/ride/evaluate`, retourne `{ offer_id, is_offer, display }` |
| `OverlayManager` | Rend le `display` reçu (score, verdict, couleur, taux) |
| `RideStateMachine` | IDLE → OFFER_VISIBLE → TRIP_ACTIVE → TRIP_ENDED → IDLE |
| `SessionStore` | DataStore Proto, état session persistant |
| `EventReporter` | Queue Room + WorkManager flush (events ACCEPTED/REFUSED/TIMEOUT/TRIP_*/NEXT_OFFER) |
| `ConfigRepository` | GET `/config` au démarrage + 6h, ETag, cache DataStore |
| `AuthRepository` | login email/password, refresh rotation, EncryptedSharedPreferences |
| `UpdateChecker` + `ForceUpdateGate` | GET `/version/latest`, gate bloquant si `VERSION_CODE < min_required` |
| `Telemetry` + `Heartbeat` | Wrapper Amplitude, heartbeat 10 min depuis foreground service |
| `MainActivity` | Onboarding Compose, login, status service, force-update gate |

**Pas de parser, pas de calcul de score, pas de résolution de zone, pas
d'orchestration d'APIs tierces côté Android** — tout ça vit dans
`/ride/evaluate` backend. Détail : `android.md`.

## Bonnes pratiques anti-flag

| Pratique | Raison |
|---|---|
| Nom package neutre (`com.assistant.tools.helper`) | `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES` lisible par toute app, éviter blacklist nom |
| Label service générique ("Assistant tools") | Idem |
| `packageNames=["com.ubercab.driver"]` strict | Économie batterie, pas de scraping autres apps |
| `eventTypes` minimal : `WINDOW_STATE_CHANGED \| WINDOW_CONTENT_CHANGED` | Réduit charge |
| `notificationTimeout=100ms` | Coalescer les events |
| Pas de `getRootInActiveWindow` en boucle | Détectable thermique/CPU |
| **Pas d'auto-clic, jamais** (`performAction(ACTION_CLICK)`) | Red line absolue |
| Overlay positionné hors zone Accept/Refuse (haut écran) | Évite `setHideOverlayWindows` |
| `FLAG_NOT_TOUCHABLE \| FLAG_NOT_FOCUSABLE` | N'intercepte rien |
| Pas de scraping autres apps | Catastrophe si fuite |
| Health-check permission au wake-up | Xiaomi/Huawei coupent le service silencieusement |
| Logs DEBUG off en release | Perf + discrétion |

**Risque résiduel non maîtrisable** : un chauffeur qui accepte 100% > seuil et refuse 100% < seuil sera flag par les modèles anti-fraude Uber via stats d'acceptation. Disclaimer onboarding obligatoire.

## Plan exploration Uber (avant dev parser)

### Outils
- `adb shell uiautomator dump` (capture arbre)
- AccessibilityService de logging dédié dev (dump JSON dans Logcat)
- `scrcpy` (mirror écran)
- Maestro Studio pour explorer écrans secondaires Uber. **Limite** : Maestro ne fait pas apparaître de propositions à la demande.

### FLAG_SECURE — vérification J0
```bash
adb shell screencap -p /sdcard/test.png && adb pull /sdcard/test.png
```
Si noir → FLAG_SECURE actif. Pas bloquant : AccessibilityService voit toujours l'arbre.

### Variantes à capturer (3-5 dumps chacune, avec Ahmed)
UberX standard, course longue, course aéroport, Trip Radar, UberX/Comfort/Pro, surge, multi-stop.

Stockage : XML dump + JSON vérité (montant, pickup, etc.) pour tester le parser en regression.

## Flux d'une proposition

1. AccessibilityService détecte event sur `com.ubercab.driver`
2. `ScreenSignals.shouldEvaluate(tree)` — filtre local binaire (package + score multi-features text+structure, seuil ≥ 3/4 : bouton bas large, prix €, pickup ETA, ≥ 2 occurrences km). Si faux, on ignore. Si vrai :
3. `TreeSerializer` produit un JSON plat `{meta, nodes[]}` de l'arbre
4. `RideEvaluator` POST `/ride/evaluate` avec le tree (timeout coroutine 2500 ms, gzip)
5. Backend : applique `screen_detection`, match `ride_type`, extrait montant/pickup/destination, résout zone, `Promise.all([getEta, getFlightsCount])` timeout 1500 ms, calcule score, génère `offer_id`, INSERT `offer_event` OFFER_VISIBLE, retour `{ offer_id, is_offer, display }`
6. App : `RideStateMachine` passe `IDLE → OFFER_VISIBLE`, stocke `offer_id`
7. App : `OverlayManager.show(display)` rend overlay (ou mini-bandeau d'erreur, ou rien si killswitch / faux positif)
8. Décision chauffeur via Uber (jamais via FlashFare) — état inféré :
   - écran disparu vers `trip_active_activity_classes` → ACCEPTED
   - écran disparu sans transition trip_active → REFUSED
   - écran resté 10 s sans changement → TIMEOUT
9. App POST `/events` avec ACCEPTED/REFUSED/TIMEOUT
10. Si ACCEPTED : transitions TRIP_STARTED, TRIP_ENDED, NEXT_OFFER → POST `/events` à chaque terminal
11. Backend agrège dans `rides` à chaque event terminal

## Machine à états client

```
[IDLE]
  │ /ride/evaluate retourne is_offer=true → offer_id stocké
  ▼
[OFFER_VISIBLE] ── 10s sans action → TIMEOUT → POST /events → [IDLE]
  │
  ├── écran disparu sans trip_active → REFUSED → POST /events → [IDLE]
  │
  └── activity matches trip_active_activity_classes → ACCEPTED
        │ (event ACCEPTED + TRIP_STARTED émis)
        ▼
  [TRIP_ACTIVE]
        │ activity matches trip_ended_activity_classes
        ▼
  [TRIP_ENDED]   ── POST /events TRIP_ENDED (ended_at)
        │ prochaine OFFER_VISIBLE OU délai > 30 min
        ▼
  [IDLE]         ── POST /events NEXT_OFFER (previous_offer_id, delai_avant_next_min)
```

Garde-fou : timer 4 h sans transition → force `IDLE` + event `STATE_FORCE_RESET`.
État persisté dans DataStore Proto pour survivre aux kills du service.

Le client est volontairement bête : il pousse des events plats. **L'agrégation
est côté backend** (table `rides`, réversible via `npm run rebuild-rides`).

## Schéma event (envoi backend)

```json
{
  "event_id": "uuid",
  "offer_id": "uuid",
  "type": "ACCEPTED | REFUSED | TIMEOUT | TRIP_STARTED | TRIP_ENDED | NEXT_OFFER",
  "timestamp": "ISO-8601",
  "user_id": "uuid",
  "device_group": "control",
  "app_version": "0.1.0",
  "config_version": "cfg-2025-04-001",
  "parser_version": "pr-2026-05-001",
  "payload": { /* dépend du type */ }
}
```

> `OFFER_VISIBLE` n'est plus émis par l'app : il est inséré par le backend lui-même dans `/ride/evaluate` avec tout le payload (ride_offer, eta, flights, score_predicted).

### Payloads

**ACCEPTED / REFUSED / TIMEOUT** : `{ "reaction_ms": 4200 }` ou vide
**TRIP_STARTED** : `{ "started_at": "ISO-8601" }`
**TRIP_ENDED** : `{ "ended_at": "ISO-8601", "duree_reelle_min": 31 }`
**NEXT_OFFER** : `{ "previous_offer_id": "uuid", "delai_avant_next_min": 7 }`

### Payload `OFFER_VISIBLE` inséré par `/ride/evaluate`

```json
{
  "ride_offer": {
    "montant_eur": 18.50, "pickup_min": 6, "pickup_km": 2.3, "course_km": 12.4,
    "destination_postal_code": "95700", "destination_zone_type": "AEROPORT_ADP_CDG",
    "zone_score_applied": 92
  },
  "eta": { "source": "google_maps", "duree_min": 28 },
  "flights": { "source": "flightview", "count": 14, "window_minutes": 50 },
  "score": { "composite": 7.2, "taux_horaire": 28.4, "taux_km": 1.26, "verdict": "RENTABLE" },
  "overlay_displayed_partial": false
}
```

## Endpoints (vue synthétique)

| Endpoint | Méthode | Usage |
|---|---|---|
| `/users/register` | POST | Inscription landing (email/password + PII : nom, prénom, téléphone, adresse) |
| `/auth/login` | POST | Login email + password → JWT + config |
| `/auth/refresh` | POST | Rotation JWT |
| `/config` | GET | Remote config (ETag) — inclut `parser` (règles parser backend) |
| `/zones` | GET | Snapshot zones IDF (ETag) |
| `/ride/evaluate` | POST | **Pipeline complet d'une proposition** : parse tree, score, INSERT OFFER_VISIBLE, retour `{ offer_id, is_offer, display }` |
| `/eta` | POST | Proxy Google Routes (TRAFFIC_AWARE) — outil debug/admin, appelé en interne par `/ride/evaluate` |
| `/flights/adp` | GET | Vols CDG/ORY/BVA via FlightView — outil debug/admin, appelé en interne par `/ride/evaluate`. LBG hors scope → fallback inline 85 |
| `/events` | POST | Bulk events de cycle de vie (ACCEPTED/REFUSED/TIMEOUT/TRIP_*/NEXT_OFFER) + agrégation `rides` synchrone post-terminaux |
| `/version/latest` | GET | Force-update gate Android |
| `/admin/*` | divers | Édition zones, config, métriques, publication APK |

Détail dans `07_backend.md`. Contrat `/ride/evaluate` dans `android.md` § 6.

## Permissions Android

`BIND_ACCESSIBILITY_SERVICE` · `INTERNET` · `ACCESS_NETWORK_STATE` · `FOREGROUND_SERVICE` · `FOREGROUND_SERVICE_SPECIAL_USE` · `POST_NOTIFICATIONS` (Android 13+) · `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` · `REQUEST_INSTALL_PACKAGES`

> L'overlay utilise `TYPE_ACCESSIBILITY_OVERLAY` (Android 8+, géré par l'AccessibilityService) — pas besoin de `SYSTEM_ALERT_WINDOW`.

## Sécurité

- Aucune clé API tierce dans l'APK (proxy backend)
- JWT signé, rotation refresh single-use
- Pinning certificat backend côté client (recommandé)
- Inscription via la landing web uniquement (pas de création depuis l'app) → PII collectée en clair HTTPS, password bcrypt en DB
- `user_id` est un UUID (pas d'ID Uber/Google/IMEI exposé dans l'APK)

## Conventions code

- Kotlin : ktlint en CI
- MVVM côté UI, Repository pattern data
- Timber, DEBUG off en release
- Pas d'exception ignorée (catcher avec fallback explicite ou propager)
- Conventional Commits
