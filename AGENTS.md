# FlashFare Android (PROD) — Instructions agent

## Contexte

App Android de production pour chauffeurs Uber. Détecte les écrans de
proposition de course via `AccessibilityService`, envoie l'arbre des vues au
backend `/ride/evaluate`, affiche un overlay avec un score de rentabilité, et
trace le cycle de vie de la course (offer → trip → ended → next).

Posture **dumb-client / backend cerveau** : aucune logique métier côté app
(pas de scoring, pas de résolution de zone, pas d'orchestration d'APIs
tierces). L'app détecte, sérialise, envoie, affiche ce que le backend renvoie.
La logique vit dans le backend (`/ride/evaluate`).

Package neutre `com.assistant.tools.helper` (anti-flag : le nom est lisible par
toute app via `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES`).

## Stack imposée

- Kotlin 2.1 + JDK 21, AGP 9.2+
- Min SDK 29, Target SDK 36
- **UI** : Compose + Material3 (pas de Views XML pour les écrans app, sauf
  overlay)
- **DI** : **manual** (singletons `object Container` + constructor injection).
  Hilt n'est PAS embarqué — l'app reste petite (~25 fichiers Kotlin), un DI
  framework n'est pas justifié.
- **Réseau** : Retrofit + Moshi + OkHttp (+ logging interceptor)
- **Persistance** : Room (queue events offline) + DataStore Preferences
  (session state, tokens). **Pas** de DataStore Proto (codegen complexe pour
  5-6 champs typés)
- **Background** : WorkManager
- **Coroutines** : kotlinx-coroutines-android (Flow / suspend)
- **Télémétrie** : Amplitude (Analytics + Experiment) + Timber
- **Tests** : JUnit 5 (Jupiter) — MockK et Robolectric ajoutés à l'usage
  uniquement (quand un test concret le nécessite)
- **Lint** : Detekt + ktlint (CI bloquant)
- **Codegen** : KSP uniquement (Moshi, Room) — pas de kapt

**Pas** de Crashlytics/Firebase, **pas** de RxJava, **pas** de Hilt, **pas** de
DataStore Proto, **pas** de `dotenv`-like côté Android.

## Red lines (jamais)

1. Pas de `performAction(ACTION_CLICK)`, pas de `dispatchGesture`. Le service
   accessibility est **lecture seule** sur Uber Driver, point.
2. `packageNames="com.ubercab.driver"` strict dans la config service. Pas de
   scraping d'autres apps.
3. Pas de clé API tierce embarquée dans l'APK (Amplitude API key acceptable
   via BuildConfig, isolée du repo).
4. Pas de logique métier côté app (parser, scoring, résolution de zone,
   appels APIs tierces). Si tu hésites à mettre une règle côté app, c'est
   qu'elle doit aller backend.
5. Pas de log DEBUG en release (Timber `DebugTree()` planté uniquement si
   `BuildConfig.DEBUG`).
6. Pas d'overlay dans la zone Accept/Refuse d'Uber (haut écran uniquement).
7. Pas de `FLAG_NOT_TOUCHABLE` retiré sur l'overlay (jamais d'interception
   tactile).

## Conventions code

- Un fichier = un sujet (anti-abstraction prématurée).
- Conventional Commits en anglais (`feat:`, `chore:`, `fix:`).
- Lint Detekt + ktlint vert avant commit (CI bloquant).
- Sous-packages limités à 4 (un par domaine net du code) :
  `access/`, `net/`, `overlay/`, `foreground/`. Le reste vit top-level pour
  éviter les sous-packages à 1-2 fichiers.

## Arborescence (cf. docs/android.md § 4)

```
app/src/main/
├── kotlin/com/assistant/tools/helper/
│   ├── App.kt                            Application + Timber init + Amplitude init
│   ├── MainActivity.kt                   Compose entry point
│   ├── RideStateMachine.kt               IDLE → OFFER_VISIBLE → TRIP_ACTIVE → TRIP_ENDED
│   ├── SessionStore.kt                   DataStore Preferences (current_offer_id, last_transition_ts, …)
│   ├── Telemetry.kt                      wrapper Amplitude (Analytics + Experiment + Heartbeat 10min)
│   ├── Container.kt                      singleton DI manuel (instancie ApiClient, repos, etc.)
│   ├── access/
│   │   ├── FlashFareAccessibilityService.kt
│   │   ├── TreeSerializer.kt             AccessibilityNodeInfo → JSON plat (mutualisé capture)
│   │   ├── LocationProvider.kt           snapshot GPS pour meta.location
│   │   └── ScreenSignals.kt              filtre local binaire score-based
│   ├── net/
│   │   ├── ApiClient.kt                  Retrofit + OkHttp + CertificatePinner + AuthInterceptor
│   │   ├── RideEvaluator.kt              POST /ride/evaluate
│   │   ├── ConfigRepository.kt           GET /config (ETag + cache 6h via DataStore Preferences)
│   │   ├── EventReporter.kt              Room queue pending_events + WorkManager flush
│   │   ├── AuthRepository.kt             login + refresh rotation + TokenStore
│   │   └── UpdateChecker.kt              GET /version/latest + force-update logic
│   ├── overlay/
│   │   ├── OverlayManager.kt             WindowManager + TYPE_ACCESSIBILITY_OVERLAY
│   │   ├── OverlayRenderer.kt            pure function display → ViewState
│   │   └── ForceUpdateGate.kt            Compose plein écran bloquant si VERSION_CODE < min_required
│   ├── foreground/
│   │   └── FlashFareForegroundService.kt foreground specialUse + notif persistante
│   └── ui/theme/Theme.kt                 Material3 AppTheme
└── AndroidManifest.xml
```

