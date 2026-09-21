// Génère un hachage à coller dans le champ "hash" de data/admin-password.json.
// Usage : node scripts/hash-password.js "motdepasse"
const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Usage : node scripts/hash-password.js "motdepasse"');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');
console.log(`${salt}:${hash}`);
