# FlashFare — Guide de fonctionnement

> Ce document explique comment fonctionne FlashFare (backend + app Android),
> au présent. Audience non-technique : Ahmed, Amor, partenaires. Pour l'état
> d'avancement (ce qui est fait, ce qui reste), voir `SUIVI.md`.

---

## 🎯 À quoi sert le backend ?

Le backend est le **cerveau central** de FlashFare. L'application Android sur le téléphone du chauffeur lui parle pour :

1. **Recevoir une identité** quand le chauffeur installe l'app pour la première fois (login email + mot de passe créés à l'inscription sur la landing page).
2. **Récupérer les paramètres de calcul** (poids du score, seuils, scores de zones, règles parser, etc.) — sans qu'on ait besoin de mettre à jour l'APK.
3. **Évaluer chaque proposition Uber** : l'app envoie l'arbre de l'écran Uber, le backend extrait les chiffres, appelle Google Maps et FlightView, calcule le score, et renvoie ce qu'il faut afficher.
4. **Recevoir les événements de cycle de vie** d'une course (accepté, refusé, course démarrée, terminée, prochaine proposition).
5. **Servir la dernière version d'APK** pour l'auto-update.

Tout passe par le backend, jamais en direct, pour deux raisons :
- **Aucune clé d'API tierce** (Google Maps, etc.) n'est embarquée dans l'APK — donc rien à fuiter.
- On contrôle **tout** depuis le serveur : on peut ajuster les calculs, modifier les règles de parsing, désactiver une fonctionnalité, sans déployer une nouvelle version de l'app.

---

## 📱 Le parcours d'un chauffeur

### Inscription (avant d'installer l'app)
1. Le chauffeur arrive sur la **landing page web** de FlashFare.
2. Il remplit un formulaire d'inscription : **nom, prénom, email, téléphone, adresse, mot de passe**.
3. La landing transmet ces infos au backend qui crée son compte en base (mot de passe hashé via bcrypt — jamais stocké en clair). Le chauffeur reçoit un identifiant interne (UUID) et est automatiquement assigné à un groupe A/B.
4. Pas de session ouverte à ce stade : la landing demande au chauffeur d'installer l'app pour aller plus loin.

### 1er lancement de l'app
1. Le chauffeur installe FlashFare et ouvre l'app.
2. L'app demande **email + mot de passe**.
3. Le backend valide → renvoie deux jetons (accès court + rafraîchissement long), le groupe A/B, et la version des paramètres de calcul.
4. L'app stocke ces jetons **chiffrés** localement et l'utilisateur active la permission d'accessibilité.

> 🔐 Les données personnelles ne sont collectées qu'au moment de l'inscription web (HTTPS), jamais via l'app mobile. Le mot de passe ne sort jamais du backend en clair, n'est jamais stocké en clair, n'apparaît jamais dans les logs.

### À chaque démarrage de l'app
- L'app demande les **paramètres de calcul à jour**. Si rien n'a changé (ETag), le backend répond *« inchangé »* (ultra-rapide).
- L'app vérifie aussi qu'elle n'est pas trop ancienne (force-update gate). Si elle est sous la version minimum requise, elle se bloque et propose de se mettre à jour.

