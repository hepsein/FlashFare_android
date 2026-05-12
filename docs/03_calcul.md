# 03 — Calcul de la rentabilité

> **Calcul exécuté côté backend** dans `POST /ride/evaluate`. L'app ne calcule
> rien : elle reçoit `display.score`, `display.verdict`, `display.color`,
> `display.taux_horaire_text` et les rend tels quels. Cf. `02_architecture.md`
> § Composants client + `android.md` § 6.

Deux indicateurs **indépendants** :
- **Score /10** : algo propriétaire FlashFare, recalibré avec la donnée terrain → fait foi
- **Taux €/h** : repère brut affiché en parallèle, non normalisé

> Ne pas chercher à les harmoniser. Le score est ajusté en continu, le taux €/h reste brut pour aider la lecture du chauffeur.

## Indicateurs de base

```
TauxHoraire = Montant / (TempsPickup_min + DureeCourse_min) × 60
TauxKm      = Montant / (DistancePickup_km + DistanceCourse_km)
ScoreZone   = lookup(code_postal) [aéroport : ajusté selon vols]
```

- `Montant` = net (commission Uber déduite)
- `DureeCourse_min` = ETA Google Maps via `/eta`
- ScoreZone : voir `04_zones.md` et `05_apis.md`

## Normalisation 0-10

| Indicateur | Formule | Repères (init) |
|---|---|---|
| Taux horaire | `min(10, TauxHoraire / horaire_divisor)` | divisor=3 → 30€/h = 10 (plafond) |
| Taux km | `min(10, TauxKm × km_multiplier)` | multiplier=5 → 2€/km = 10 |
| Score zone | `ScoreZone / zone_divisor` | divisor=10 → 100/100 = 10 |

Paramètres en remote config, **valeurs initiales arbitraires à recalibrer**.

## Score composite

```
Score = (TauxHoraire_norm × 0.60)
      + (TauxKm_norm     × 0.15)
      + (BonusZone_norm  × 0.25)
```

Max théorique : 10. Poids initiaux à recalibrer.

## Verdicts

| Verdict | Condition |
|---|---|
| ✅ RENTABLE | Score ≥ 7 |
| ⚠ LIMITE | 4 ≤ Score < 7 |
| ❌ NON RENTABLE | Score < 4 |

## Affichage

L'overlay est rendu **en une fois** quand `/ride/evaluate` répond, ou pas du
tout si la réponse est un timeout (mini-bandeau d'erreur 2 s). Budget total
côté backend : p95 < 1500 ms.

| Cas backend | Action app |
|---|---|
| `display.show_overlay: true` + score/verdict/couleur/taux | Overlay complet |
| `display.show_overlay: false` + `error: "eta_timeout"` | Mini-bandeau "Données indisponibles" 2 s |
| `display.show_overlay: false` (killswitch ou parsing_failed) | Rien |
| `is_offer: false` | Rien |

## Fallbacks

**Google Maps KO/timeout (1500 ms)** : `/ride/evaluate` retourne
`display.show_overlay: false` + `error: "eta_timeout"`. Le payload
`offer_event` OFFER_VISIBLE inséré porte `eta.source = "fallback"` et
`overlay_displayed_partial = true`.

**API vols KO** (FlightView down, **pas** "0 vol") : score zone aéroport =
`flights.fallback_score` (init 85). Score composite calculé normalement,
overlay complet affiché. Event : `flights.source = "default"`.

**API vols renvoie 0 vol** : info valide, tier "0 vol" appliqué (CDG=30,
ORY=25, BVA=15). Pas un fallback.

**LBG hors couverture FlightView** : zone résolue inline côté backend sur
`flights.fallback_score: 85` (pas d'appel `getFlightsCount`).

## Exemple

Course CDG : 28,50€ · pickup 8min/3,2km · course 24km · ETA 32min · 14 vols (tier ≤15 → 92/100)

```
TauxHoraire = 28,50 / (8+32) × 60 = 42,75 €/h
TauxKm      = 28,50 / (3,2+24) = 1,047 €/km

TauxHoraire_norm = min(10, 42,75/3) = 10
TauxKm_norm      = min(10, 1,047×5) = 5,24
BonusZone_norm   = 92/10 = 9,2

Score = 10×0,60 + 5,24×0,15 + 9,2×0,25 = 9,09
```

Affichage : ✅ RENTABLE — `9.1 — 43€/h` (vert)

## Remote config

```json
{
  "config_version": "cfg-2025-04-001",
  "weights": { "horaire": 0.60, "km": 0.15, "zone": 0.25 },
  "normalization": { "horaire_divisor": 3, "km_multiplier": 5, "zone_divisor": 10 },
  "thresholds": { "rentable": 7, "limite": 4 },
  "fallback_timeout_ms": 1500,
  "flights": {
    "fallback_score": 85,
    "windows_minutes": { "CDG": 50, "ORY": 40, "BVA": 25 },
    "tiers": { /* voir 05_apis.md — CDG, ORY, BVA */ }
  },
  "parser": { /* règles parser backend, voir android.md § 5 et 6 */ }
}
```

LBG absent du payload : FlightView ne le couvre pas, le score fallback 85 suffit pour ce volume résiduel.

`config_version` est embarqué dans chaque event → permet de rejouer les calculs avec d'autres pondérations.
