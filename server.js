const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();

app.set('trust proxy', 1); // derrière nginx : nécessaire pour que req.secure reflète X-Forwarded-Proto

const dataDir = path.join(__dirname, 'data');
const coursesDir = path.join(dataDir, 'courses');
const tmpDir = path.join(dataDir, 'tmp');
const publicDir = path.join(__dirname, 'public');
const pythonScript = path.join(__dirname, 'scripts', 'goodnotes2pdf.py');

const adminPasswordPath = path.join(dataDir, 'admin-password.json');
const sessionSecretPath = path.join(dataDir, 'session-secret');

const PYTHON = process.env.PYTHON || 'python3';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 500;
const CONVERT_TIMEOUT_MS = (Number(process.env.CONVERT_TIMEOUT_MIN) || 15) * 60 * 1000;

fs.mkdirSync(coursesDir, { recursive: true });
// restes d'envois ou de conversions interrompus par un redémarrage
fs.rmSync(tmpDir, { recursive: true, force: true });
fs.mkdirSync(tmpDir, { recursive: true });

function loadJSON(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

// écriture atomique : un crash au milieu ne laisse jamais un JSON tronqué
function saveJSON(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

// --- Session admin (même schéma que microlist) ---

function loadOrCreateSessionSecret() {
  try {
    return fs.readFileSync(sessionSecretPath, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(sessionSecretPath, secret);
    return secret;
  }
}

// { "hash": "saltHex:hashHex" }, généré à la main via scripts/hash-password.js ;
// null tant qu'il n'a pas été renseigné (personne ne peut se connecter dans ce cas)
function loadAdminPasswordHash() {
  const data = loadJSON(adminPasswordPath, { hash: null });
  return typeof data.hash === 'string' ? data.hash : null;
}

const sessionSecret = loadOrCreateSessionSecret();
const ADMIN_COOKIE = 'cahier_admin';
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 90; // 90 jours : l'édition doit rester à un clic

// stored = "saltHex:hashHex"
function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !password || typeof stored !== 'string') return false;
  const [salt, hashHex] = stored.split(':');
  if (!salt || !hashHex) return false;

  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hashHex, 'hex');
  if (candidate.length !== expected.length) return false;
  return crypto.timingSafeEqual(candidate, expected);
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex');
}

function verifyAdminToken(token) {
  if (typeof token !== 'string' || !token) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(sign('admin-session'));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // cookie mal encodé : ignoré
    }
  });
  return cookies;
}

