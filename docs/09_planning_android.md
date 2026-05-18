# 09 — Planning Android (checklist agent)

Format : phase = section, tâche = checkbox courte. Avancer phase par phase. Ne pas commencer N+1 avant que la checklist N soit verte.

## Règles

1. Chaque tâche doit être finissable indépendamment et testable.
2. Si une tâche bloque, passer à la phase suivante non bloquée et noter le blocage.
3. À la fin de chaque phase : commit + push + tests verts.
4. **Posture MVP** : l'app est dumb, le backend a tout le cerveau. Si tu hésites à ajouter de la logique côté app, c'est qu'il faut la pousser côté backend.

---

## Phase 0 — Setup projet capture (`flashfare-capture`)

> Objectif : un APK debug minimal qui dump l'arbre des vues Uber dans logcat dès qu'un écran change. Pas de réseau, pas de logique métier.

- [ ] Créer projet Android Studio `flashfare-capture` (package `com.flashfare.capture`, debug only, jamais signé prod)
- [ ] Min SDK 29, target SDK 34
- [ ] Dépendances minimales : Kotlin stdlib, AppCompat, ViewBinding. Pas de Hilt, pas de Retrofit. C'est un outil jetable.
- [ ] `MainActivity` : 1 toggle ON/OFF + label "Service actif : oui/non" + bouton "Ouvrir Paramètres accessibilité"
- [ ] `CaptureService.kt` : AccessibilityService déclaré dans manifest avec :
  - [ ] `android:packageNames="com.ubercab.driver"`
  - [ ] `eventTypes = TYPE_WINDOW_STATE_CHANGED | TYPE_WINDOW_CONTENT_CHANGED`
  - [ ] `flags = FLAG_INCLUDE_NOT_IMPORTANT_VIEWS | FLAG_RETRIEVE_INTERACTIVE_WINDOWS`
  - [ ] `notificationTimeout = 100`
- [ ] `TreeSerializer.kt` : parcourt `rootInActiveWindow`, produit JSON plat `{meta, nodes[]}` (cf. `android.md` § Annexe A) — `meta.location` inclus
- [ ] `LogChunker.kt` : split JSON > 3500 chars en chunks `[FFC session=X seq=Y chunk=A/B]`, tag `FFC_DUMP`, level INFO
- [ ] `LocationProvider.kt` : `LocationManager.getLastKnownLocation()` snapshot tous providers, retourne `null` si permission absente. Pas de tracking actif (zéro impact batterie).
- [ ] `CaptureForegroundService.kt` : foreground service `dataSync` avec notif persistante "Capture active". Démarré par `MainActivity.onCreate`. Anti-kill Samsung/MIUI sur longues sessions terrain.
- [ ] Health-check accessibility : `MainActivity.onResume` croise `Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES` avec `CaptureService.connected` pour distinguer non-activé / crashé / actif.
- [ ] Debouncer 500ms côté `onAccessibilityEvent` pour éviter le spam quand Uber re-render rapidement
- [ ] Permission `BIND_ACCESSIBILITY_SERVICE` déclarée dans le manifest du service
- [ ] Permissions `ACCESS_FINE_LOCATION` + `ACCESS_COARSE_LOCATION` déclarées dans le manifest, demandées au runtime par `MainActivity`
- [ ] Permissions `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` + `POST_NOTIFICATIONS` (cette dernière demandée runtime API 33+ par `MainActivity`)
- [ ] Test manuel sur device : install sur Pixel/Android, activer accessibility, ouvrir une app dont le package est différent → aucun dump (filtre packageNames OK)
- [ ] Test manuel : ouvrir Uber Driver (sans être en ligne) → dumps apparaissent dans `adb logcat -s FFC_DUMP:I`

**✅ Phase OK quand** : l'app installe, le service s'active, ouvrir Uber Driver génère des dumps `FFC_DUMP` visibles dans logcat.

---

## Phase 1 — Outil PC + campagne de capture

> Objectif : avoir une banque de fixtures réelles annotées par Ahmed. Ces fixtures alimentent les tests du parser backend en Phase 2.

### 1.A — Script PC de collecte