### Quand une proposition Uber apparaît
1. L'app détecte qu'un écran Uber a changé via le service d'accessibilité.
2. Un **filtre local rapide** vérifie 3 critères simples (package Uber, présence d'un identifiant de vue connu, présence d'un montant `XX,XX €`). Si ces critères ne passent pas, l'app ignore l'événement.
3. Sinon, l'app **envoie l'arbre des vues** (un JSON plat décrivant tout ce qui est à l'écran) au backend, route `POST /ride/evaluate`.
4. Le backend :
   - applique son **propre filtre** (au cas où le filtre local serait trop permissif),
   - **parse l'arbre** pour extraire montant, distances, durée pickup, destination,
   - **résout la zone** (mot-clé aéroport prioritaire, sinon lookup code postal),
   - **appelle Google Maps** (ETA temps réel avec trafic) et **FlightView** (nombre de vols à venir) **en parallèle**, avec timeout 1500 ms,
   - **calcule le score** composite (formules dans `03_calcul.md`),
   - **insère l'événement OFFER_VISIBLE** en base (avec tous les chiffres calculés),
   - répond `{ offer_id, is_offer, display }`.
5. L'app **affiche directement** l'overlay tel que le backend l'a décidé (score, verdict, couleur, taux €/h). Pas de décision côté app.
6. Le chauffeur accepte ou refuse via Uber (jamais via FlashFare).
7. L'app détecte le choix (basé sur l'écran Uber qui change) et émet l'événement correspondant (ACCEPTED / REFUSED / TIMEOUT) en POST `/events`.
8. Si la course est acceptée, l'app suit le cycle TRIP_STARTED → TRIP_ENDED → NEXT_OFFER (prochaine proposition vue), chaque transition envoyée au backend.

**Important** : tout le cerveau est côté backend. L'app n'a pas de parser, pas de calcul de score, pas d'appel direct à Google Maps. Elle envoie l'arbre, elle affiche ce qu'on lui dit, elle pousse les événements de cycle de vie.

---

## 🔐 Le système d'identité et de jetons

### Pourquoi des jetons ?
Chaque appel de l'app au backend doit prouver *« c'est bien moi »*. On utilise des **jetons** : des chaînes de caractères que le backend génère après un login email+password réussi.

### Deux types de jetons
- **Jeton d'accès** (durée : 15 minutes) : utilisé pour chaque appel quotidien. Court pour limiter les dégâts si on en perd un.
- **Jeton de rafraîchissement** (durée : 30 jours) : sert uniquement à demander un nouveau jeton d'accès quand l'ancien expire. Stocké de façon sécurisée côté serveur (sous forme empreinte, jamais en clair).

### Rotation
Quand l'app utilise son jeton de rafraîchissement, le backend en génère un **nouveau** et **invalide l'ancien**. Si quelqu'un volait un jeton de rafraîchissement et l'utilisait, le vrai chauffeur s'en rendrait compte au prochain rafraîchissement (son ancien jeton serait refusé) — sécurité standard.

### Suppression
À tout moment, l'app peut demander la suppression de son identité (`DELETE /me`). Le backend supprime l'utilisateur et toutes ses données personnelles. Conformité RGPD basique.

---

## 🎲 Le système de groupes A/B

C'est le mécanisme qui permet **d'améliorer les scores en continu** sans déployer de nouvelle version de l'app.

### Le principe
Chaque chauffeur est dans **un groupe parmi trois** :

| Groupe | Rôle |
|---|---|
| `control` | Groupe témoin. Reçoit la configuration de référence. |
| `test_a` | Groupe expérimental A. |
| `test_b` | Groupe expérimental B. |

### Comment l'assignation est faite
Source de vérité en production : **Amplitude Experiment**, plateforme d'A/B testing. Le bucketing est déterministe sur l'identifiant unique du chauffeur. Ahmed crée, modifie ou active un variant via le dashboard Amplitude — zéro déploiement, zéro accès SQL.

En fallback (dev local sans Amplitude ou si Amplitude est indisponible), le backend calcule un hachage déterministe à partir de l'identifiant unique du chauffeur + une valeur secrète (un sel) — répartition statistiquement équilibrée à 1/3.

> 💡 **Pourquoi déterministe ?** Pour qu'un même chauffeur reste toujours dans le même groupe, même s'il réinstalle. Sans ça, les statistiques A/B ne tiendraient pas.

