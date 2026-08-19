const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// Mot de passe admin : défini via variable d'environnement sur Render.
// Si aucune variable n'est définie (ex: en local), on retombe sur une valeur
// par défaut UNIQUEMENT pour ne pas bloquer les tests en local.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'ChangeMoi123!';

// Dossier pour les uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Base de données SQLite
const db = new Database(path.join(__dirname, 'database.db'));

// --- Tables ---
db.exec(`
  CREATE TABLE IF NOT EXISTS actu (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    image TEXT,
    category TEXT DEFAULT 'Général',
    date DATETIME DEFAULT CURRENT_TIMESTAMP,
    react_like INTEGER DEFAULT 0,
    react_love INTEGER DEFAULT 0,
    react_wow INTEGER DEFAULT 0,
    react_angry INTEGER DEFAULT 0
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  )
`);

// Catégories de base si la table est vide
const catCount = db.prepare('SELECT COUNT(*) AS c FROM categories').get().c;
if (catCount === 0) {
  const insertCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
  ['Général', 'Gaming', 'Mises à jour'].forEach(name => insertCat.run(name));
}

// --- Réparation auto si la base existait déjà sans les nouvelles colonnes ---
const existingCols = db.prepare("PRAGMA table_info(actu)").all().map(c => c.name);
const colsToAdd = [
  ['category', "TEXT DEFAULT 'Général'"],
  ['react_like', 'INTEGER DEFAULT 0'],
  ['react_love', 'INTEGER DEFAULT 0'],
  ['react_wow', 'INTEGER DEFAULT 0'],
  ['react_angry', 'INTEGER DEFAULT 0'],
];
colsToAdd.forEach(([name, def]) => {
  if (!existingCols.includes(name)) {
    db.exec(`ALTER TABLE actu ADD COLUMN ${name} ${def}`);
  }
});

// Configuration de Multer pour les fichiers joints aux actualités
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } }); // 25 Mo max

// Middlewares
app.use(express.json());

// Support si les HTML sont à la racine OU dans un dossier public
const publicDir = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;

app.use(express.static(publicDir));
app.use('/uploads', express.static(uploadDir));

// --- Middleware d'authentification admin ---
// Le mot de passe n'est plus stocké dans le code HTML/JS envoyé au visiteur.
// Le panneau admin l'envoie dans l'en-tête "x-admin-password" à chaque requête protégée.
function requireAdmin(req, res, next) {
  const provided = req.header('x-admin-password');
  if (provided && provided === ADMIN_PASSWORD) {
    return next();
  }
  return res.status(401).json({ error: 'Non autorisé' });
}

// --- ROUTES PAGES HTML ---

app.get('/', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(publicDir, 'admin.html'));
});

// --- ROUTE DE CONNEXION ADMIN ---
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (password && password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }
  return res.status(401).json({ success: false, error: 'Mot de passe incorrect' });
});

// --- ROUTES API ACTUALITÉS ---

// Liste + recherche : GET /api/actu?q=motcle
app.get('/api/actu', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let articles;
    if (q) {
      const like = `%${q}%`;
      articles = db.prepare(
        'SELECT * FROM actu WHERE title LIKE ? OR content LIKE ? ORDER BY date DESC'
      ).all(like, like);
    } else {
      articles = db.prepare('SELECT * FROM actu ORDER BY date DESC').all();
    }
    res.json(articles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/actu', requireAdmin, upload.single('image'), (req, res) => {
  try {
    const { title, content } = req.body;
    const category = (req.body.category || 'Général').trim() || 'Général';

    if (!title || !title.trim() || !content || !content.trim()) {
      return res.status(400).json({ error: 'Titre et contenu sont obligatoires.' });
    }

    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;

    const stmt = db.prepare(
      'INSERT INTO actu (title, content, image, category) VALUES (?, ?, ?, ?)'
    );
    const result = stmt.run(title.trim(), content.trim(), imagePath, category);

    res.json({ id: result.lastInsertRowid, title, content, image: imagePath, category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/actu/:id', requireAdmin, (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM actu WHERE id = ?');
    stmt.run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- RÉACTIONS RAPIDES (publique, en un clic) ---
const ALLOWED_REACTIONS = {
  like: 'react_like',
  love: 'react_love',
  wow: 'react_wow',
  angry: 'react_angry',
};

app.post('/api/actu/:id/react', (req, res) => {
  try {
    const { type } = req.body || {};
    const column = ALLOWED_REACTIONS[type];
    if (!column) {
      return res.status(400).json({ error: 'Type de réaction invalide.' });
    }
    db.prepare(`UPDATE actu SET ${column} = ${column} + 1 WHERE id = ?`).run(req.params.id);
    const updated = db.prepare('SELECT id, react_like, react_love, react_wow, react_angry FROM actu WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- CATÉGORIES ---

app.get('/api/categories', (req, res) => {
  try {
    const categories = db.prepare('SELECT name FROM categories ORDER BY name ASC').all().map(c => c.name);
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/categories', requireAdmin, (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Nom de catégorie vide.' });
    }
    db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(name);
    const categories = db.prepare('SELECT name FROM categories ORDER BY name ASC').all().map(c => c.name);
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Suppression d'une catégorie. Les articles déjà publiés avec cette
// catégorie gardent simplement son nom en texte (ils ne sont pas supprimés).
app.delete('/api/categories/:name', requireAdmin, (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    db.prepare('DELETE FROM categories WHERE name = ?').run(name);
    const categories = db.prepare('SELECT name FROM categories ORDER BY name ASC').all().map(c => c.name);
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- MÉTÉO (proxy vers Open-Meteo, 100% gratuit, sans clé API) ---
// On passe par le serveur pour éviter tout souci de CORS côté navigateur.
app.get('/api/weather', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || 48.8566; // Paris par défaut
    const lon = parseFloat(req.query.lon) || 2.3522;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code&timezone=auto`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Service météo indisponible');
    const data = await response.json();

    res.json({
      temperature: data.current?.temperature_2m,
      weatherCode: data.current?.weather_code,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur démarré sur http://localhost:${PORT}`);
});
