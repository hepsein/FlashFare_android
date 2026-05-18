# 00 — Contexte

## Produit

Application Android pour chauffeurs VTC sur Uber Driver. À chaque proposition de course, un overlay affiche :
- **Score /10** (indicateur propriétaire FlashFare, recalibré avec la donnée terrain — fait foi)
- **Taux €/h** (repère brut, indépendant du score, utile en début d'usage)

Les deux indicateurs sont **indépendants par design**.

## Distribution

- Hors Google Play Store (politique restrictive sur AccessibilityService)
- APK direct + auto-update interne
- Société d'édition à l'étranger
- Disclaimer onboarding sur le risque côté compte Uber chauffeur

## Équipe

| Membre | Rôle |
|---|---|
| Wacil | Dev |
| Amor | Coordination |
| Ahmed | Expertise terrain VTC, scoring zones et vols |

## Règles projet

Règles transversales qui s'appliquent à toute contribution (code + documentation). Tout PR / commit qui les contredit doit être discuté et justifié explicitement.

### Documentation

1. **Fichiers de définition intemporels.** Tous les `.md` du repo sauf `SUIVI.md` décrivent l'**état actuel** du projet : architecture, contrats, conventions. Ils sont rédigés au présent, sans marqueurs d'évolution (« ajouté plus tard », « ex-Phase X », « remplace l'ancien », « anciennement »). Si une décision a une histoire, elle vit dans `SUIVI.md`, qui est l'unique journal d'évolution (date, motif, alternatives écartées).
2. **Spec-first.** La doc MD est mise à jour **dans le même commit / PR** que le code qu'elle décrit, jamais après-coup. Une divergence MD ↔ code est traitée comme un bug.
3. **Une source par sujet.** Pas de duplication de spécification. Si un sujet est documenté ailleurs, on référence par lien (`cf. 07_backend.md § Endpoints`) plutôt que de recopier.
4. **GUIDE.md = vulgarisation.** Audience non-technique (Ahmed, Amor, futurs investisseurs). Pas de SQL, pas de code, pas de jargon non explicité. Reflète toujours l'état courant — pas de section « ce qui est fait » (c'est SUIVI.md).

### Architecture

5. **App dumb, backend cerveau.** Toute la logique métier (parser, scoring, résolution de zone, orchestration des APIs tierces) vit côté backend. L'app fait 3 choses : détecter qu'un écran Uber a changé, envoyer l'arbre, afficher ce que le backend renvoie. Si tu hésites à mettre une règle côté app, c'est qu'elle doit être backend.
6. **Stack figée.** Backend : Node 22 + Fastify v5 + postgres-js + Zod + lru-cache + node-cron + bcryptjs. **Pas** de TypeScript, Redis, BullMQ, ORM, `dotenv`. Android : Kotlin 2 + Compose + Material3 + Retrofit + Moshi + OkHttp + Coroutines + Room + DataStore Preferences + WorkManager + Amplitude (Analytics + Experiment) + Timber + JUnit Jupiter. **Pas** de Hilt (manual DI via singletons / constructor injection — l'app reste petite), **pas** de DataStore Proto (Preferences suffit, zéro codegen), **pas** de MockK / Robolectric tant qu'un test concret ne les requiert pas, **pas** de Crashlytics/Firebase, **pas** de RxJava. Toute dérogation = ticket explicite + validation.
7. **Pas d'abstraction prématurée.** Du code lisible, un fichier par sujet, pas de hiérarchie de modules/services/schemas. Trois lignes similaires valent mieux qu'une abstraction qu'on devra défaire.

### Sécurité / Red lines

8. **Aucune clé API tierce dans l'APK.** Google Maps, FlightView et toute autre API tierce sont appelées **exclusivement** par le backend. L'app appelle uniquement `https://<backend>/…`.
9. **Pas d'auto-clic sur Uber.** L'AccessibilityService est en lecture seule. Jamais `performAction(ACTION_CLICK)`, jamais `dispatchGesture`, jamais aucune API qui produit un input. PR qui touche `access/` ou `overlay/` = review obligatoire.
10. **Filtre `packageNames` strict.** L'AccessibilityService déclare `packageNames="com.ubercab.driver"` et rien d'autre. Pas de scraping d'autres apps, jamais.
11. **Pas de secret en clair.** Aucun secret dans le code, les commits, les logs. Les mots de passe et refresh tokens sont stockés hashés (bcrypt + pré-hash SHA-256 pour les JWT > 72 octets). PII chiffrée en transit (HTTPS), hashée ou en clair en DB selon le besoin produit (bcrypt pour password, clair pour nom/email/téléphone/adresse — usage facturation/contact).

### Process

12. **Conventional Commits + `main` protégée.** Tout passe par PR, CI verte (lint + tests) obligatoire avant merge.
13. **Tests verts à chaque fin de phase.** `npm test` + `npm run lint` propres. Si une phase laisse des tests rouges, on ne démarre pas la suivante.
14. **Commits atomiques.** Un commit = un sujet. Pas de mega-commit qui mélange refactor, feature et fix.

---

## Glossaire

| Terme | Définition |
|---|---|
| VTC | Voiture de Transport avec Chauffeur |
| Net | Montant après commission Uber (déjà déduit dans la donnée écran) |
| ETA | Estimated Time of Arrival, durée d'un trajet |
| ADP | Aéroports de Paris (CDG, Orly, Le Bourget) |
| BVA | Aéroport Beauvais-Tillé |
| AccessibilityService | Service Android qui peut lire la hiérarchie de vues d'autres apps |
| Écran de proposition | Activité plein écran d'Uber Driver présentant une course (≠ popup système) |
| Overlay | Vue affichée par-dessus une autre app |
| Pickup | Trajet/temps chauffeur → client |
| Course | Trajet client (prise en charge → dépôt) |
| Outcome | Données réelles a posteriori (durée réelle, délai avant course suivante) |
| Offer ID | UUID lié à une proposition, agrège tous les events associés |
| Remote config | Paramètres pilotés depuis le serveur sans déploiement APK |
| Device group | Groupe de devices recevant une config A/B (control / test_a / test_b) |
| Config version | ID de version de la config remote, embarqué dans chaque event |
