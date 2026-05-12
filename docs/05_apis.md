# 05 — Intégrations API

2 APIs externes, **toutes appelées côté backend** (jamais côté client = pas de clés dans l'APK, règle 8 de `00_contexte.md`). Les routes proxy `/eta` et `/flights/adp` existent comme outils de debug/admin ; en routine c'est `/ride/evaluate` qui appelle directement les fonctions `getEta()` et `getFlightsCount()` exportées.

| Usage | Source | Fallback API down |
|---|---|---|
| ETA temps réel | Google Maps Routes | `display.show_overlay: false` + `error: "eta_timeout"` |
| Vols CDG / ORY / BVA | FlightView (public JSON) | Score zone = `flights.fallback_score` (85) |
| Vols LBG | non couvert | Score zone = `flights.fallback_score` (85) inline |

> **Distinction critique** : "API down" ≠ "0 vol".
> - API down → fallback 85
> - 0 vol → tier "0 vol" du barème (info valide)

## 1. Google Maps Routes (ETA)

### Tarifs
- Compute Routes Basic : 5 USD / 1000 req
- Compute Routes Advanced (avec trafic) : 10 USD / 1000 req

### Intégration
- Clé en variable d'env backend
- `/ride/evaluate` appelle `getEta(origin, destination)` exporté par `src/eta.js`
- La route `POST /eta` reste exposée comme outil debug/admin
- Timeout 1500 ms (remote config `fallback_timeout_ms`)

### Cache
In-memory LRU 60s sur clé `(originRounded, destRounded, timeBucket5min)`. **Critique pour les coûts** : sans cache, factures Google explosent.

### Estimation coûts
100 chauffeurs × 30 propositions/j × 30j ≈ 90 000 req/mois
- Basic : ~450 USD/mois
- Advanced : ~900 USD/mois

Rate limit par device : 60 req/min minimum.

## 2. FlightView — vols CDG / ORY / BVA

Endpoint JSON public : `GET https://app-api.flightview.com/api/airport/{IATA}/arrivals`. **Pas de clé d'API, pas de quota documenté**. Latence observée : 100–400 ms par appel.

### Format de réponse
Array d'objets arrivée. Champs utilisés :
- `airlineCode` + `flightNumber` → `flight_number` canonique (ex. `AF1234`)
- `flightDate` (`YYYY-MM-DD`) + `scheduledTime` (`HH:MM` local Europe/Paris) → `scheduled_at` (UTC reconstruit)
- `updatedTime` (idem) → `estimated_at` (heure ré-estimée si retard)
- `airportCode` → aéroport d'origine
- `displayStatus` → statut texte (`Arrived`, `On Time`...)

### Conversion timezone
Les heures FlightView arrivent en local Paris sans offset. Le parser reconstruit l'instant UTC en testant les 2 offsets DST possibles (`+01` hiver, `+02` été) via round-trip `Intl.DateTimeFormat` → garde celui dont le formatage local correspond à l'entrée.

### Logique de comptage
```
fenêtre = [ETA_arrivée - window_minutes[airport], ETA_arrivée]
filtrer flights_cache par aéroport et fenêtre
retourner count
```

### Refresh
Job node-cron toutes les 5 min × 3 aéroports : pull FlightView → upsert `flights_cache` avec `source='flightview'` + `fetched_at=now()`. Pas d'appel FlightView par requête utilisateur. Si `MAX(fetched_at) > 30 min` (6 cron consécutifs en échec) → la route retourne `{source: 'default'}` et le client utilise `flights.fallback_score: 85`.

### Cas LBG (Le Bourget)
Pas dans le catalogue FlightView (aviation d'affaires majoritaire, faible volume passagers commerciaux). La route `/flights/adp?airport=LBG` renvoie **400** (Zod enum bloque les aéroports non couverts). Côté client, le score zone aéroport bascule directement sur `flights.fallback_score: 85`.

## Fenêtres temporelles par aéroport

```json
"windows_minutes": { "CDG": 50, "ORY": 40, "BVA": 25 }
```

Justification : CDG = trajet long zone vol → taxi-pool. BVA = aéroport plus petit, fenêtre courte. LBG absent du payload (non couvert, fallback score côté client).

## Tiers de modulation par aéroport

Barème en remote config, **valeurs initiales à valider Ahmed** :

```json
"tiers": {
  "CDG": [
    { "max_flights": 0,   "score": 30 },
    { "max_flights": 3,   "score": 60 },
    { "max_flights": 8,   "score": 80 },
    { "max_flights": 15,  "score": 92 },
    { "max_flights": 999, "score": 100 }
  ],
  "ORY": [
    { "max_flights": 0,   "score": 25 },
    { "max_flights": 2,   "score": 55 },
    { "max_flights": 6,   "score": 78 },
    { "max_flights": 12,  "score": 90 },
    { "max_flights": 999, "score": 98 }
  ],
  "BVA": [
    { "max_flights": 0,   "score": 15 },
    { "max_flights": 1,   "score": 50 },
    { "max_flights": 2,   "score": 70 },
    { "max_flights": 999, "score": 88 }
  ]
}
```

BVA petit volume → barème resserré. À recalibrer avec la donnée terrain.

## Endpoints backend (debug/admin)

| Endpoint | Méthode | Params | Retour |
|---|---|---|---|
| `/eta` | POST | `{ origin: {lat,lng}, destination: {lat,lng} }` | `{ duree_min, distance_km, source: 'google_maps' }` ou 504 + `{source: 'fallback'}` |
| `/flights/adp` | GET | `?airport=CDG\|ORY\|BVA&eta=ISO` | `{ count, source: 'flightview', window_minutes }` ou `{source: 'default', window_minutes}` si stale/empty |

Ces deux routes ne sont **pas** appelées par l'app en routine (l'app appelle `/ride/evaluate` qui orchestre tout en interne). Elles restent disponibles pour les tests manuels, l'admin et le debug. Détails dans `07_backend.md`.