`Container.kt` est un `object` singleton qui expose les instances partagées :
```kotlin
object Container {
    val httpClient by lazy { OkHttpClient.Builder()... }
    val retrofit by lazy { Retrofit.Builder()... }
    val apiClient by lazy { ApiClient(retrofit) }
    // ...
}
```
Pas de framework DI. Pour mocker en test : `Container.apiClient = FakeApiClient()`.

## Permissions manifest

- `BIND_ACCESSIBILITY_SERVICE` (sur le service accessibility, octroyée via
  Paramètres)
- `INTERNET` + `ACCESS_NETWORK_STATE`
- `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` (runtime)
- `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_SPECIAL_USE` (déclaratives)
- `POST_NOTIFICATIONS` (runtime API 33+)
- `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
- `REQUEST_INSTALL_PACKAGES` (auto-update APK)

Le foreground service est de type `specialUse` avec `PROPERTY_SPECIAL_USE_FGS_SUBTYPE` = `keep-process-alive-for-accessibility-service`.

## Format JSON cible (sortie TreeSerializer, identique à `flashfare-capture`)

```json
{
  "meta": {
    "schema_version": 1,
    "session": "<uuid court>",
    "seq": <int>,
    "ts": <epoch ms>,
    "event_type": "TYPE_WINDOW_STATE_CHANGED" | "TYPE_WINDOW_CONTENT_CHANGED",
    "window_class": "<className de l'event>",
    "location": {
      "lat": <double>,
      "lng": <double>,
      "accuracy_m": <float>,
      "provider": "fused" | "gps" | "network" | "passive" | "unknown",
      "captured_at": <epoch ms>
    }
  },
  "nodes": [
    { "id": 0, "parent": -1, "class": "...", "vid": null,
      "text": null, "desc": null, "bounds": [x1, y1, x2, y2] },
    ...
  ]
}
```

Format strict — c'est le payload attendu par `POST /ride/evaluate`. **Ne dévie
pas du schéma.** Tout ajout/retrait/renommage de champ dans `meta` ou
`nodes[]` incrémente `TreeSerializer.SCHEMA_VERSION`.

> **Constat acté** : Uber Driver est compilé en release avec R8/ProGuard, qui
> strippe `viewIdResourceName` et `contentDescription`. `vid` et `desc` sont
> donc **null dans 100 % des nodes**. Le parsing backend s'appuie
> exclusivement sur `class` + `text` + `bounds` (cf. `docs/android.md` § 5 +
> § 14, `parser_rules_v1.json` à la racine).

## Build flavors

- `debug` : Timber DebugTree planté, backend = `http://10.0.2.2:3100` (émulateur)
  ou IP LAN
- `release` : Timber strippé, backend = URL prod, ProGuard activé

URL backend exposée via `BuildConfig.BACKEND_URL` (défini en
`buildConfigField` dans `app/build.gradle.kts`).

## Spec complète

Fichiers clés (`docs/`) :

- `00_contexte.md` — règles transversales 1-14
- `01_produit.md` — vision produit + onboarding
- `02_architecture.md` — composants, bonnes pratiques anti-flag, flux
- `android.md` — architecture cible app prod, contrat `/ride/evaluate`,
  télémétrie, Annexe A = format TreeSerializer
- `03_calcul.md` — formules de score (côté backend)
- `04_zones.md` — résolution zone (côté backend)
- `05_apis.md` — APIs tierces (côté backend)
- `06_data.md` — schéma DB + remote config + heartbeat
- `07_backend.md` — stack backend + Amplitude
- `08_planning_backend.md` — phases backend
- `09_planning_android.md` — phases Android (source de vérité checklist)
- `correction_android.md` — spec pipeline `/ride/evaluate`
- `GUIDE.md` — parcours chauffeur
- `SUIVI.md` — historique d'évolution (seul journal daté)
- `parser_rules_v1.json` à la racine — seed du payload `parser` de remote
  config, dérivé de `tools/parse/ride.mjs` du repo capture

## Travail demandé typique

- Génère un fichier précis selon la Phase du planning
  (`09_planning_android.md`).
- Respecte la stack imposée et les red lines.
- Avant de proposer une PR : lint Detekt + ktlint vert, tests verts,
  vérification que les red lines sont respectées.

## Ne pas faire

- Pas de scoring/parsing/résolution de zone côté app (= règle 5).
- Pas de Crashlytics/Firebase (risque ML Google).
- Pas de RxJava (mode maintenance).
- Pas de kapt (KSP uniquement).
- Pas de README marketing — `docs/01_produit.md` couvre la vision.
- Pas de tests E2E lourds sans valeur immédiate.
