// Copies the database and uploaded files to a timestamped folder under
// backups/, then deletes backups older than the retention window. Safe to
// run while the server is up — better-sqlite3's .backup() uses SQLite's
// online backup API, so it doesn't need to lock out writers.
//
// Usage: node scripts/backup.js
// Typical cron entry (daily at 3am, keep last 14 days):
//   0 3 * * * cd /path/to/dawaat && node scripts/backup.js >> backups/backup.log 2>&1

const fs = require('fs');
const path = require('path');
const db = require('../db');

const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS, 10) || 14;
const backupsRoot = path.join(__dirname, '..', 'backups');
const uploadsDir = path.join(__dirname, '..', 'public', 'uploads');

function timestamp() {
  return new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
}

async function run() {
  const dest = path.join(backupsRoot, timestamp());
  fs.mkdirSync(dest, { recursive: true });

  console.log(`جاري النسخ الاحتياطي إلى: ${dest}`);

  await db.backup(path.join(dest, 'dawaat.db'));
  console.log('✅ تم نسخ قاعدة البيانات');

  if (fs.existsSync(uploadsDir)) {
    fs.cpSync(uploadsDir, path.join(dest, 'uploads'), { recursive: true });
    console.log('✅ تم نسخ الملفات المرفوعة (الصور والفيديوهات)');
  }

  pruneOldBackups();
  console.log('✨ انتهت عملية النسخ الاحتياطي');
}

function pruneOldBackups() {
  if (!fs.existsSync(backupsRoot)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = fs.readdirSync(backupsRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  for (const entry of entries) {
    const fullPath = path.join(backupsRoot, entry.name);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      console.log(`🗑️  حذف نسخة احتياطية قديمة: ${entry.name}`);
    }
  }
}

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ فشلت عملية النسخ الاحتياطي:', err);
    process.exit(1);
  });