- [ ] Créer `tools/capture/` à la racine du repo FlashFare
- [ ] `tools/capture/capture.mjs` (Node natif, pas de deps) :
  - [ ] `adb logcat -c` au démarrage
  - [ ] Spawn `adb logcat -s FFC_DUMP:I -v raw`
  - [ ] Parser ligne par ligne : extraire `(session, seq, chunk, total)` du header
  - [ ] Buffer par `(session, seq)`, reconstituer le JSON quand `chunk == total`
  - [ ] Sauver dans `captures/{session}/{seq:04d}.json`
  - [ ] Quand marqueur `END` reçu : optionnellement déclencher `adb exec-out screencap -p > captures/{session}/{seq:04d}.png`
  - [ ] Indicateur console à chaque dump sauvé : `[+] session ab12cd34 seq 0042 (3.2 KB, 47 nodes)`
- [ ] `tools/capture/README.md` : workflow Ahmed en 3 étapes max
- [ ] `tools/capture/package.json` minimal (`"type": "module"`)

### 1.B — Sessions terrain avec Ahmed (à planifier)

- [ ] Session 1 : variantes UberX standard (3-5 dumps), heure creuse Paris
- [ ] Session 2 : variantes course longue + aéroport CDG (3-5 dumps), heure de pointe
- [ ] Session 3 : variantes UberX Comfort + Pro si applicable
- [ ] Session 4 : Trip Radar si Ahmed l'utilise
- [ ] Session 5 : multi-stop, surge (si on en croise)
- [ ] **Aussi** : capturer les écrans **trip_active** (course en cours) et **trip_ended** (course terminée) — nécessaires pour la state machine app
- [ ] **À chaque session** : Ahmed annote `captures/{session}/{seq:04d}.truth.json` après coup

### 1.C — Consolidation fixtures

- [ ] Cible : ≥ 30 propositions annotées, ≥ 5 écrans trip_active, ≥ 5 écrans trip_ended, ≥ 20 écrans non-pertinents (map, login, paramètres) pour stresser le faux-positif
- [ ] `tools/capture/validate-fixtures.mjs` : vérifie pour chaque `.json` qu'un `.truth.json` correspondant existe, schéma JSON valide
- [ ] Copier les fixtures dans `backend/tests/fixtures/uber/` (pour Phase 2 backend)

### 1.D — Identification des invariants

> **Pré-requis acté** : Uber Driver est compilé en release avec R8/ProGuard. Les `viewIdResourceName` (`vid`) et `contentDescription` (`desc`) sont strippés — **null dans 100 % des nodes**. L'identification d'écran et l'extraction de champs s'appuient exclusivement sur **`class` + `text` + `bounds`**.

À la main, avec les fixtures :

- [ ] **Valider les features de `screen_detection`** sur l'ensemble des fixtures `is_offer=true` : présence d'un `android.widget.Button` large (≥ 50 % écran) dans la moitié basse, texte matchant `\d+[.,]\d{2}\s*€`, pickup ETA matchant `\d+\s*min\s*\(\s*\d+(?:[.,]\d+)?\s*km\s*\)`, ≥ 2 occurrences de `\d+(?:[.,]\d+)?\s*km`. Seuil cible : ≥ 3/4 features → détecté.
- [ ] **Valider l'extraction par regex** sur les valeurs texte : prix `(\d+[.,]\d{2})\s*€` (préférer le standalone `^\d+[.,]\d{2}\s*€$`), pickup ETA `(\d+)\s*min\s*\(\s*(\d+(?:[.,]\d+)?)\s*km\s*\)`, distance course `^[^0-9]*?(\d+(?:[.,]\d+)?)\s*km[^0-9]*$` (hors pickup), note `^\d[.,]\d{2}$`, adresses `,\s*\d{4,5}\s+[A-Za-zÀ-ÿ]` (1ère = pickup, 2ème = dropoff).
- [ ] **Stratégie `vehicle_type`** : 1er TextView court (< 40 chars) qui n'appartient à aucun pattern structuré. Vérifier que ça donne bien UberX / UberX Priority / Comfort / Electric (et plus) sur les fixtures.
- [ ] **Stratégie `tags`** : tous les TextViews restants qui ne matchent aucun pattern structuré et ne sont pas dans `noise_labels_by_locale` (FR : `Montant net de frais`). Tester sur les fixtures avec "Exclusivité", "Course longue (+30 min)", bonus priority.
- [ ] **Identifier les `window_class`** des écrans trip_active et trip_ended (mapping pour la state machine app).
- [ ] **Générer `parser_rules_v1.json`** à la racine : seed initial du payload `parser` de remote config, dérivé de `tools/parse/ride.mjs`. Stocké pour la Phase 2 backend (seed `cfg-2025-04-001`).

