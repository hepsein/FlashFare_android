# android.md — Architecture & détails app Android

> Posture MVP : **l'app est dumb, le backend a tout le cerveau**.
> L'app fait 3 choses : détecter qu'un écran Uber a changé, envoyer l'arbre
> au backend, afficher ce que le backend renvoie. Pas de parser, pas de
> calcul de score, pas de résolution de zone, pas d'orchestration d'APIs
> tierces côté Android.

---

## 1. Vue d'ensemble

Deux projets Android distincts :

| Projet | Rôle | Cycle de vie |
|---|---|---|
| `flashfare-capture` | Outil dev, dump arbre Uber → logcat. Sessions terrain avec Ahmed. | Phase 0-1 uniquement. Jamais distribué. |
| `flashfare-android` | App production : détection écran, dump arbre, overlay, télémétrie. | Phase 2 → ∞ |

`flashfare-capture` est un APK debug minimal qui sert à **constituer une banque de fixtures** (arbres XML/JSON de vrais écrans Uber annotés par Ahmed). Ces fixtures alimenteront les tests du **parser backend** — pas du parser app, qui n'existe pas.

`flashfare-android` partage son squelette AccessibilityService avec capture (`packageNames`, `eventTypes`, parcours d'arbre) — on dérisque deux choses d'un coup.

## 2. Flux runtime

```
[Uber écran change]
       │
       ▼
[AccessibilityService détecte event]
       │
       ▼
[Filtre local binaire : "potentiellement une proposition ?"]
       │ ← règle de détection écran (cf. § 5)
       │
       ├── NON → fin, on ignore
       │
       └── OUI
           │
           ▼
[TreeSerializer → JSON compact de l'arbre]
           │
           ▼
[POST /ride/evaluate { tree, screen_meta }]
           │
           ▼
[Backend parse, score, return { offer_id, display }]
           │
           ▼
[OverlayManager rend display.score / display.verdict / display.color]
           │
           ▼
[State machine : OFFER_VISIBLE, offer_id stocké]
           │
           ▼
[Chauffeur accepte/refuse via Uber]
           │
           ▼
[State machine émet ACCEPTED/REFUSED → POST /events]
```

Si plus tard l'app détecte un écran de course active ou course terminée (via mapping `activity_class → état` en config), elle émet les events `TRIP_STARTED`, `TRIP_ENDED`, `NEXT_OFFER` avec le même `offer_id`.

## 3. Stack

| Outil | Usage |
|---|---|
| Kotlin 2.0 + JDK 21 | Langage |
| AGP 8.7 / Gradle 8.10 | Build |
| AccessibilityService | Lecture arbre Uber Driver |
| Compose 1.7 | UI app (onboarding, login, status, force update) |
| Views XML + ViewBinding | **Overlay uniquement** (Compose dans `WindowManager` overlay = trop lent au cold start, on veut < 200ms) |
| Coroutines + Flow | Async, timeouts |
| Hilt | DI |
| Retrofit + OkHttp + CertificatePinner | HTTP backend |
| Moshi | JSON |
| Room | Queue events offline-safe |
| DataStore Proto | État de session persistant + config locale minimale |
| WorkManager | Flush events + check auto-update |
| Amplitude Android SDK | Télémétrie + heartbeat + alerting |
| Timber | Logs (DEBUG only, strippé en release) |
| JUnit 5 + Robolectric + MockK | Tests |
| Detekt + ktlint | Lint en CI |

**Pas de Crashlytics / Firebase** (risque théorique de fuite vers ML Google). Amplitude couvre le besoin.
**Pas de RxJava** (mode maintenance). Coroutines/Flow.

Cibles : Android 10+ (API 29), Xiaomi MIUI 13+, Samsung One UI 5+, Pixel.

## 4. Composants production (`flashfare-android`)

```
flashfare-android/
├── app/src/main/kotlin/com/assistant/tools/helper/   # package neutre anti-flag
│   ├── App.kt                          @HiltAndroidApp
│   ├── MainActivity.kt                 onboarding + login + status service
│   ├── access/
│   │   ├── FlashFareAccessibilityService.kt   détection + envoi tree au backend
│   │   ├── TreeSerializer.kt           AccessibilityNodeInfo → JSON plat
│   │   └── ScreenSignals.kt            détection binaire "potentiellement proposition"
│   ├── state/
│   │   ├── RideStateMachine.kt         IDLE → OFFER_VISIBLE → TRIP_* → IDLE
│   │   └── SessionStore.kt             DataStore Proto, état persistant
│   ├── overlay/
│   │   ├── OverlayManager.kt           WindowManager add/update/remove
│   │   ├── overlay_view.xml            layout Views + ViewBinding
│   │   └── OverlayRenderer.kt          rend ce que le backend envoie
│   ├── net/
│   │   ├── ApiClient.kt                Retrofit + OkHttp + CertPinning + AuthInterceptor
│   │   ├── ConfigRepository.kt         GET /config — règle détection écran + heartbeat interval
│   │   ├── RideEvaluator.kt            POST /ride/evaluate
│   │   └── EventReporter.kt            POST /events (queue Room + WorkManager)
│   ├── auth/
│   │   ├── AuthRepository.kt           login + refresh + tokens EncryptedSharedPreferences
│   │   └── TokenStore.kt
│   ├── update/
│   │   ├── UpdateChecker.kt            GET /version/latest + DL APK + install
│   │   └── ForceUpdateGate.kt          bloque l'app si version < min_required
│   ├── telemetry/
│   │   ├── Telemetry.kt                wrapper Amplitude
│   │   └── Heartbeat.kt                tick 10min
│   └── di/AppModule.kt
└── build.gradle.kts
```

**~14 fichiers Kotlin** au total. Pas de `parser/`, pas de `calc/`, pas de provider par API tierce, pas de killswitch local : toute la logique métier vit côté backend dans `/ride/evaluate`. Le client se contente de faire de l'accessibility, de l'overlay, de la state machine, du transport HTTP et de la télémétrie.

**Package neutre** `com.assistant.tools.helper` (pas `com.flashfare.*`) : `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES` est lisible par toute app, on évite d'être blacklisté par nom.

## 5. Détection écran de proposition

C'est la **seule logique applicative** côté app. Binaire, sans score de confiance.

### Critères (validés)

| Critère | Source | Stabilité |
|---|---|---|
| `event.packageName == "com.ubercab.driver"` | Android natif | Stable |
| Au moins un viewId du set "racine proposition" présent | À déterminer en capture (Phase 1) | Plus stable que des textes |
| Texte qui match `\d+[,.]\d{2}\s*€` quelque part dans l'arbre | Toujours présent sur les propositions | Stable (format des montants) |

**Pas** d'utilisation des mots `Accepter`/`Refuser` (Uber les change/localise/A/B test). Si les 3 critères passent, l'app envoie l'arbre au backend. Sinon elle ignore.

### Config locale (remote config)

```json
{
  "screen_signals": {
    "package": "com.ubercab.driver",
    "must_have_any_view_id": [
      "com.ubercab.driver:id/some_stable_id"
    ],
    "must_have_text_matching": [
      "\\d+[,.]\\d{2}\\s*€"
    ]
  },
  "trip_active_activity_classes": [
    "com.ubercab.driver.OnTripActivity"
  ],
  "trip_ended_activity_classes": [
    "com.ubercab.driver.TripEndedActivity"
  ],
  "heartbeat_interval_minutes": 10,
  "overlay_dismiss_after_seconds": 10,
  "backend_timeout_ms": 2500
}
```

Tout en remote config sauf valeurs par défaut embarquées. Permet d'ajuster `must_have_any_view_id` ou les class names sans release APK si Uber change quelque chose.

> `backend_timeout_ms = 2500` : enveloppe côté client pour `/ride/evaluate`, qui inclut `getEta` + `getFlightsCount` côté backend dans le même cycle (budget interne backend : p95 < 1500 ms).

### Faux positif → échec gracieux

Si la détection passe sur un écran qui n'est PAS une proposition, l'arbre est envoyé au backend, qui répond `{ is_offer: false }`. L'app ne fait rien, dismiss éventuel overlay. Pas d'overlay erroné affiché.

Coût d'un faux positif : ~1 requête backend + ~5 KB de tree. Acceptable. À surveiller via Amplitude (`backend_says_not_offer` count).

## 6. Contrat `/ride/evaluate`

> Endpoint à implémenter côté backend (nouvelle phase backend, cf. § 14).

### Request

```json
POST /ride/evaluate
Authorization: Bearer <jwt>

{
  "captured_at": "2026-05-12T14:30:00Z",
  "app_version": "0.1.0",
  "tree": {
    "meta": {
      "event_type": "TYPE_WINDOW_CONTENT_CHANGED",
      "window_class": "com.ubercab.driver.SomeActivity",
      "window_title": "..."
    },
    "nodes": [
      { "id": 0, "parent": -1, "class": "FrameLayout", "vid": "com.ubercab.driver:id/root", "text": null, "desc": null, "bounds": [0,0,1080,2400] },
      { "id": 1, "parent": 0, "class": "TextView", "vid": "com.ubercab.driver:id/fare", "text": "18,50 €", "desc": null, "bounds": [40,200,500,280] }
    ]
  }
}
```

Compression : OkHttp `Content-Encoding: gzip` automatique. Tree ~30 KB brut → ~5-10 KB gzippé. OK.

### Response — proposition reconnue, affichage complet

```json
200 OK
{
  "offer_id": "uuid-généré-backend",
  "is_offer": true,
  "display": {
    "show_overlay": true,
    "score": 9.1,
    "verdict": "RENTABLE",
    "label": "✅ RENTABLE",
    "color": "#22C55E",
    "taux_horaire_text": "43€/h",
    "taux_km_text": null
  }
}
```

### Response — proposition reconnue, ETA timeout

```json
200 OK
{
  "offer_id": "uuid",
  "is_offer": true,
  "display": {
    "show_overlay": false,
    "error": "eta_timeout",
    "user_message": "Données indisponibles"
  }
}
```

Backend décide quoi afficher. App est dumb.

### Response — pas une proposition (faux positif local)

```json
200 OK
{
  "is_offer": false
}
```

### Response — killswitch backend actif

```json
200 OK
{
  "is_offer": true,
  "display": { "show_overlay": false }
}
```

Si Ahmed/toi désactivez le pipeline d'évaluation via remote config (parser cassé en attendant fix), le backend renvoie systématiquement `show_overlay: false`. App ne s'inquiète pas.

### Effets de bord backend

- `/ride/evaluate` génère le `offer_id` et persiste **lui-même** un `offer_event` de type `OFFER_VISIBLE` dans la table avec tout le payload calculé (montant, score prédit, eta, flights, etc.). L'app ne pousse jamais OFFER_VISIBLE via `/events` — ce type est rejeté (400) par `/events`.
- `/ride/evaluate` appelle les fonctions internes `getEta()` (cache 60 s + Google) et `getFlightsCount()` (cache 5 min FlightView) en parallèle via `Promise.all`. Pas d'appel HTTP imbriqué — appel direct des fonctions exportées.
- Budget total côté backend : p95 < 1500 ms (parsing + ETA + flights + scoring + insert).

## 7. Overlay

### Affichage

L'app reçoit `display: { show_overlay, score, verdict, color, taux_horaire_text }` et le rend directement. Aucune décision côté app.

| Cas backend | Action app |
|---|---|
| `show_overlay: true, score, verdict, color, taux_h` | Affiche overlay complet |
| `show_overlay: false, error: "eta_timeout"` | Mini-bandeau "Données indisponibles" 2s puis dismiss |
| `show_overlay: false` (killswitch) | Pas d'overlay, rien |
| `is_offer: false` | Pas d'overlay, rien |

### Contraintes techniques

- `TYPE_ACCESSIBILITY_OVERLAY` (Android 8+, géré par AccessibilityService, pas besoin de `SYSTEM_ALERT_WINDOW`)
- Flags `FLAG_NOT_TOUCHABLE | FLAG_NOT_FOCUSABLE` — n'intercepte rien
- Position : haut écran, jamais sur les zones Accept/Refuse Uber
- Auto-dismiss après `overlay_dismiss_after_seconds` (config remote, défaut 10s)
- Dismiss aussi à l'action (event ACCEPTED/REFUSED) ou à la sortie de l'écran

## 8. State machine

Toujours nécessaire pour tracker le `offer_id` actuel et émettre les events de cycle de vie. **Sans intelligence de parsing.**

```
[IDLE]
  │ /ride/evaluate retourne is_offer=true → stocke offer_id
  ▼
[OFFER_VISIBLE] ── 10s sans action → TIMEOUT → POST /events → [IDLE]
  │
  ├── écran disparu sans GOING_TO_PICKUP → REFUSED → POST /events → [IDLE]
  │
  └── écran "course en cours" détecté → ACCEPTED + GOING_TO_PICKUP
        │ (event ACCEPTED émis avec offer_id)
        ▼
  [TRIP_ACTIVE]   ── activity matches trip_active_activity_classes
        │ (event TRIP_STARTED émis)
        │ écran "course terminée"
        ▼
  [TRIP_ENDED]    ── activity matches trip_ended_activity_classes
        │ (event TRIP_ENDED émis avec ended_at)
        │ prochaine OFFER_VISIBLE OU délai > 30 min
        ▼
  [IDLE]          ── NEXT_OFFER (delai_avant_next_min) émis avec previous_offer_id
```

**Détection ACCEPTED/REFUSED** : le chauffeur clique sur Uber, on ne le voit pas directement. On infère :

- Si l'écran de proposition disparaît et qu'on passe vers `trip_active_activity_classes` → ACCEPTED
- Si l'écran de proposition disparaît dans les 10s sans transition vers trip_active → REFUSED
- Si l'écran de proposition reste affiché 10s sans changement → TIMEOUT (Uber a auto-rejeté)

**Garde-fou** : timer 4h sans transition → force `IDLE` + event `STATE_FORCE_RESET`.

État persisté dans DataStore Proto pour survivre aux kills du service.

## 9. Survie du service (Xiaomi MIUI, Samsung One UI)

| Mesure | Pourquoi |
|---|---|
| **Foreground service** avec notif persistante neutre ("Assistant tools actif") | Obligatoire Android 12+, MIUI tue moins facilement les foreground |
| **Battery exemption** : `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` en onboarding | Sinon Doze tue après ~30 min écran éteint |
| **Lock in recents** (MIUI) : étape onboarding manuelle avec screenshots | Sans ça, swipe out depuis Recents = service mort |
| ~~Autostart on boot~~ | **Skippé MVP** : chauffeur ouvre l'app manuellement à chaque shift. Limite : reboot en plein shift = relancer. À mesurer en beta. |
| **Heartbeat Amplitude** toutes les 10 min | Cohort "no heartbeat > 2h pendant heures actives" → alerte. Détection silent kills. |
| **Health-check permissions** au boot de MainActivity | MIUI/Huawei coupent les permissions silencieusement après update système. Revérif à chaque ouverture, alerte si OFF. |

### Coût Amplitude heartbeat

100 chauffeurs × 8h actives × 6 heartbeats/h × 30j = ~144k events/mois. Amplitude free = 10M/mois. Gratuit en pratique.

## 10. Distribution APK et auto-update

### Stratégie

Pas de Play Store (politique restrictive sur AccessibilityService). Distribution direct APK depuis ton serveur, signé par ta clé.

### Composants

1. **Endpoint backend** `GET /version/latest` :
   ```json
   {
     "latest_version": "0.4.2",
     "latest_version_code": 42,
     "min_required_version": "0.3.0",
     "min_required_version_code": 30,
     "apk_url": "https://flashfare.app/apk/flashfare-0.4.2.apk?sig=...&exp=...",
     "release_notes": "Corrections détection écran",
     "force_update": false
   }
   ```
2. **`UpdateChecker.kt`** : au démarrage MainActivity + 1×/jour via WorkManager. Compare `BuildConfig.VERSION_CODE` à `min_required_version_code` et `latest_version_code`.
3. **`ForceUpdateGate.kt`** : si `VERSION_CODE < min_required_version_code` → écran bloquant, bouton unique "Mettre à jour maintenant".
4. **Téléchargement** : `DownloadManager` → APK dans `getExternalFilesDir("apk")` (pas besoin perm storage Android 10+) → `PackageInstaller.Session.commit()`. Permission `REQUEST_INSTALL_PACKAGES`.
5. **Signature** : keystore privé, hors repo, sauvegardé chiffré dans 2 endroits différents. Android refuse automatiquement un APK de signature différente de l'installée → pas de code à écrire.
6. **Hosting** : Cloudflare R2 ou S3 derrière Cloudflare. URL signée TTL 5min anti-scraping.

### Play Protect

Même hors Play Store, Google Play Protect scanne les APK installés. Un APK signé par un dev sans réputation qui demande AccessibilityService **peut** être flag automatiquement. À tester dès la première APK signée sur Pixel + Xiaomi vierges. Pas de mitigation magique.

### Force-update

`min_required_version` permet de bumper en 30 secondes (variant Amplitude ou table backend). Si Uber change la structure d'arbre au point que la détection écran locale ne suffit plus, on pousse un APK qui corrige la règle (ou même un APK qui contient une nouvelle règle en dur en attendant) et on force update.

## 11. Télémétrie via Amplitude

Le backend utilise Amplitude (Experiment + Analytics, cf. `07_backend.md` § Amplitude). Le client Android utilise le même projet Amplitude côté SDK Android.

### Events trackés côté Android

| Event | Quand | Properties |
|---|---|---|
| `app_session_start` | App foreground | `app_version`, `config_version` |
| `service_active` | AccessibilityService onServiceConnected | `device_model`, `android_version`, `manufacturer` |
| `service_stopped_unexpected` | onUnbind sans action user | (rare, signal MIUI kill) |
| `heartbeat` | Toutes les 10 min depuis foreground service | `state`, `session_id` |
| `permission_lost` | Health-check découvre permission OFF | `permission_type` |
| `screen_detected` | Filtre local binaire passe | `app_version` |
| `evaluate_request_sent` | POST /ride/evaluate envoyé | (juste compteur) |
| `evaluate_response_received` | Réponse backend | `is_offer`, `show_overlay`, `latency_ms` |
| `overlay_shown` | OverlayManager.show | `verdict`, `score` |
| `ride_decision` | ACCEPTED/REFUSED/TIMEOUT | `decision`, `score_shown`, `verdict_shown` |
| `evaluate_error` | Erreur réseau ou 5xx backend | `http_status`, `error_type` |
| `update_check_*` | Check / DL / install / error | `from_version`, `to_version` |

Pas de `parse_failed` côté Android — c'est un signal backend (le backend logue ses propres `parse_failed_backend` quand un arbre passe le filtre local mais que le parsing backend échoue).

### Workflow alerte dev

Côté Amplitude :
1. Cohorte `users_high_evaluate_error_24h`
2. Webhook Slack/Discord si taille > N
3. Dashboard "App health" : `evaluate_response_received.is_offer=true` ratio sur `screen_detected`, `latency_ms` p50/p95, `service_stopped_unexpected` par device manufacturer

### Killswitch en pratique

Backend met `evaluator_disabled: true` côté variant Amplitude. Au prochain `/ride/evaluate`, le backend renvoie systématiquement `show_overlay: false`. App n'a même pas besoin d'être notifiée — elle fait ce qu'on lui dit.

## 12. Anti-click — règle dev

Specs côté code, communiquées au dev :

1. L'AccessibilityService est en **lecture seule**. Jamais d'appel à `performAction(...)`, `dispatchGesture(...)`, ni aucune API qui produit un input.
2. Les seules choses qu'il fait : lire l'arbre, afficher un overlay, envoyer des events au backend FlashFare.
3. Code review obligatoire par toi (ou Amor) sur toute PR qui touche `access/` ou `overlay/`.

Pour MVP, règle humaine + revue de code suffisent. Pas de Detekt custom.

## 13. Sécurité

- **Aucune clé API tierce dans l'APK** (Google Maps + FlightView restent backend)
- **Tokens chiffrés** dans EncryptedSharedPreferences (clé maître AndroidKeyStore)
- **CertificatePinner OkHttp** : 2 pins (cert courant + cert de secours)
- **Pas de WebView**
- **Logs Timber en DEBUG only**, strippés en release via R8
- **R8 fullMode** activé en release
- **Permissions minimum** : `BIND_ACCESSIBILITY_SERVICE`, `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `REQUEST_INSTALL_PACKAGES`
- **`<accessibility-service android:packageNames="com.ubercab.driver">`** strict, jamais d'élargissement

### Confidentialité du tree envoyé

Le tree envoyé au backend contient potentiellement le **texte affiché à l'écran** (adresses, noms si Uber les affiche). Ces données sont destinées au backend (la destination alimente le score et le calcul de zone). Disclaimer onboarding :

> *FlashFare capture le contenu affiché de l'écran de proposition Uber (montant, adresses, durées) et l'envoie à son serveur pour calculer le score. Les données restent en France (serveurs Paris).*

**Pas de transmission des trees des autres écrans Uber** — packageNames filter strict + filtre local binaire avant envoi. Seuls les écrans qui ressemblent à une proposition partent au backend.

## 14. Impact côté backend

### Endpoint `/ride/evaluate` (POST, JWT)

Cf. `correction_android.md` à la racine pour la spec backend exhaustive (pipeline, migrations, contraintes, checklist). Résumé du pipeline :

1. Valider request (Zod) : `tree.nodes` array, `tree.meta`, `captured_at` ISO
2. Charger `parser_rules` du `device_group` du user (depuis remote config Amplitude ou `remote_configs` DB)
3. Appliquer `screen_detection` : si fail → retour `{ is_offer: false }` immédiat (court-circuit ETA + flights)
4. Itérer `ride_types`, trouver le match, extraire champs
5. Si extraction des champs requis (`montant`, `pickup_min`, `destination`) échoue → log `parse_failed_backend`, retour `{ is_offer: true, display: { show_overlay: false, error: "parsing_failed" } }`
6. Résoudre zone (CP ou mot-clé aéroport)
7. `Promise.all([getEta(origin, destination), getFlightsCount(airport, eta)])` avec timeout global 1500ms
8. Calculer score (formules `03_calcul.md`)
9. Générer `offer_id` UUID
10. Insérer `offer_event` OFFER_VISIBLE en DB (les champs ride_offer, eta, flights, score_predicted, etc. déjà calculés ici)
11. Retour `{ offer_id, is_offer: true, display: {...} }`
12. `trackEvent` Amplitude `ride_offer_evaluated`

Fichier dédié `src/ride-evaluate.js` (~250 lignes estimées). `/eta` et `/flights/adp` restent comme endpoints debug/admin (non appelés par l'app).

### Migration `009_parser_rules.sql`

Ajouter au seed `cfg-2025-04-001` un champ `parser` :

```json
"parser": {
  "rules_version": "pr-2026-05-001",
  "screen_detection": { "package": "...", "must_have_any_view_id": [...], "must_have_text_matching": [...] },
  "ride_types": [
    { "name": "UBERX_STANDARD", "detection": {...}, "extraction": {...} },
    { "name": "UBER_COMFORT", ... },
    { "name": "UBER_TRIP_RADAR", ... }
  ]
}
```

Valeurs concrètes (viewIds, regex) inconnues aujourd'hui — extraites de la campagne Phase 1.

### Fixtures backend

Les fixtures `flashfare-capture` collectées en Phase 1 sont copiées dans `backend/tests/fixtures/uber/` et alimentent les tests de `/ride/evaluate`. Chaque PR qui modifie la logique de parsing backend rejoue ces fixtures.

### Versioning

- `parser.rules_version` versionne le payload `parser` de remote config
- Code parser backend versionné par git (commit SHA visible dans `/health`)
- Embarqué dans chaque `offer_event` côté DB : `parser_backend_version` (commit SHA) + `parser_rules_version` (du payload Amplitude variant)

## 15. Conventions

- Kotlin official style + ktlint en CI
- MVVM côté UI, Repository pattern côté data, AccessibilityService isolé dans son package
- Pas d'exception silencieusement avalée : catch + fallback explicite + log, ou rethrow
- Conventional Commits
- Branch `main` protégée, PR review obligatoire, CI verte (lint + tests)
- Tags `vX.Y.Z` déclenchent build + signature + upload APK + bump `latest_version` côté backend

---

## Annexe A — Outil de capture (`flashfare-capture`)

Projet Android séparé, jamais en prod, Phase 1 uniquement.

### Architecture

```
flashfare-capture/
├── app/src/main/kotlin/com/flashfare/capture/
│   ├── MainActivity.kt          toggle ON/OFF + status permissions
│   ├── CaptureService.kt        AccessibilityService minimal
│   ├── TreeSerializer.kt        AccessibilityNodeInfo → JSON compact (mutualisé avec prod plus tard)
│   └── LogChunker.kt            split JSON > 3500 chars en chunks logcat
└── app/src/main/AndroidManifest.xml
```

### CaptureService.kt — squelette

```kotlin
class CaptureService : AccessibilityService() {

  private val sessionId = UUID.randomUUID().toString().take(8)
  private val seq = AtomicInteger(0)
  private val debouncer = Debouncer(500L)

  override fun onServiceConnected() {
    serviceInfo = AccessibilityServiceInfo().apply {
      eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED or
                   AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
      feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
      flags = AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS or
              AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
      packageNames = arrayOf("com.ubercab.driver")
      notificationTimeout = 100L
    }
    Log.i(TAG, "[FFC session=$sessionId] service connected")
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent) {
    if (event.packageName != "com.ubercab.driver") return
    debouncer.submit {
      val root = rootInActiveWindow ?: return@submit
      val n = seq.incrementAndGet()
      val tree = TreeSerializer.serialize(root)
      val meta = mapOf(
        "session" to sessionId,
        "seq" to n,
        "ts" to System.currentTimeMillis(),
        "event_type" to AccessibilityEvent.eventTypeToString(event.eventType),
        "window_class" to event.className?.toString()
      )
      LogChunker.emit(TAG, sessionId, n, meta, tree)
    }
  }

  override fun onInterrupt() {}

  companion object { const val TAG = "FFC_DUMP" }
}
```

Le `TreeSerializer` émet un JSON plat (pas nested) :

```json
{
  "meta": { "session": "ab12cd34", "seq": 42, "ts": 1736245200000, "event_type": "TYPE_WINDOW_CONTENT_CHANGED", "window_class": "com.ubercab.driver.SomeActivity" },
  "nodes": [
    { "id": 0, "parent": -1, "class": "FrameLayout", "vid": "com.ubercab.driver:id/root", "text": null, "desc": null, "bounds": [0, 0, 1080, 2400] },
    { "id": 1, "parent": 0, "class": "TextView", "vid": "com.ubercab.driver:id/fare", "text": "18,50 €", "desc": null, "bounds": [40, 200, 500, 280] }
  ]
}
```

Ce JSON est exactement le format attendu par `/ride/evaluate` plus tard — le TreeSerializer du capture sera réutilisé tel quel par l'app de prod.

### Transport via Logcat chunké

Logcat tronque les lignes ~4000 chars. Tree complet 20-50 KB → on chunke :

```
I/FFC_DUMP: [FFC session=ab12cd34 seq=42 chunk=1/12]{"meta":{...},"nodes":[...
I/FFC_DUMP: [FFC session=ab12cd34 seq=42 chunk=2/12]...continuation...
I/FFC_DUMP: [FFC session=ab12cd34 seq=42 chunk=12/12]...end}
I/FFC_DUMP: [FFC session=ab12cd34 seq=42 END]
```

### Script PC `tools/capture.mjs`

Node natif (pas de dep) qui :

1. `adb logcat -c` (clear)
2. Spawn `adb logcat -s FFC_DUMP:I -v raw`
3. Lit stdin ligne par ligne, parse les markers, reassemble par `(session, seq)`
4. Sauve dans `captures/{session}/{seq:04d}.json` à la marque END
5. Optionnellement `adb exec-out screencap -p > captures/{session}/{seq:04d}.png` pour debug visuel

### Workflow session terrain

1. Brancher téléphone USB, USB debug ON, `adb devices` OK
2. Installer `flashfare-capture` debug APK (une seule fois)
3. Ahmed active le service dans Paramètres > Accessibilité
4. Lancer `node tools/capture.mjs` côté PC (écoute)
5. Ahmed se met en ligne sur Uber Driver, prend des courses réelles
6. À chaque proposition, dump automatique
7. Après coup, Ahmed annote chaque dump : `captures/{session}/{seq:04d}.truth.json` :
   ```json
   {
     "is_offer": true,
     "ride_type": "UBERX_STANDARD",
     "montant": 18.50,
     "pickup_min": 6,
     "pickup_km": 2.3,
     "course_km": 12.4,
     "destination": "CDG Terminal 2E"
   }
   ```
   ou `{ "is_offer": false }` pour les écrans non-pertinents
8. Cible : 30+ propositions annotées + 20+ non-propositions
9. Fixtures copiées dans `backend/tests/fixtures/uber/` pour alimenter les tests `/ride/evaluate`
