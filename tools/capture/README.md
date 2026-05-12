# FlashFare capture — tool PC

Collecte les dumps `FFC_DUMP` émis par l'APK `flashfare-capture`. Stream
`adb logcat`, reassemble les chunks, sauve chaque dump puis garde une copie
dédupliquée (signature SHA-1 sur les `nodes`).

Sortie : `<repo>/captures/<session>/`.

## Pré-requis

- Node ≥ 18 (testé sur Node 23). Aucun `npm install` à faire.
- `adb` dans le `PATH`.

## Workflow opérateur (3 étapes)

1. Brancher le téléphone, vérifier `adb devices`, puis dans **Paramètres →
   Accessibilité** activer **FlashFare Capture**.
2. Lancer le collecteur :
   ```
   node tools/capture/capture.mjs
   ```
3. Ouvrir Uber Driver et rouler. À la fin, `Ctrl+C` pour arrêter.

Les fichiers utiles pour l'analyse sont sous
`captures/<session>/unique/` (un `.json` + un `.png` par écran distinct).
Les dumps bruts complets (un par event accessibility) restent dans
`captures/<session>/NNNN.json` pour audit.

## Flags

- `--no-screencap` : ne pas appeler `adb exec-out screencap -p` à chaque
  nouvel écran unique. Gagne ~300 ms par capture quand on n'a pas besoin
  des PNG.
- `-h`, `--help` : affiche l'usage et quitte.

## Sortie console

```
[+] f8ca3818 seq=0042 (3.2 KB, 47 nodes)        nouveau raw sauvé
[★] f8ca3818 unique=05 from seq=0042 → unique/05.json + .png   nouvel écran unique
[=] f8ca3818 seq=0043 dup of unique=05 (×3)     doublon (même signature)
[!] f8ca3818 seq=0044 parse failed: ...         JSON cassé, dump droppé
```

## Identifier les transitions d'écran

- Apparition / disparition d'un écran : regarder le **seq** auquel un
  `[★]` apparaît, puis le seq auquel un autre `[★]` ou un retour à un
  `unique` précédent (`[=]`) survient.
- Différencier les types de course : ouvrir les `unique/NN.json`,
  comparer les `nodes[].vid` et les valeurs `text` (montant, durée,
  destination). La PNG sert de témoin visuel.

Pour le moment l'outil **ne fait que sauvegarder** ; l'annotation
(`unique/NN.truth.json`) reste manuelle, cf. `docs/09_planning_android.md`
§ Phase 1.B.