**✅ Phase OK quand** : 30+ fixtures propositions + 5+ trip_active + 5+ trip_ended collectées et annotées, `parser_rules_v1.json` draft écrit et reviewed par toi.

---

## Phase 2 — Backend : endpoint `/ride/evaluate`

> Tâches backend (Phase 8 dans `08_planning_backend.md` + spec exhaustive dans `correction_android.md`). Listées ici pour visibilité de la dépendance Android : la Phase 4 Android ne peut pas être validée sans cette route backend.

Tâches backend résumées :

- [ ] Migration `009_parser_rules.sql` : ajout du champ `parser` au payload `cfg-2025-04-001` (jsonb_set avec le contenu de `parser_rules_v1.json`)
- [ ] `src/ride-evaluate.js` :
  - [ ] Route `POST /ride/evaluate`, JWT requis, rate-limit 60/min/user
  - [ ] Zod : `tree.nodes[]`, `tree.meta`, `captured_at`, `app_version`
  - [ ] Charger `parser` depuis config du user
  - [ ] Filtre `screen_detection` → short-circuit si fail
  - [ ] Applique les règles `extraction` du parser (regex texte + filtres structurels class/bounds), `vehicle_type` dérivé au runtime
  - [ ] `Promise.all([getEta(), getFlightsCount()])` timeout 1500ms
  - [ ] Calcule score (réutilise les formules existantes)
  - [ ] INSERT `offer_event` OFFER_VISIBLE dans la même transaction
  - [ ] Génère `offer_id` UUID
  - [ ] Retour `{ offer_id, is_offer, display }`
  - [ ] trackEvent Amplitude `ride_offer_evaluated`
- [ ] Tests `tests/ride-evaluate.test.js` :
  - [ ] Rejouer **toutes** les fixtures de `tests/fixtures/uber/`
  - [ ] Pour chaque `is_offer=true` : `display.show_overlay=true` + champs corrects
  - [ ] Pour chaque `is_offer=false` (écrans non-propositions) : retour `{is_offer: false}` (validation que le filtre `screen_detection` rejette bien)
  - [ ] Mock `getEta` et `getFlightsCount` (testés ailleurs)
- [ ] Mettre à jour `events.js` : si un `OFFER_VISIBLE` arrive via `/events` avec un `offer_id` qui existe déjà (créé par `/ride/evaluate`), DO NOTHING. Évite la double insertion.
- [ ] Optionnel : retirer `/eta` et `/flights/adp` du contrat client (déprécié mais maintenu pour debug/admin)

**✅ Phase OK quand** : `npm test` passe avec 100% des fixtures vertes côté backend, latence p95 < 1500ms en charge légère.

---

## Phase 3 — Setup projet production (`flashfare-android`)

> Objectif : squelette projet production, package neutre, dépendances en place. Pas de logique métier encore.

