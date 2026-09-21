# Poly

Site avec mes prises de notes de cours : https://poly.chruk.fr

- **`/`** : liste des cours par année (Actuel, M2, M1, L3, …) avec la première page en vignette.
  Chaque cours s'ouvre en PDF, en 3 versions : normale, sans quadrillage, fond blanc.
- **`/edit`** : ajout d'un cours, modification de ses infos, et surtout **mise à jour du `.goodnotes`**
  (protégé par mot de passe).

## Mettre à jour un cours (le plus fréquent)

Sur `/edit` :

- **glisser-déposer** le `.goodnotes` n'importe où sur la page : le cours dont le fichier porte le même nom
  (celui du carnet Goodnotes) est mis à jour tout de suite ; si aucun ne correspond, le site demande lequel ;
- ou cliquer sur **⬆ Mettre à jour** sur la ligne du cours, puis choisir le fichier.

L'envoi part dès que le fichier est choisi. La conversion se fait en arrière-plan ; les anciens PDF restent
en ligne jusqu'à ce que les nouveaux soient prêts, et en cas d'échec ils restent en place.

## Les 3 PDF

| PDF | contenu |
|---|---|
| normal | comme l'export Goodnotes (fond et quadrillage) |
| sans quadrillage | même chose, sans le quadrillage (couleur de fond conservée) |
| fond blanc | fond blanc uni, couleurs remplacées pour rester lisibles |

La **première page** (la couverture) ne change jamais.

Pour le fond blanc, **Modifier** sur un cours affiche chaque couleur utilisée (stylos et surligneurs) avec
la couleur de remplacement proposée automatiquement ; on peut choisir n'importe quel code RVB. Seul le PDF
à fond blanc est régénéré quand on change les couleurs. Les couleurs qui disparaissent d'un cours lors d'une
mise à jour perdent leur réglage, les autres le gardent.

## Architecture

- `server.js` : un seul process Node.js (Express), stockage en fichiers, pas de base de données.
  Une file d'attente lance **une conversion à la fois** (`scripts/goodnotes2pdf.py`).
- `scripts/goodnotes2pdf.py` : convertisseur `.goodnotes` → PDF, bibliothèque standard uniquement.
  Utilisable seul :
  ```
  python3 scripts/goodnotes2pdf.py cours.goodnotes                       # -> cours.pdf
  python3 scripts/goodnotes2pdf.py cours.goodnotes --fond blanc -o x.pdf
  python3 scripts/goodnotes2pdf.py cours.goodnotes --couleurs            # couleurs utilisées (JSON)
  ```
- `data/courses/<id>/` : `meta.json`, `source.goodnotes`, `normal.pdf`, `sans-quadrillage.pdf`,
  `blanc.pdf`, `thumb.jpg`. Tout est gitignoré.

## Prérequis sur le serveur

- Node.js et `npm`
- Python 3 (`python3`, ou variable `PYTHON`)
- `poppler-utils` (`pdftoppm`) pour les vignettes ; sans lui tout fonctionne, seules les vignettes manquent

## Configuration

Mot de passe de `/edit` : générer un hachage, puis le mettre dans `data/admin-password.json`.

```
node scripts/hash-password.js "motdepasse"
```
```json
{ "hash": "…résultat de la commande…" }
```

Variables d'environnement (toutes facultatives) :

| variable | défaut | rôle |
|---|---|---|
| `PORT` | `3008` | port d'écoute |
| `PYTHON` | `python3` | interpréteur Python |
| `MAX_UPLOAD_MB` | `500` | taille maximale d'un `.goodnotes` |
| `CONVERT_TIMEOUT_MIN` | `15` | durée maximale d'une conversion |

## Déploiement

`reload.sh` fait `git pull`, `npm install`, puis `pm2 reload poly` (ou `pm2 start` au premier lancement).

Le nginx devant le site doit accepter de gros envois, sinon l'envoi d'un `.goodnotes` échoue
(la limite par défaut est de 1 Mo) :

```
server_name poly.chruk.fr;
client_max_body_size 500m;
location / {
    proxy_pass http://127.0.0.1:3008;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header Host $host;
}
```

## Notes

- Les pages sont marquées `noindex` (le site est fait pour être partagé avec des amis, pas référencé).
- Session `/edit` : cookie valable 90 jours, 5 essais de mot de passe par IP et par 15 minutes.
- Le convertisseur a été écrit par rétro-ingénierie du format Goodnotes 6 à partir d'exemples : les objets
  qu'il ne connaît pas (texte tapé, etc.) sont ignorés, et un avertissement s'affiche sur la ligne du cours.
