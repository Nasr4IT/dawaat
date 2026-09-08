const db = require('../db');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

module.exports = { getSetting, setSetting, deleteSetting };
