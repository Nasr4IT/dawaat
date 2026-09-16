const db = require('../db');

// Arabic names won't survive a normal ASCII slugify, so we generate a short
// random, URL-safe code instead and keep the real names in the database.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous chars

function randomCode(length = 6) {
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

function uniqueOrderSlug() {
  const stmt = db.prepare('SELECT 1 FROM orders WHERE slug = ?');
  let slug;
  do {
    slug = randomCode(6);
  } while (stmt.get(slug));
  return slug;
}

module.exports = { randomCode, uniqueOrderSlug };
