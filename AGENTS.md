# FlashFare Capture — Instructions agent

## Contexte

Outil dev jetable. Phase 0-1 uniquement. Pas distribué.
Objectif unique : dump l'arbre des vues d'Uber Driver dans logcat, format JSON
plat, à chaque changement d'écran. Utilisé par Ahmed en condition réelle pour
constituer une banque de fixtures qui alimentera le parser backend.

**Posture** : pas de réseau, pas de logique métier, pas de UI au-delà d'un
toggle ON/OFF. Si tu hésites à ajouter quelque chose, c'est qu'il ne faut pas.

## Stack imposée

- Kotlin 2 + JDK 21, AGP 8.7+
- Min SDK 29, Target SDK 34
- AppCompat + ViewBinding **uniquement**
- Pas de Hilt, pas de Retrofit, pas de Room, pas de Compose

## Red lines (jamais)

1. Pas de `performAction(ACTION_CLICK)`, pas de `dispatchGesture`. Service
   lecture seule sur Uber Driver, point.
2. `packageNames="com.ubercab.driver"` strict dans la config service.
3. Pas de scraping d'autres apps.
4. Pas de clé API tierce dans le projet (rien à appeler en Phase 0 de toute
   façon).
5. Pas de log DEBUG en release. Mais ici on est debug-only, donc OK.

## Conventions code

- Un fichier = un sujet (anti-abstraction prématurée).
- Conventional Commits en anglais (`feat:`, `chore:`, `fix:`).
- Lint Detekt/ktlint vert avant commit.

## Fichiers à créer (Phase 0)

```
app/src/main/
├── kotlin/com/flashfare/capture/
│   ├── MainActivity.kt
│   ├── CaptureService.kt
│   ├── TreeSerializer.kt
│   └── LogChunker.kt
├── res/layout/activity_main.xml
├── res/xml/capture_service_config.xml
└── AndroidManifest.xml
```

## Format JSON cible (sortie TreeSerializer)

```json
{
  "meta": {
    "session": "<uuid court>",
    "seq": <int>,
    "ts": <epoch ms>,
    "event_type": "TYPE_WINDOW_STATE_CHANGED" | "TYPE_WINDOW_CONTENT_CHANGED",
    "window_class": "<className de l'event>"
  },
  "nodes": [
    { "id": 0, "parent": -1, "class": "...", "vid": "...", "text": null,
      "desc": null, "bounds": [x1, y1, x2, y2] },
    ...
  ]
}
```

Format strict. Sera réutilisé tel quel par l'app prod et par le backend
`/ride/evaluate`. **Ne dévie pas du schéma.**

## Spec complète

La spec du projet FlashFare global vit dans le repo backend. Les fichiers
clés à consulter en priorité, si présents dans `docs/` ou en project
knowledge :

- `00_contexte.md` (règles transversales 1-14)
- `02_architecture.md` (composants, bonnes pratiques anti-flag)
- `android.md` (architecture cible app prod, format TreeSerializer §
  Annexe A)
- `09_planning_android.md` (planning Phase 0-9, source de vérité pour la
  checklist)
- `SUIVI.md` (état d'avancement, décisions)

## Travail demandé typique

- Génère un fichier précis selon la Phase du planning.
- Respecte les paramètres exacts du manifeste service (eventTypes, flags,
  notificationTimeout=100).
- Avant de proposer une PR, vérifie que les red lines sont respectées.

## Ne pas faire

- Pas de "et si on ajoutait Retrofit/Hilt ?" — c'est un APK jetable.
- Pas de tests unitaires lourds, pas de DI, pas d'architecture clean.
- Pas de README marketing.