- [ ] Créer projet Android Studio `flashfare-android`, package `com.assistant.tools.helper`
- [ ] Min SDK 29, target SDK 34, JDK 21, Kotlin 2.0
- [ ] Dépendances : Compose BOM + Material3, Retrofit + Moshi (KSP codegen) + OkHttp logging, Coroutines, Room (KSP codegen), DataStore Preferences, WorkManager, Timber, Amplitude Analytics + Experiment, JUnit Jupiter. **Pas** de Hilt (manual DI via `object Container`), **pas** de DataStore Proto, **pas** de MockK / Robolectric (ajoutés à l'usage)
- [ ] Detekt + ktlint configurés en CI
- [ ] Arbo packages : `access/`, `net/`, `overlay/`, `foreground/` + `ui/theme/`. Le reste vit top-level (App, MainActivity, Container, RideStateMachine, SessionStore, Telemetry). Cf. `android.md` § 4.
- [ ] `MainActivity` minimale Compose : écran "FlashFare — Service inactif" + bouton "Activer accessibilité" qui ouvre `Settings.ACTION_ACCESSIBILITY_SETTINGS`
- [ ] Manifest : permissions `INTERNET`, `ACCESS_NETWORK_STATE`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`, `POST_NOTIFICATIONS`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `REQUEST_INSTALL_PACKAGES`, `BIND_ACCESSIBILITY_SERVICE`, `ACCESS_FINE_LOCATION`, `ACCESS_COARSE_LOCATION`
- [ ] Build flavors : `debug` (logs ON, backend `http://10.0.2.2:3100` pour émulateur ou `http://192.168.x.x:3100` pour device), `release` (logs OFF, backend prod)
- [ ] `BuildConfig.VERSION_CODE` accessible partout
- [ ] CI GitHub Actions : lint + tests + build APK debug sur PR

**✅ Phase OK quand** : APK debug installe, MainActivity s'ouvre, lien Settings accessibilité fonctionne, CI verte sur PR de base.

---

## Phase 4 — AccessibilityService + filtre local + intégration `/ride/evaluate`

> Le cœur de l'app : détecter, dump, envoyer, afficher.

- [ ] `access/FlashFareAccessibilityService.kt` :
  - [ ] Manifest avec `packageNames="com.ubercab.driver"`, eventTypes minimaux
  - [ ] Debouncer 500ms (réutilisé du capture)
  - [ ] Sur event Uber → appelle `ScreenSignals.shouldEvaluate(tree)` → si vrai → lance call backend
- [ ] `access/TreeSerializer.kt` : reprend code du capture, légère adaptation (gestion erreurs propre, suppression Log.i de debug)
- [ ] `access/LocationProvider.kt` : reprend code du capture (`LocationManager.getLastKnownLocation()` snapshot). Pour la prod, envisager FusedLocationProviderClient (Google Play Services) pour fixes plus précis et la latence sub-seconde.
- [ ] `access/ScreenSignals.kt` :
  - [ ] Input : `List<FlatNode>` + `ScreenSignalsConfig` (issue de remote config)
  - [ ] Calcule un score multi-features (présence Button bas large, regex prix €, regex pickup ETA, ≥ 2 occurrences km) ; seuil par défaut 3/4
  - [ ] Retour `Boolean`
  - [ ] Tests JUnit avec fixtures du capture (les fixtures `is_offer=true` doivent passer, `is_offer=false` doivent échouer)
- [ ] `net/ApiClient.kt` : Retrofit + OkHttp + `CertificatePinner` (pins prod via BuildConfig, pas en dev) + `AuthInterceptor` + gzip activé
- [ ] `net/RideEvaluator.kt` :
  - [ ] `evaluate(tree: TreeDump, capturedAt: Instant, appVersion: String): EvaluateResult`
  - [ ] `withTimeoutOrNull(config.backend_timeout_ms)` côté coroutine
  - [ ] Retour : `{ offer_id, is_offer, display }` ou `null` si timeout/erreur
  - [ ] Track Amplitude `evaluate_request_sent` avant + `evaluate_response_received` après (avec latency_ms)
- [ ] `net/ConfigRepository.kt` :
  - [ ] GET `/config` avec ETag depuis SharedPreferences
  - [ ] Cache en mémoire + persistance DataStore
  - [ ] Fetch au démarrage + toutes les 6h via WorkManager
  - [ ] Valeurs par défaut embarquées si pas de cache + pas de réseau
- [ ] `overlay/OverlayManager.kt` :
  - [ ] `show(display: BackendDisplay)` : crée overlay avec `WindowManager` + `TYPE_ACCESSIBILITY_OVERLAY`
  - [ ] Flags `FLAG_NOT_TOUCHABLE | FLAG_NOT_FOCUSABLE`
  - [ ] Position haut écran (hors zone Accept/Refuse)
  - [ ] Auto-dismiss après `config.overlay_dismiss_after_seconds`
  - [ ] `showError(message: String)` : mini-bandeau 2s puis dismiss (cas `eta_timeout`)
  - [ ] `dismiss()` : retire l'overlay
- [ ] `overlay/overlay_view.xml` Views XML : background arrondi, TextView score, TextView verdict, TextView taux €/h, couleur de fond dynamique
- [ ] `overlay/OverlayRenderer.kt` : pure function `BackendDisplay → ViewState` (pour tester sans WindowManager)
- [ ] Wiring complet dans `FlashFareAccessibilityService` : screen detected → tree serialized → evaluate sent → display received → overlay shown
- [ ] Tests intégration :
  - [ ] Mock backend avec MockWebServer
  - [ ] Fixture proposition envoyée → vérifier que `RideEvaluator` est appelé avec le bon body
  - [ ] Mock backend renvoie display complet → vérifier overlay state attendu
  - [ ] Mock backend renvoie `is_offer: false` → vérifier pas d'overlay
  - [ ] Mock backend timeout → vérifier mini-bandeau erreur

**✅ Phase OK quand** : sur device branché USB + backend `npm run dev` + fixture rejouée, le flow complet fonctionne : screen → evaluate → overlay correct.

---

## Phase 5 — Auth + login + force-update

- [ ] `auth/AuthRepository.kt` :
  - [ ] `login(email, password)` POST `/auth/login` → stocke tokens dans EncryptedSharedPreferences + `device_group` + `config_version`
  - [ ] `refresh()` POST `/auth/refresh` avec rotation
  - [ ] Auto-refresh sur 401 via `AuthInterceptor` OkHttp (intercepte 401, refresh, retry)
  - [ ] `logout()` clear local storage
- [ ] `auth/TokenStore.kt` : wrapper sur EncryptedSharedPreferences, clé maître AndroidKeyStore
- [ ] `MainActivity` :
  - [ ] Si pas de tokens → écran login Compose (email + password)
  - [ ] Si tokens présents → écran status (service ON/OFF, dernière proposition, etc.)
- [ ] `update/UpdateChecker.kt` :
  - [ ] GET `/version/latest` au démarrage MainActivity + 1×/jour via WorkManager
  - [ ] Compare `BuildConfig.VERSION_CODE` à `min_required_version_code` et `latest_version_code`
- [ ] `update/ForceUpdateGate.kt` :
  - [ ] Si `VERSION_CODE < min_required_version_code` → écran bloquant Compose plein écran
  - [ ] Bouton unique "Mettre à jour maintenant" → `UpdateChecker.downloadAndInstall()`
  - [ ] Empêche TOUTE autre activité (vérification dans `MainActivity` + chaque démarrage du service)
- [ ] **L'auto-update n'est PAS implémenté côté DL/install dans cette phase** — juste le gate force-update. L'install effective viendra avec la Phase 8 (distribution APK complète).
- [ ] Tests : login OK/KO, refresh rotation, force-update gate triggered

**✅ Phase OK quand** : login email/password fonctionne avec le backend, tokens persistés, force-update gate bloque correctement si version trop basse (testable en modifiant `min_required_version_code` côté backend).

---

## Phase 6 — State machine + events de cycle de vie

> Objectif : tracker le cycle complet d'une course pour alimenter `/events` après OFFER_VISIBLE.

- [ ] `state/RideStateMachine.kt` :
  - [ ] States : IDLE, OFFER_VISIBLE, TRIP_ACTIVE, TRIP_ENDED
  - [ ] Transitions tracées dans Timber (DEBUG)
  - [ ] À OFFER_VISIBLE (reçu de `/ride/evaluate`) : stocke `offer_id` + lance timer 10s
  - [ ] À 10s sans transition → TIMEOUT → POST /events `TIMEOUT` → IDLE
  - [ ] Si écran proposition disparaît AVANT transition vers trip_active → REFUSED → POST /events `REFUSED` → IDLE
  - [ ] Si activity matches `trip_active_activity_classes` → ACCEPTED + TRIP_ACTIVE → POST /events `ACCEPTED`, `TRIP_STARTED`
  - [ ] Si activity matches `trip_ended_activity_classes` → TRIP_ENDED → POST /events `TRIP_ENDED` (avec `ended_at`)
  - [ ] Prochaine OFFER_VISIBLE → NEXT_OFFER avec `previous_offer_id` → IDLE
  - [ ] Garde-fou : timer 4h sans transition → force `IDLE` + event `STATE_FORCE_RESET`
- [ ] `state/SessionStore.kt` : DataStore Proto schéma `current_offer_id`, `current_state`, `last_transition_ts`, `last_offer_visible_at`
- [ ] `net/EventReporter.kt` :
  - [ ] Queue Room `pending_events` (id, payload JSON, retry_count, created_at)
  - [ ] Insertion à chaque transition state machine
  - [ ] Flush via `WorkManager` :
    - [ ] Contrainte `requiresNetwork = true`
    - [ ] Backoff exponentiel
    - [ ] Max 3 retries puis log + drop
    - [ ] Idempotent côté backend (event_id UUID généré client-side)
  - [ ] POST `/events` avec `{ ingestion_batch: UUID, events: [...] }`
  - [ ] Sur succès : DELETE de la queue Room
- [ ] **Détection des écrans trip_active / trip_ended** : ajoutée à `FlashFareAccessibilityService.onAccessibilityEvent` :
  - [ ] Si `event.className` matches `trip_active_activity_classes` → notifier state machine
  - [ ] Idem pour `trip_ended`
- [ ] Tests unitaires state machine : 7 scénarios (refus, timeout, accept→trip_ended→next_offer, force reset 4h, idempotence sur replay event, etc.)
- [ ] Tests intégration : flow complet sur device, vérifier events arrivent en DB côté backend

**✅ Phase OK quand** : sur device + backend live, une course réelle complète (accept → trip → trip_ended → next_offer) génère 5 events bien chaînés dans `offer_events` + une ligne `rides` complète.

---

## Phase 7 — Foreground service + survie MIUI

- [ ] `FlashFareAccessibilityService` devient foreground :
  - [ ] `startForeground(NOTIF_ID, notification)` avec channel `ASSISTANT_STATUS` (importance LOW, pas de son)
  - [ ] Texte notif **neutre** : "Assistant tools actif"
  - [ ] Icône monochrome neutre
  - [ ] Catégorie `FOREGROUND_SERVICE_TYPE_SPECIAL_USE` (Android 14+)
- [ ] Onboarding flow étendu :
  - [ ] Étape 1 : activer accessibilité (deeplink Settings)
  - [ ] Étape 2 : `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` (intent système)
  - [ ] Étape 3 : screenshots MIUI pour "Lock in recents" (manuel)
  - [ ] Étape 4 : screenshots Samsung pour "Sleeping apps" exception (manuel)
  - [ ] Étape 5 : "Tu as un Xiaomi ? Désactive aussi les Smart Power Saving pour FlashFare"
- [ ] `MainActivity.onResume` : `HealthCheckPermission.run()` vérifie accessibility + battery exemption + service connecté ; alerte si une perm est OFF
- [ ] Test sur Xiaomi Redmi (à acheter ou emprunter) : éteindre l'écran 30 min, vérifier que le service tient
- [ ] Test sur Samsung Galaxy : idem
- [ ] **Limite documentée** : pas d'autostart on boot, reboot → relancer manuellement

**✅ Phase OK quand** : service tient ≥ 2h sur Xiaomi + Samsung en conditions réelles (écran éteint à intervalles).

---

## Phase 8 — Distribution APK + auto-update complète

### 8.A — Côté backend

- [ ] Endpoint `GET /version/latest` (auth JWT)
- [ ] Hosting APK : Cloudflare R2 ou S3, URL signée TTL 5min
- [ ] Endpoint admin `POST /admin/version` pour publier (Phase 9 admin backend ou plus tôt si bloquant)

### 8.B — Côté client

- [ ] Keystore prod généré, sauvegardé chiffré dans 2 endroits différents (cloud + offline)
- [ ] CI GitHub Actions : sur push tag `vX.Y.Z` → build release signé → upload sur hosting → POST `/admin/version` pour publier
- [ ] `update/UpdateChecker.kt` étendu :
  - [ ] Téléchargement via `DownloadManager` → APK dans `getExternalFilesDir("apk")`
  - [ ] Vérification basique : taille fichier ≥ X KB
  - [ ] Install via `PackageInstaller.Session.commit()` avec callback
  - [ ] Permission `REQUEST_INSTALL_PACKAGES`
- [ ] Notification "Mise à jour disponible — toucher pour installer" (cas non-force)
- [ ] Tests : check version logic offline / OK / forced

**✅ Phase OK quand** : push tag `v0.1.0` → CI build + upload + bump → device récupère et installe la nouvelle APK sans intervention manuelle.

---

## Phase 9 — Amplitude + heartbeat + alerting

- [ ] `telemetry/Telemetry.kt` :
  - [ ] Init Amplitude au démarrage MainActivity avec `AMPLITUDE_API_KEY` (BuildConfig)
  - [ ] Méthode `track(eventType, props)` wrap Amplitude `track`
  - [ ] No-op si la key est absente (CI debug locale)
  - [ ] Liste d'events implémentée : tous ceux du tableau `android.md` § 11
- [ ] `telemetry/Heartbeat.kt` :
  - [ ] Coroutine lancée par le foreground service
  - [ ] Toutes les `config.heartbeat_interval_minutes` : `track("heartbeat", { state, session_id })`
  - [ ] Annulé proprement quand service stoppé
- [ ] Wiring dans tous les points clés (screen detected, evaluate sent/received, overlay shown, ride decision, etc.)
- [ ] Dashboard Amplitude (manuel) :
  - [ ] Chart `evaluate_response_received` par jour × `is_offer` × `show_overlay`
  - [ ] Chart `evaluate_error` par jour × `http_status`
  - [ ] Funnel `screen_detected → evaluate_request_sent → evaluate_response_received(is_offer=true) → overlay_shown → ride_decision`
  - [ ] Latency p50/p95 sur `evaluate_response_received.latency_ms`
- [ ] Cohort + webhook :
  - [ ] Cohorte `users_high_evaluate_error_24h` (≥ 10 evaluate_error sur 24h)
  - [ ] Webhook Slack/Discord si taille > 5 users

**✅ Phase OK quand** : dashboard Amplitude affiche les events, alerte webhook testable, killswitch backend activable et applicable < 5 min.

---

## Phase 10 — Beta privée + onboarding polish

- [ ] Landing page web : section "Télécharger FlashFare" pour les beta-testers (URL APK initiale, auto-update prend le relais)
- [ ] Onboarding app : 7 écrans Compose avec illustrations
  - [ ] 1. Bienvenue
  - [ ] 2. Comment FlashFare fonctionne (overlay sur Uber, schéma simple)
  - [ ] 3. Disclaimer (cf. `01_produit.md`) avec checkbox d'acceptation explicite + versioning
  - [ ] 4. Login email/password
  - [ ] 5. Permission accessibilité (avec animation)
  - [ ] 6. Permission battery exemption
  - [ ] 7. Permission Lock recents (MIUI/Samsung selon device détecté)
- [ ] Écran status permanent : "Service actif depuis 2h34", dernière proposition vue, dernière décision
- [ ] Écran "Aide" : FAQ + lien contact Telegram/email
- [ ] Recruter 3-5 chauffeurs beta (Ahmed peut aider)
- [ ] Brief beta : disclaimer signé, instructions Telegram pour feedback, mesure pendant 2 semaines
- [ ] Itération : feedbacks beta → fixes → release

**✅ Phase OK quand** : 3 chauffeurs utilisent FlashFare pendant 2 semaines, NPS recueilli > 6, ≥ 1 calibration de zone faite par Ahmed sur la base des données collectées.

---

## Critères de succès MVP

- [ ] Onboarding réussi sans assistance sur Xiaomi + Samsung
- [ ] Détection écran proposition > 95% (mesuré via funnel Amplitude `screen_detected → evaluate is_offer=true`)
- [ ] Overlay affiché < 1.5s après détection (mesuré sur `latency_ms` Amplitude)
- [ ] Service tient ≥ 4h en conditions réelles sur Xiaomi avec écran éteint la moitié du temps
- [ ] Aucun cas `evaluate_error` taux > 5% sur 24h non résolu en 24h
- [ ] Killswitch backend testable et opérationnel en < 5 min
- [ ] Auto-update fonctionne en silencieux quand non-forcé, bloque quand forcé

---

## Bloqueurs externes à débloquer en parallèle

- [ ] Acheter ou emprunter 1 Xiaomi récent + 1 Samsung récent (tests Phase 7)
- [ ] Compte Amplitude finalisé (clés Analytics + Experiment) + droits Ahmed dashboard
- [ ] Compte Cloudflare R2 (ou S3) provisionné pour APK hosting (Phase 8)
- [ ] Domaine pour le hosting APK (sous-domaine du domaine principal)
- [ ] Décider du **canal de support beta-testers** (Telegram groupe ? Discord ?)
- [ ] **Test Play Protect** dès la première APK signée sur Pixel + Xiaomi vierge — sans ça, surprise à la 1ère install des beta-testers