function setAdminCookie(res, req) {
  res.cookie(ADMIN_COOKIE, sign('admin-session'), {
    httpOnly: true,
    sameSite: 'lax',
    // req.secure (via "trust proxy" + X-Forwarded-Proto derrière nginx) plutôt que true en dur :
    // un cookie Secure est ignoré par le navigateur tant que le site tourne en http://
    secure: req.secure,
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function requireAdmin(req, res, next) {
  if (!verifyAdminToken(parseCookies(req)[ADMIN_COOKIE])) {
    return res.status(401).json({ error: 'Connexion requise.' });
  }
  next();
}

// 5 échecs par IP et par 15 minutes
const loginFailures = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function loginBlocked(ip) {
  const f = loginFailures.get(ip);
  if (!f) return false;
  if (Date.now() - f.first > LOGIN_WINDOW_MS) {
    loginFailures.delete(ip);
    return false;
  }
  return f.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const f = loginFailures.get(ip);
  if (!f || Date.now() - f.first > LOGIN_WINDOW_MS) loginFailures.set(ip, { count: 1, first: Date.now() });
  else f.count += 1;
}

// --- Cours ---
//
// data/courses/<id>/ : meta.json, source.goodnotes, normal.pdf, sans-quadrillage.pdf,
// blanc.pdf, thumb.jpg. Les métadonnées sont gardées en mémoire et réécrites à chaque changement.

const ID_RE = /^[a-z0-9-]{1,60}$/;
const VARIANT_FILES = {
  normal: 'normal.pdf',
  'sans-quadrillage': 'sans-quadrillage.pdf',
  blanc: 'blanc.pdf',
};
const VARIANT_LABELS = {
  normal: 'PDF',
  'sans-quadrillage': 'sans quadrillage',
  blanc: 'fond blanc',
};
// ordre d'affichage des années ; les autres valeurs viennent ensuite
const YEAR_ORDER = ['actuel', 'm2', 'm1', 'l3', 'l2', 'l1'];

const courses = new Map();

function courseDir(id) {
  return path.join(coursesDir, id);
}

function saveCourse(meta) {
  saveJSON(path.join(courseDir(meta.id), 'meta.json'), meta);
  courses.set(meta.id, meta);
}

function loadCourses() {
  for (const name of fs.readdirSync(coursesDir)) {
    if (!ID_RE.test(name)) continue;
    let meta = null;
    try {
      meta = loadJSON(path.join(coursesDir, name, 'meta.json'), null);
    } catch (err) {
      console.error(`meta.json illisible pour ${name} :`, err.message);
    }
    if (!meta || meta.id !== name) continue;
    if (meta.status === 'processing') {
      meta.status = 'error';
      meta.error = 'Conversion interrompue (le serveur a redémarré). Renvoyez le fichier.';
      courses.set(name, meta);
      saveCourse(meta);
    }
    courses.set(name, meta);
  }
}

function slugify(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'cours';
}

function generateCourseId(title) {
  const base = slugify(title);
  let id;
  do {
    id = `${base}-${crypto.randomBytes(3).toString('hex')}`;
  } while (courses.has(id));
  return id;
}

function yearRank(year) {
  const i = YEAR_ORDER.indexOf(String(year || '').trim().toLowerCase());
  return i === -1 ? YEAR_ORDER.length : i;
}

function sortCourses(list) {
  return list.sort((a, b) =>
    yearRank(a.year) - yearRank(b.year)
    || String(a.year).localeCompare(String(b.year), 'fr')
    || String(a.title).localeCompare(String(b.title), 'fr', { sensitivity: 'base' }));
}

function publicView(m) {
  return {
    id: m.id,
    title: m.title,
    description: m.description,
    year: m.year,
    uploadedAt: m.uploadedAt,
    pages: m.pages,
    version: m.version,
    hasThumb: !!m.thumb,
  };
}

function adminView(m) {
  const job = jobs.get(m.id);
  const opens = m.opens || {};
  return {
    ...publicView(m),
    sourceName: m.sourceName,
    status: m.status,
    error: m.error || null,
    warnings: m.warnings || [],
    progress: job ? job.message : null,
    palette: m.palette || {},
    colors: m.colors || [],
    opens,
    opensTotal: Object.values(opens).reduce((sum, n) => sum + n, 0),
  };
}

// valide et nettoie les champs texte d'un cours (création ou modification)
function parseCourseFields(body) {
  const errors = [];
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
  if (!title) errors.push('Le titre est requis.');
  const description = typeof body.description === 'string' ? body.description.trim().slice(0, 2000) : '';
  const year = typeof body.year === 'string' ? body.year.trim().slice(0, 20) : '';
  if (!year) errors.push("L'année est requise.");
  return { errors, fields: { title, description, year } };
}

// --- Conversion (scripts/goodnotes2pdf.py), une à la fois pour ne pas saturer le serveur ---

const jobs = new Map(); // id -> { message, warnings }
const queue = [];
let pumping = false;

function friendlyLine(line) {
  let m = /^page (\d+)\/(\d+)$/.exec(line);
  if (m) return `Lecture de la page ${m[1]}/${m[2]}`;
  m = /^pdf (.+)$/.exec(line);
  if (m) return `Création du PDF « ${VARIANT_LABELS[m[1]] || m[1]} »`;
  return null;
}

function runPython(args, onLine) {
  return new Promise((resolve, reject) => {
    // -u : sortie non tamponnée, sinon la progression n'arrive qu'à la fin
    const child = spawn(PYTHON, ['-u', pythonScript, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buffer = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, CONVERT_TIMEOUT_MS);

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', err => {
      clearTimeout(timer);
      reject(new Error(`Impossible de lancer ${PYTHON} : ${err.message}`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      if (timedOut) return reject(new Error('Conversion trop longue, abandonnée.'));
      const lastLine = stderr.trim().split('\n').pop();
      reject(new Error(lastLine || `La conversion a échoué (code ${code}).`));
    });
  });
}

// job = { id, kind: 'full' | 'palette', uploadPath?, sourceName? }
//   full    : nouveau .goodnotes -> les 3 PDF + vignette
//   palette : mêmes notes, nouvelles couleurs -> seulement le PDF à fond blanc
function enqueue(job) {
  const meta = courses.get(job.id);
  meta.status = 'processing';
  meta.error = null;
  saveCourse(meta);
  jobs.set(job.id, { message: 'En attente…', warnings: [] });
  queue.push(job);
  pump();
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await runJob(job);
    } catch (err) {
      failJob(job, err);
    }
  }
  pumping = false;
}

async function runJob(job) {
  const meta = courses.get(job.id);
  if (!meta) throw new Error('Cours introuvable.');
  const state = jobs.get(job.id);
  const work = fs.mkdtempSync(path.join(tmpDir, 'job-'));
  try {
    const outDir = path.join(work, 'out');
    const source = job.kind === 'full' ? job.uploadPath : path.join(courseDir(job.id), 'source.goodnotes');
    // --titre=... avec le signe = : un titre commençant par un tiret ne sera pas pris pour une option
    const args = [source, '--site', outDir, `--titre=${meta.title}`];
    if (Object.keys(meta.palette || {}).length) {
      const palettePath = path.join(work, 'palette.json');
      fs.writeFileSync(palettePath, JSON.stringify(meta.palette));
      args.push('--palette', palettePath);
    }
    if (job.kind === 'palette') args.push('--seulement', 'blanc');

    await runPython(args, line => {
      if (line.startsWith('attention :')) {
        if (state.warnings.length < 10) state.warnings.push(line);
        return;
      }
      const message = friendlyLine(line);
      if (message) state.message = message;
    });

    const info = loadJSON(path.join(outDir, 'info.json'), null);
    if (!info) throw new Error('Résultat de conversion introuvable.');

    // les fichiers ne sont remplacés qu'une fois toute la conversion réussie
    const dir = courseDir(job.id);
    for (const name of [...Object.values(VARIANT_FILES), 'thumb.jpg']) {
      const from = path.join(outDir, name);
      if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, name));
    }
    if (job.kind === 'full') fs.renameSync(job.uploadPath, path.join(dir, 'source.goodnotes'));

    // meta peut avoir été modifiée (titre...) pendant la conversion : on repart de l'objet courant
    const current = courses.get(job.id);
    current.pages = info.pages;
    current.colors = info.colors;
    const keys = new Set(info.colors.map(c => c.key));
    current.palette = Object.fromEntries(Object.entries(current.palette || {}).filter(([k]) => keys.has(k)));
    current.thumb = fs.existsSync(path.join(dir, 'thumb.jpg'));
    current.version = (current.version || 0) + 1;
    current.status = 'ready';
    current.error = null;
    if (job.kind === 'full') {
      current.uploadedAt = new Date().toISOString();
      if (job.sourceName) current.sourceName = job.sourceName;
      current.warnings = state.warnings;
    }
    saveCourse(current);
    jobs.delete(job.id);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function failJob(job, err) {
  console.error(`Conversion de ${job.id} échouée :`, err.message);
  if (job.uploadPath) fs.rm(job.uploadPath, { force: true }, () => {});
  jobs.delete(job.id);
  const meta = courses.get(job.id);
  if (!meta) return;
  meta.status = 'error';
  meta.error = err.message;
  saveCourse(meta);
}

loadCourses();

// --- Envois de fichiers ---

const upload = multer({
  dest: tmpDir,
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

function isZip(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const head = Buffer.alloc(2);
    fs.readSync(fd, head, 0, 2, 0);
    fs.closeSync(fd);
    return head[0] === 0x50 && head[1] === 0x4b; // "PK" : un .goodnotes est une archive zip
  } catch {
    return false;
  }
}

// multer décode les noms de fichier en latin1 : le client renvoie donc le vrai nom dans "sourceName"
function uploadedName(req) {
  const given = typeof req.body.sourceName === 'string' ? req.body.sourceName.trim() : '';
  const name = given || Buffer.from(req.file.originalname, 'latin1').toString('utf8');
  return path.basename(name).slice(0, 200);
}

// renvoie un message d'erreur si le fichier reçu n'est pas un .goodnotes valable
function checkUpload(req) {
  if (!req.file) return 'Aucun fichier reçu.';
  if (path.extname(uploadedName(req)).toLowerCase() !== '.goodnotes') return 'Le fichier doit être un .goodnotes.';
  if (!isZip(req.file.path)) return "Ce fichier n'est pas un .goodnotes valide.";
  return null;
}

function discardUpload(req) {
  if (req.file) fs.rm(req.file.path, { force: true }, () => {});
}

// --- Routes ---

app.use(express.json());
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

// pages publiques
app.get('/api/courses', (req, res) => {
  const ready = [...courses.values()].filter(m => m.version > 0);
  res.json(sortCourses(ready).map(publicView));
});

// ?v=<version> dans l'URL : le contenu de cette URL ne change jamais, cache long ;
// sans version : le navigateur revalide à chaque fois (ETag)
function cacheHeaders(req, res) {
  res.set('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
}

function readyCourse(id) {
  const meta = ID_RE.test(id) ? courses.get(id) : null;
  return meta && meta.version > 0 ? meta : null;
}

// compteur d'ouvertures par cours et par variante, juste pour se faire une idée de l'usage du site
// (pas exposé publiquement, visible uniquement sur /edit) ; pas de déduplication par visiteur, donc un
// rechargement compte comme une nouvelle ouverture, sauf si le navigateur sert la réponse depuis son
// cache (ce qui arrive pour une URL déjà ouverte, grâce au cache long permis par ?v=)
function recordOpen(meta, variant) {
  meta.opens = meta.opens || {};
  meta.opens[variant] = (meta.opens[variant] || 0) + 1;
  saveCourse(meta);
}

app.get('/pdf/:id/:variant', (req, res) => {
  const meta = readyCourse(req.params.id);
  const file = Object.prototype.hasOwnProperty.call(VARIANT_FILES, req.params.variant)
    ? VARIANT_FILES[req.params.variant]
    : null;
  if (!meta || !file || !fs.existsSync(path.join(courseDir(meta.id), file))) {
    return res.status(404).send('Introuvable');
  }
  recordOpen(meta, req.params.variant);
  const niceName = `${meta.title} - ${VARIANT_LABELS[req.params.variant]}.pdf`;
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `inline; filename="cours.pdf"; filename*=UTF-8''${encodeURIComponent(niceName)}`);
  cacheHeaders(req, res);
  // "root" : sans lui, sendFile refuse tout chemin dont un dossier parent commence par un point
  res.sendFile(file, { root: courseDir(meta.id), cacheControl: false });
});

app.get('/thumb/:id', (req, res) => {
  const meta = readyCourse(req.params.id);
  if (!meta || !meta.thumb || !fs.existsSync(path.join(courseDir(meta.id), 'thumb.jpg'))) {
    return res.status(404).send('Introuvable');
  }
  cacheHeaders(req, res);
  res.sendFile('thumb.jpg', { root: courseDir(meta.id), cacheControl: false });
});

// --- Édition : session ---

app.post('/edit/api/login', (req, res) => {
  if (loginBlocked(req.ip)) {
    return res.status(429).json({ error: 'Trop de tentatives, réessayez dans quelques minutes.' });
  }
  const hash = loadAdminPasswordHash();
  if (!hash) {
    return res.status(401).json({ error: 'Mot de passe non configuré (voir scripts/hash-password.js).' });
  }
  if (!verifyPassword(req.body.password, hash)) {
    recordLoginFailure(req.ip);
    return res.status(401).json({ error: 'Mot de passe incorrect.' });
  }
  loginFailures.delete(req.ip);
  setAdminCookie(res, req);
  res.json({ ok: true });
});

app.post('/edit/api/logout', (req, res) => {
  res.clearCookie(ADMIN_COOKIE);
  res.json({ ok: true });
});

app.get('/edit/api/me', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

// --- Édition : cours ---

app.get('/edit/api/courses', requireAdmin, (req, res) => {
  res.json(sortCourses([...courses.values()]).map(adminView));
});

// nouveau cours : infos + .goodnotes en une seule requête
app.post('/edit/api/courses', requireAdmin, upload.single('file'), (req, res) => {
  const uploadError = checkUpload(req);
  const { errors, fields } = parseCourseFields(req.body);
  if (uploadError) errors.unshift(uploadError);
  if (errors.length) {
    discardUpload(req);
    return res.status(400).json({ error: errors.join(' ') });
  }

  const id = generateCourseId(fields.title);
  fs.mkdirSync(courseDir(id), { recursive: true });
  const meta = {
    id,
    ...fields,
    sourceName: uploadedName(req),
    createdAt: new Date().toISOString(),
    uploadedAt: null,
    pages: 0,
    version: 0,
    status: 'processing',
    error: null,
    warnings: [],
    thumb: false,
    palette: {},
    colors: [],
    opens: {},
  };
  saveCourse(meta);
  enqueue({ id, kind: 'full', uploadPath: req.file.path, sourceName: meta.sourceName });
  res.status(202).json(adminView(meta));
});

function findCourse(req, res) {
  const meta = ID_RE.test(req.params.id) ? courses.get(req.params.id) : null;
  if (!meta) res.status(404).json({ error: 'Cours introuvable.' });
  return meta;
}

// modifier les infos (titre, description, année)
app.put('/edit/api/courses/:id', requireAdmin, (req, res) => {
  const meta = findCourse(req, res);
  if (!meta) return;
  const { errors, fields } = parseCourseFields(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });
  Object.assign(meta, fields);
  saveCourse(meta);
  res.json(adminView(meta));
});

// mettre à jour le .goodnotes d'un cours existant
app.post('/edit/api/courses/:id/upload', requireAdmin, upload.single('file'), (req, res) => {
  const meta = ID_RE.test(req.params.id) ? courses.get(req.params.id) : null;
  if (!meta) {
    discardUpload(req);
    return res.status(404).json({ error: 'Cours introuvable.' });
  }
  const uploadError = checkUpload(req);
  if (uploadError) {
    discardUpload(req);
    return res.status(400).json({ error: uploadError });
  }
  if (meta.status === 'processing') {
    discardUpload(req);
    return res.status(409).json({ error: 'Une conversion est déjà en cours pour ce cours.' });
  }
  enqueue({ id: meta.id, kind: 'full', uploadPath: req.file.path, sourceName: uploadedName(req) });
  res.status(202).json(adminView(courses.get(meta.id)));
});

// couleurs de remplacement du PDF à fond blanc : { "pen:#rrggbb": "#rrggbb", ... }
app.put('/edit/api/courses/:id/palette', requireAdmin, (req, res) => {
  const meta = findCourse(req, res);
  if (!meta) return;
  if (meta.status === 'processing') {
    return res.status(409).json({ error: 'Une conversion est déjà en cours pour ce cours.' });
  }
  if (!fs.existsSync(path.join(courseDir(meta.id), 'source.goodnotes'))) {
    return res.status(400).json({ error: 'Aucun .goodnotes à convertir pour ce cours.' });
  }
  const input = req.body.palette;
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return res.status(400).json({ error: 'Palette invalide.' });
  }
  const suggested = Object.fromEntries((meta.colors || []).map(c => [c.key, c.suggested]));
  const palette = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.prototype.hasOwnProperty.call(suggested, key)) continue;
    if (typeof value !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(value)) {
      return res.status(400).json({ error: `Couleur invalide pour ${key}.` });
    }
    // seules les couleurs modifiées sont gardées : les autres suivent la suggestion automatique
    if (value.toLowerCase() !== suggested[key].toLowerCase()) palette[key] = value.toLowerCase();
  }
  meta.palette = palette;
  enqueue({ id: meta.id, kind: 'palette' });
  res.status(202).json(adminView(courses.get(meta.id)));
});

app.delete('/edit/api/courses/:id', requireAdmin, (req, res) => {
  const meta = findCourse(req, res);
  if (!meta) return;
  if (meta.status === 'processing') {
    return res.status(409).json({ error: 'Une conversion est en cours pour ce cours.' });
  }
  courses.delete(meta.id);
  fs.rmSync(courseDir(meta.id), { recursive: true, force: true });
  res.json({ ok: true });
});

app.use(express.static(publicDir));

function sendPage(file) {
  return (req, res) => res.sendFile(file, { root: publicDir });
}

app.get('/edit', sendPage('edit.html'));
app.get('/edit/', sendPage('edit.html'));

// erreurs multer (fichier trop lourd...) et erreurs de parsing JSON
app.use((err, req, res, next) => {
  if (!err) return next();
  discardUpload(req);
  const message = err.code === 'LIMIT_FILE_SIZE'
    ? `Fichier trop volumineux (maximum ${MAX_UPLOAD_MB} Mo).`
    : err.message || 'Requête invalide.';
  res.status(400).json({ error: message });
});

const PORT = process.env.PORT || 3007;
app.listen(PORT, () => {
  console.log(`Cahier lancé sur http://localhost:${PORT}`);
});
