# 04 — Zones géographiques

## Principe

Chaque code postal IDF a un **score 1-100** (100 = meilleure zone). Scoring par Ahmed, recalibré avec la data. Aéroports = score dynamique selon vols (cf. `05_apis.md`).

**Scope MVP** : IDF complète (75, 77, 78, 91, 92, 93, 94, 95) + scoring dynamique pour CDG, ORY, BVA (vols FlightView). LBG géré via fallback score (85) côté client.

## Catégories

5 catégories, dont `AEROPORT_ADP` pour les CP géographiquement aéroport (Le Bourget 93350, Orly 94310, Roissy 95700) — fallback si une adresse résidentielle dans ces CP est détectée.

| Zone | CP | Score défaut |
|---|---|---|
| Paris intra-muros | 75* | 90 |
| Petite couronne | 92, 93, 94 | 50 |
| Grande couronne | 77, 78, 91, 95 | 20 |
| Aéroport ADP (résidentiel) | 93350, 94310, 95700 | 50 / 50 / 20 (catégorie `AEROPORT_ADP`) |
| Hors IDF | reste | 10 |

> Le score réel utilisé = score du **CP exact** dans la base. La catégorie sert seulement de défaut. La détection par mot-clé aéroport (`Roissy`, `Orly`, `CDG`, `Beauvais`) reste prioritaire et route vers le scoring dynamique des vols.

## Détection (côté backend, dans `/ride/evaluate`)

Priorité décroissante :

1. **Mots-clés aéroport** dans l'adresse :
   - `CDG`, `Roissy`, `Charles de Gaulle` → AEROPORT_ADP_CDG
   - `Orly` → AEROPORT_ADP_ORLY
   - `Le Bourget` → AEROPORT_ADP_BOURGET
   - `Beauvais`, `BVA` → AEROPORT_BEAUVAIS
2. **Code postal IDF** : regex `\b\d{5}\b` puis lookup snapshot local
3. **Défaut** : HORS_IDF, score 10

## Stockage : table Postgres

Pas de CSV embarqué dans l'APK. La résolution de zone vit côté backend dans `/ride/evaluate` (lookup direct en DB + cache LRU 1 h). Le client récupère un snapshot zones via `GET /zones` (ETag) pour usage admin/debug et future fonctionnalité historique.

```sql
CREATE TABLE postal_zones (
  postal_code   VARCHAR(5)  PRIMARY KEY,
  commune       TEXT        NOT NULL,
  dept_code     VARCHAR(2)  NOT NULL,
  dept_name     TEXT        NOT NULL,
  zone_category TEXT        NOT NULL,  -- PARIS_INTRA, PETITE_COURONNE, GRANDE_COURONNE, AEROPORT_ADP, HORS_IDF
  score         SMALLINT    NOT NULL CHECK (score BETWEEN 1 AND 100),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by    TEXT        NOT NULL DEFAULT 'system'
);

CREATE INDEX idx_postal_zones_dept ON postal_zones(dept_code);
```

Les **codes postaux aéroport** (93350, 94310, 95700) sont présents en table comme fallback géographique avec catégorie `AEROPORT_ADP`. La détection backend prioritaire par mot-clé (`Roissy`, `Orly`, `CDG`, `Beauvais`) route vers le scoring dynamique vols (`getFlightsCount` en interne). Le lookup CP table sert uniquement quand une adresse résidentielle dans un CP-aéroport est extraite (rare).

## Endpoints

```
GET /zones
  Headers: Authorization, If-None-Match?
  → 200: [{ postal_code, category, score }]
  → 304 si ETag match
```

Édition admin : `PATCH /admin/zones/:cp` (cf. `07_backend.md`).

## Plan de scoring Ahmed

Trois leviers indépendants :

1. **Catégories** : Ahmed valide les scores de catégorie. Tous les CP héritent.
2. **Exceptions** : Ahmed liste les CP qu'il connaît bien (très bons / mauvais), override individuel via admin.
3. **Calibration auto** : après collecte de N events par CP, score ajusté via job offline (Phase 9).

## Seed initial

CSV `seeds/postal_zones.csv` (copie de `FlashFare_Codes_Postaux_IDF.csv` à la racine). Contient **528 CP IDF** avec scores de catégorie. `npm run seed` est idempotent (UPSERT par `postal_code`). Exceptions Ahmed appliquées via `PATCH /admin/zones/:cp` ou un fichier `seeds/exceptions_ahmed.json` ré-importé.
