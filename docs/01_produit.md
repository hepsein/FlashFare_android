# 01 — Produit

## Cas d'usage

Chauffeur connecté Uber Driver. À chaque proposition, FlashFare détecte l'**écran de proposition** (= activité Uber, pas popup système) via AccessibilityService et affiche un overlay. Le chauffeur accepte/refuse via les boutons Uber natifs.

## Flux

1. Proposition apparaît : *« 18,50€ — Pickup 6 min — CDG »*
2. Détection écran → extraction → calcul
3. Overlay affiché **incrémentalement** :
   - **t=0** (détection) : taux €/km + indicateur "Calcul…"
   - **t=ETA reçu** (200-1500ms) : score /10 + taux €/h + couleur
   - **t=timeout 1500ms** : taux €/km seul + ⚠
4. Décision chauffeur via Uber (jamais via FlashFare)
5. Overlay disparaît (action ou 10s)

## Données extraites de l'écran

| Donnée | Format | Notes |
|---|---|---|
| Montant | `XX,XX€` | Net (commission déduite) |
| Pickup temps | `X min` | |
| Pickup distance | `X,X km` | |
| **Durée course** | ❌ absent | Récupérée via Google Maps |
| Distance course | `X,X km` | À confirmer par captures |
| Adresse destination | Texte | Sert détection zone |

> Variantes à capturer en phase exploration : UberX, Comfort, Pro, Trip Radar, course longue, surge, multi-stop.

## Overlay

### Affichage
- Deux indicateurs simultanés (score + taux €/h), masquables individuellement par l'utilisateur
- Position : haut d'écran (hors zone Accept/Refuse Uber)
- `FLAG_NOT_TOUCHABLE | FLAG_NOT_FOCUSABLE` (n'intercepte rien)
- Disparition : auto 10s ou à l'action

### Verdicts

| Verdict | Condition | Couleur |
|---|---|---|
| ✅ RENTABLE | Score ≥ 7 | `#22C55E` |
| ⚠ LIMITE | 4 ≤ Score < 7 | `#F59E0B` |
| ❌ NON RENTABLE | Score < 4 | `#EF4444` |

## Disclaimer onboarding

Texte validé explicitement à la 1ère ouverture, versionné, re-consentement à chaque update :

> *FlashFare lit l'écran d'Uber Driver via le service d'accessibilité Android. Uber n'autorise pas formellement les outils tiers de filtrage. Ton compte peut être suspendu si Uber détecte un comportement de filtrage atypique. Tu utilises FlashFare à tes risques. Aucune action automatique sur Uber : seule ta décision compte.*

## Hors périmètre MVP

- Configuration utilisateur des pondérations (pilotée backend)
- iOS, Bolt, Heetch
- Historique consultable côté utilisateur
- Notifications, marketing, social
- **Aucune action automatique sur Uber** (red line absolue)

## Critères produit

- Verdict compris en < 1s
- Overlay ne masque jamais Accept/Refuse
- Concordance verdict ↔ intuition chauffeur > 80%
- NPS > 7/10
- Onboarding réussi sans assistance sur Xiaomi/Samsung