### À quoi ça sert concrètement
Si Ahmed propose une nouvelle pondération du score (par exemple : donner plus d'importance au taux horaire et moins à la zone), il peut :
1. Créer une **nouvelle configuration** assignée au groupe `test_a` (depuis le dashboard Amplitude).
2. Laisser tourner quelques semaines.
3. Comparer les résultats dans Amplitude Analytics : est-ce que `test_a` accepte/refuse mieux les bonnes courses que `control` ?
4. Si oui → promouvoir la nouvelle config sur `control`. Sinon, ajuster.

Tout ça sans toucher à l'APK installée chez les chauffeurs.

---

## ⚙️ La configuration à distance (remote config)

### Ce que contient une configuration

Chaque configuration porte une **version unique** (ex : `cfg-2025-04-001`) et regroupe :

| Bloc | Contenu |
|---|---|
| `weights` | Poids des composantes du score (horaire / km / zone) |
| `normalization` | Plafonds pour ramener à /10 |
| `thresholds` | Seuils des verdicts (rentable ≥ 7, limite ≥ 4) |
| `fallback_timeout_ms` | Combien de temps attendre Google Maps |
| `flights` | Paramètres aéroports (CDG, ORY, BVA) : barèmes par nombre de vols, fenêtres temporelles |
| `parser` | Règles d'extraction de l'arbre Uber (viewIds, regex), classes d'écrans trip_active / trip_ended, intervalles de heartbeat et d'overlay |

> 🛬 **Aéroports MVP** : CDG, ORY et BVA, tous couverts par FlightView (gratuit, sans clé). Le Bourget (LBG) reste à part : peu de vols commerciaux + pas couvert par FlightView → fallback score 85 inline côté backend.

### Le mécanisme de mise à jour intelligente
- L'app appelle `/config` au démarrage et toutes les 6 h.
- Le backend renvoie un **identifiant de version courante** (un genre d'empreinte ETag).
- À l'appel suivant, l'app envoie cet identifiant. Si rien n'a changé, le backend répond *« rien de neuf »* sans renvoyer le contenu — économie de bande passante et latence quasi-nulle.
- Si la config a été modifiée (par Ahmed dans Amplitude), le backend renvoie la nouvelle version complète.

### Versions embarquées dans chaque proposition
À chaque proposition Uber, le backend stocke en base avec l'événement :
- la **version de config** utilisée au moment du calcul,
- la **version des règles parser** (`parser.rules_version`),
- la **version du code parser backend** (commit SHA),
- la **version de l'app**.

Ça permet de **rejouer les calculs avec d'autres pondérations a posteriori**, sans avoir à redéployer.

---

## 🛡️ Sécurité — principes

| Protection | Description |
|---|---|
| **Aucune clé tierce dans l'app** | Toutes les clés Google Maps / FlightView sont côté serveur uniquement. Si l'APK est désassemblée, rien à voler. |
| **App en lecture seule sur Uber** | Le service d'accessibilité ne peut pas cliquer. Jamais. Code review obligatoire sur tout changement qui touche `access/` ou `overlay/`. |
| **Filtre `packageNames` strict** | Le service ne lit que `com.ubercab.driver`, rien d'autre. Pas de scraping d'autres apps. |
| **PII collectée à la source unique** | L'inscription se fait sur la landing page web en HTTPS. Le mot de passe est hashé bcrypt avant insertion en base. |
| **Jetons à courte durée** | Le jeton d'accès expire en 15 minutes. |
| **Rotation des jetons de rafraîchissement** | Vol détectable. |
| **Mots de passe / jetons jamais en clair en base** | Empreintes bcrypt uniquement. |
| **En-têtes HTTP de sécurité** | Configurés via Helmet (anti-XSS, anti-clickjacking, etc.) |
| **Limite de débit** | Plafonds par chauffeur sur les routes sensibles (`/ride/evaluate`, `/events`, `/eta`...) |
| **Validation systématique** | Toutes les entrées sont vérifiées avant d'être traitées (Zod). |
| **Force-update gate** | Si une faille critique est détectée, on peut publier une version minimum requise — les apps en-dessous sont bloquées au démarrage. |

---

## 🗄️ Ce qui est stocké en base de données

### `users`
La liste des chauffeurs inscrits.
- Identifiant unique (UUID interne — utilisé partout dans le système)
- Date de création
- **Email** (unique, case-insensitive) + **mot de passe** (hashé bcrypt, jamais en clair)
- **Nom, prénom, téléphone, adresse postale**
- Empreinte du jeton de rafraîchissement courant + sa date d'expiration
- Marqueur "admin"

### `device_group_assignments`
Quel groupe (control / test_a / test_b) chaque chauffeur a reçu.

### `remote_configs`
Les configurations disponibles, par version (fallback dev local — la source de vérité prod est Amplitude).

### `postal_zones`
Les codes postaux d'Île-de-France avec leur catégorie et leur score (Paris intra, petite couronne, grande couronne, aéroport, hors IDF).

### `offer_events`
Les événements bruts (un par étape d'une proposition Uber). L'événement `OFFER_VISIBLE` est inséré par le backend dans `/ride/evaluate` avec tout le contexte (montant, ETA, vols, score prédit). Les autres événements (`ACCEPTED`, `REFUSED`, `TIMEOUT`, `TRIP_STARTED`, `TRIP_ENDED`, `NEXT_OFFER`) viennent de l'app via `/events`.

### `flights_cache`
Le cache local des vols (CDG / ORY / BVA), rafraîchi toutes les 5 minutes par un job en arrière-plan qui interroge FlightView.

### `rides`
Une ligne par proposition agrégée, dès qu'un événement terminal arrive (refus, timeout, ou course terminée). C'est la table de référence pour la calibration des scores. Réversible : la table `offer_events` reste la source de vérité, un `npm run rebuild-rides` reconstruit `rides` à partir des événements bruts.

### `app_versions`
Les APK publiées. La row la plus récente est servie par `GET /version/latest` à l'app pour le force-update gate.

### `_migrations` (technique)
Trace les évolutions du schéma déjà appliquées, pour ne pas les rejouer.

---

## 🤖 Côté Android : l'app

Posture : **app dumb, backend cerveau**. L'app fait 3 choses :

1. **Détecter qu'un écran Uber a changé** via le service d'accessibilité (lecture seule).
2. **Envoyer l'arbre des vues** au backend (route `/ride/evaluate`).
3. **Afficher** ce que le backend renvoie (overlay score / verdict / couleur / taux).

Plus une state machine simple (IDLE → OFFER_VISIBLE → TRIP_ACTIVE → TRIP_ENDED → IDLE) pour pousser les événements de cycle de vie, et le force-update gate.

Pas de parser embarqué, pas de calcul de score, pas d'appel direct à Google Maps. Si Uber change la structure de son écran, on ajuste les règles de parser dans la remote config (sans déployer d'APK). Si la structure change tellement que les règles ne suffisent plus, on publie un APK qui ajuste le filtre local et on force update.

**Distribution** : hors Play Store, APK signé hébergé sur Cloudflare R2 (URL signée TTL 5 min). Auto-update silencieux en non-force, blocage écran plein si force-update. Permission `REQUEST_INSTALL_PACKAGES` requise.

**Survie du service** : foreground service avec notification neutre, battery exemption à l'onboarding, instructions manuelles pour Xiaomi MIUI et Samsung One UI (Lock in recents, désactivation des Smart Power Saving). Heartbeat Amplitude toutes les 10 min pour détecter les kills silencieux.

Détail complet : `android.md`.

---

## 🧭 Pour aller plus loin

- **Règles projet (transversales)** : `00_contexte.md` § Règles
- **Spécification produit** : `01_produit.md`
- **Architecture technique** : `02_architecture.md`
- **Détail du calcul** : `03_calcul.md`
- **Zones IDF** : `04_zones.md`
- **APIs externes** : `05_apis.md`
- **Données + remote config** : `06_data.md`
- **Backend en détail** : `07_backend.md`
- **Détail Android** : `android.md`
- **Plan backend** : `08_planning_backend.md`
- **Plan Android** : `09_planning_android.md`
- **État d'avancement (ce qui est fait, ce qui reste)** : `SUIVI.md`
- **Backend corrections pour Android** : `correction_android.md`
- **Backend corrections Amplitude** : `correction.md`
