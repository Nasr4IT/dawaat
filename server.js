require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const db = require('./db');
const { uniqueOrderSlug, uniqueGuestSlug } = require('./lib/slug');
const { getSetting, setSetting, deleteSetting } = require('./lib/settings');
const { notifyNewLead } = require('./lib/mailer');
const { resizeImageInPlace } = require('./lib/images');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const WHATSAPP_NUMBER = process.env.WHATSAPP_NUMBER || '';
const WHATSAPP_MESSAGE = process.env.WHATSAPP_MESSAGE || '';
const INSTAGRAM_URL = process.env.INSTAGRAM_URL || '#';

// Max pixel dimension (longest side) images get downscaled to on upload —
// keeps storage/bandwidth sane without visibly hurting quality at the sizes
// these are actually displayed at.
const PHOTO_MAX_DIMENSION = 1600;
const STICKER_MAX_DIMENSION = 640;
const HERO_MAX_DIMENSION = 1000; // hero sticker is displayed larger (up to 500px, more on wide/retina screens)

const PLAN_LABELS = { basic: 'الأساسية', featured: 'المميزة' };
const STATUS_LABELS = {
  lead: 'طلب جديد',
  confirmed: 'مؤكد',
  paid: 'مدفوع',
  published: 'منشور',
};

// ---------------------------------------------------------------------------
// Video uploads (admin can attach a file instead of pasting an external URL)
// ---------------------------------------------------------------------------
const videoUploadDir = path.join(__dirname, 'public', 'uploads', 'videos');
if (!fs.existsSync(videoUploadDir)) fs.mkdirSync(videoUploadDir, { recursive: true });

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, videoUploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    cb(null, `order-${req.params.id}-${Date.now()}${ext}`);
  },
});
const uploadVideo = multer({
  storage: videoStorage,
  limits: { fileSize: 80 * 1024 * 1024 }, // 80MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) return cb(null, true);
    cb(new Error('يجب أن يكون الملف فيديو'));
  },
});

// ---------------------------------------------------------------------------
// Couple photo uploads — from the public order form (no order id yet) and
// from admin (attached to an existing order).
// ---------------------------------------------------------------------------
const photoUploadDir = path.join(__dirname, 'public', 'uploads', 'photos');
if (!fs.existsSync(photoUploadDir)) fs.mkdirSync(photoUploadDir, { recursive: true });

const photoFileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) return cb(null, true);
  cb(new Error('يجب أن تكون الصورة بصيغة صحيحة'));
};
const PHOTO_LIMITS = { fileSize: 8 * 1024 * 1024 }; // 8MB

const leadPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, photoUploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `lead-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});
const uploadLeadPhoto = multer({ storage: leadPhotoStorage, limits: PHOTO_LIMITS, fileFilter: photoFileFilter });

function orderPhotoUploader(prefix) {
  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, photoUploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, `${prefix}-${req.params.id}-${Date.now()}${ext}`);
    },
  });
  return multer({ storage, limits: PHOTO_LIMITS, fileFilter: photoFileFilter });
}
const uploadOrderPhoto = orderPhotoUploader('order');
const uploadOrderBridePhoto = orderPhotoUploader('order-bride');
const uploadOrderGroomPhoto = orderPhotoUploader('order-groom');

// ---------------------------------------------------------------------------
// Site-wide assets: background music + background stickers + hero sticker
// override. All admin-managed, all optional — the site works fine with none
// of these set (falls back to the built-in vector illustration, no music).
// ---------------------------------------------------------------------------
const assetsDir = path.join(__dirname, 'public', 'uploads', 'assets');
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

const assetStorage = (prefix) => multer.diskStorage({
  destination: (req, file, cb) => cb(null, assetsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    cb(null, `${prefix}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`);
  },
});

const uploadMusic = multer({
  storage: assetStorage('music'),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) return cb(null, true);
    cb(new Error('يجب أن يكون الملف صوتياً (mp3 أو ما شابه)'));
  },
});

const uploadSticker = multer({
  storage: assetStorage('sticker'),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: photoFileFilter,
});

const uploadHeroSticker = multer({
  storage: assetStorage('hero-sticker'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: photoFileFilter,
});

// ---------------------------------------------------------------------------
// Multi-file upload for order-specific stickers
// ---------------------------------------------------------------------------
const uploadOrderStickers = multer({
  storage: assetStorage('order-sticker'),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: photoFileFilter,
}).array('sticker_files', 10);

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // needed for correct client IPs behind Nginx, for rate limiting

// Baseline security headers (X-Content-Type-Options, X-Frame-Options,
// Referrer-Policy, HSTS, etc). Content-Security-Policy is left off: the
// invitation/admin pages rely on inline <script>/<style> throughout and
// external fonts/CDNs, and a default CSP would break them without a much
// larger nonce-based rework.
app.use(helmet({ contentSecurityPolicy: false }));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, 'public')));

const isProduction = process.env.NODE_ENV === 'production';

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'insecure-dev-secret',
    resave: false,
    saveUninitialized: false,
    // secure requires HTTPS — only turned on in production, where the
    // reverse proxy (see `trust proxy` above) is expected to terminate TLS.
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProduction, maxAge: 1000 * 60 * 60 * 12 },
  })
);

function waLink(message) {
  const text = encodeURIComponent(message || WHATSAPP_MESSAGE);
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${text}`;
}

// Deletes a previously-uploaded local file given its public URL (e.g.
// "/assets/uploads/photos/x.jpg"). Silently does nothing for a falsy URL or
// one that isn't a local upload (an external link the admin pasted in) —
// fs.unlink on a bogus path just fails quietly, same as the site-wide
// settings routes already rely on.
function deleteUploadedAsset(url) {
  if (!url) return;
  const filePath = path.join(__dirname, 'public', url.replace('/assets/', ''));
  fs.unlink(filePath, () => {});
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.redirect('/admin/login');
}

// ---------------------------------------------------------------------------
// CSRF protection for the admin panel. Every /admin request gets a
// session-bound token exposed to templates as `csrfToken`; every
// state-changing admin request must echo it back in a `_csrf` field.
// Scoped to /admin only — the public lead/RSVP forms aren't behind a
// privileged session, so there's nothing for a forged cross-site request to
// exploit there.
// ---------------------------------------------------------------------------
app.use('/admin', (req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
});

function csrfOk(req) {
  return Boolean(req.body && req.body._csrf && req.session.csrfToken && req.body._csrf === req.session.csrfToken);
}

const CSRF_ERROR_MESSAGE = 'انتهت صلاحية الجلسة أو النموذج، يرجى إعادة تحميل الصفحة والمحاولة مرة أخرى.';

function requireCsrf(req, res, next) {
  if (csrfOk(req)) return next();
  res.status(403).send(CSRF_ERROR_MESSAGE);
}

// For multipart (file-upload) routes: express.urlencoded/json can't parse
// multipart bodies, so req.body is only populated once multer runs *inside*
// the route handler — this must be called after that, not as route
// middleware. Deletes any file multer already wrote to disk before
// rejecting, so a failed CSRF check never leaves an orphaned upload behind.
function rejectCsrfAfterUpload(req, res) {
  if (req.file) fs.unlink(req.file.path, () => {});
  if (req.files) req.files.forEach((f) => fs.unlink(f.path, () => {}));
  res.status(403).send(CSRF_ERROR_MESSAGE);
}

// Honeypot check — a hidden field real visitors never fill in. If it's
// filled, the submitter is almost certainly a bot; we pretend to succeed
// so we don't tip it off, but never touch the database.
function isHoneypotTripped(req) {
  return Boolean(req.body.website);
}

// ---------------------------------------------------------------------------
// Rate limiters — spam / abuse protection on public write endpoints.
// Skipped under the automated test suite (NODE_ENV=test): the in-memory
// counters are shared across every test in a run, and a growing suite that
// exercises login/leads/RSVP repeatedly would otherwise start tripping them
// and failing tests for reasons that have nothing to do with the code being
// tested. Production behavior is untouched.
// ---------------------------------------------------------------------------
const isTestEnv = process.env.NODE_ENV === 'test';
const noopLimiter = (req, res, next) => next();

const leadLimiter = isTestEnv ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'محاولات كثيرة، يرجى المحاولة لاحقاً' },
});

const rsvpLimiter = isTestEnv ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
});

const loginLimiter = isTestEnv ? noopLimiter : rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Public landing page
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'landing.html'));
});

// Lead-capture form from the landing page — creates a low-friction order
// record so it shows up in the admin dashboard even though fulfilment is
// still manual (per your WhatsApp-first workflow). Accepts an optional
// couple photo alongside the text fields.
app.post('/api/leads', leadLimiter, (req, res) => {
  uploadLeadPhoto.single('photo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ ok: false, error: err.message === 'يجب أن تكون الصورة بصيغة صحيحة' ? err.message : 'تعذر رفع الصورة (الحد الأقصى 8 ميجابايت)' });
    }

    if (isHoneypotTripped(req)) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.json({ ok: true }); // silently drop bots
    }

    const { groom_name, bride_name, phone, plan, event_date, note, style } = req.body;
    if (!groom_name || !bride_name || !phone) {
      return res.status(400).json({ ok: false, error: 'الاسم ورقم الهاتف مطلوبان' });
    }
    if (req.file) await resizeImageInPlace(req.file.path, PHOTO_MAX_DIMENSION);
    const validPlan = ['basic', 'featured'].includes(plan) ? plan : 'featured';
    const validStyle = ['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7'].includes(style) ? style : 'v1';
    const photoUrl = req.file ? `/assets/uploads/photos/${req.file.filename}` : null;
    const slug = uniqueOrderSlug();
    db.prepare(
      `INSERT INTO orders (slug, groom_name, bride_name, event_date, phone, plan, style, note, photo_url, status, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'lead', 'landing_form')`
    ).run(slug, groom_name.trim(), bride_name.trim(), event_date || null, phone.trim(), validPlan, validStyle, note || null, photoUrl);
    notifyNewLead({ groom_name: groom_name.trim(), bride_name: bride_name.trim(), phone: phone.trim(), plan: validPlan, event_date, note });
    res.json({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Style samples — live previews using the real invitation template, so
// customers see exactly what they'd get before ordering.
// ---------------------------------------------------------------------------
function futureDateISO(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

const SAMPLE_ORDERS = {
  v1: {
    slug: 'demo-v1', groom_name: 'عمر', bride_name: 'لجين',
    event_date: futureDateISO(45), event_time: '19:00',
    venue: 'قاعة الماسة الكبرى — دمشق', plan: 'featured', style: 'v1',
    video_url: '/assets/videos/envelope-intro.mp4',
  },
  v2: {
    slug: 'demo-v2', groom_name: 'كريم', bride_name: 'ريما',
    event_date: futureDateISO(30), event_time: '18:30',
    venue: 'حديقة الورد — دمشق', plan: 'featured', style: 'v2',
    video_url: '/assets/videos/envelope-intro.mp4',
  },
  v3: {
    slug: 'demo-v3', groom_name: 'يزن', bride_name: 'دانة',
    event_date: futureDateISO(60), event_time: '20:00',
    venue: 'فندق الشام الكبير', plan: 'featured', style: 'v3',
    video_url: '/assets/videos/envelope-intro.mp4',
  },
  v4: {
    slug: 'demo-v4', groom_name: 'سامر', bride_name: 'نور',
    event_date: futureDateISO(20), event_time: '19:30',
    venue: 'قاعة النجوم — دمشق', plan: 'featured', style: 'v4',
    video_url: '/assets/videos/envelope-intro.mp4',
  },
  v5: {
    slug: 'demo-v5', groom_name: 'وائل', bride_name: 'هبة',
    event_date: futureDateISO(50), event_time: '20:30',
    venue: 'تراس الياسمين — دمشق', plan: 'featured', style: 'v5',
    video_url: '/assets/videos/envelope-intro.mp4',
  },
  v6: {
    slug: 'demo-v6', groom_name: 'باسل', bride_name: 'مايا',
    event_date: futureDateISO(35), event_time: '18:00',
    venue: 'حديقة الأميرة — دمشق', plan: 'featured', style: 'v6',
    video_url: '/assets/videos/envelope-intro.mp4',
  },
  v7: {
    slug: 'demo-v7', groom_name: 'فادي', bride_name: 'سلمى',
    event_date: futureDateISO(40), event_time: '19:00',
    venue: 'بستان الليالي — دمشق', plan: 'featured', style: 'v7',
    video_url: '/assets/videos/envelope-intro.mp4',
  },
};

app.get('/demo/:style', (req, res) => {
  const sample = SAMPLE_ORDERS[req.params.style];
  if (!sample) return res.status(404).send('غير موجود');
  res.render('invitation', { order: sample, guest: null, waLink: waLink(), isDemo: true, BASE_URL, ...siteAssets() });
});

// ---------------------------------------------------------------------------
// Public invitation pages
// ---------------------------------------------------------------------------
function loadOrderBySlug(slug) {
  return db.prepare('SELECT * FROM orders WHERE slug = ?').get(slug);
}

// Same lookup, but also matches demo slugs — used only by the calendar
// route below, which demo pages link to as well. Must never be used by the
// RSVP routes: SAMPLE_ORDERS entries have no real `id`, so an RSVP insert
// against one would violate the orders foreign key.
function loadOrderOrSampleBySlug(slug) {
  return loadOrderBySlug(slug) || Object.values(SAMPLE_ORDERS).find((o) => o.slug === slug) || null;
}

// ---------------------------------------------------------------------------
// "Add to calendar" — countdown timer's companion, a downloadable .ics file
// for the event (featured plan, per the pricing page). Floating
// (timezone-less) local time, since the app never collects a venue timezone.
// ---------------------------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }

function icsEscape(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

function buildIcsContent(order) {
  if (!order.event_date) return null;
  const [y, m, d] = order.event_date.split('-').map(Number);
  const [hh, mm] = (order.event_time || '19:00').split(':').map(Number);
  if (!y || !m || !d) return null;

  const start = new Date(y, m - 1, d, hh || 0, mm || 0, 0);
  const end = new Date(start.getTime() + 3 * 60 * 60 * 1000); // assume a 3-hour event
  const fmt = (dt) => `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}00`;

  const now = new Date();
  const dtstamp = `${now.getUTCFullYear()}${pad2(now.getUTCMonth() + 1)}${pad2(now.getUTCDate())}T${pad2(now.getUTCHours())}${pad2(now.getUTCMinutes())}${pad2(now.getUTCSeconds())}Z`;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Dawaat//Invitation//AR',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${order.slug}@dawaat`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${icsEscape('حفل زفاف ' + order.groom_name + ' و' + order.bride_name)}`,
    order.venue ? `LOCATION:${icsEscape(order.venue)}` : null,
    `DESCRIPTION:${icsEscape('يسرنا دعوتكم لمشاركتنا فرحتنا')}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.join('\r\n');
}

// Registered before "/invite/:slug/:guestSlug" on purpose — that route's
// :guestSlug param would otherwise swallow "calendar.ics" as a guest slug.
app.get('/invite/:slug/calendar.ics', (req, res) => {
  const order = loadOrderOrSampleBySlug(req.params.slug);
  if (!order) return res.status(404).send('غير موجود');
  const ics = buildIcsContent(order);
  if (!ics) return res.status(404).send('لم يُحدد موعد الحفل بعد');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="invite-${order.slug}.ics"`);
  res.send(ics);
});

function siteAssets() {
  return {
    musicUrl: getSetting('background_music_url'),
    heroStickerUrl: getSetting('hero_sticker_url'),
    brideStickerUrl: getSetting('bride_sticker_url'),
    groomStickerUrl: getSetting('groom_sticker_url'),
    backgroundStickers: db.prepare('SELECT url FROM stickers ORDER BY created_at DESC').all().map((s) => s.url),
  };
}

app.get('/invite/:slug', (req, res) => {
  const order = loadOrderBySlug(req.params.slug);
  if (!order) return res.status(404).send('الدعوة غير موجودة');
  const globalAssets = siteAssets();
  // Use order-specific music if exists, else fallback to global
  const musicUrl = order.music_url || globalAssets.musicUrl;
  // Background stickers are order-specific only — an order with none
  // uploaded shows none, regardless of the site-wide sticker gallery.
  let backgroundStickers = [];
  if (order.sticker_urls) {
    try { backgroundStickers = JSON.parse(order.sticker_urls); } catch(e) { backgroundStickers = []; }
  }
  // Other assets (hero, bride, groom stickers) remain global
  res.render('invitation', {
    order,
    guest: null,
    waLink: waLink(),
    BASE_URL,
    musicUrl,
    backgroundStickers,
    heroStickerUrl: globalAssets.heroStickerUrl,
    brideStickerUrl: globalAssets.brideStickerUrl,
    groomStickerUrl: globalAssets.groomStickerUrl,
  });
});

app.get('/invite/:slug/:guestSlug', (req, res) => {
  const order = loadOrderBySlug(req.params.slug);
  if (!order) return res.status(404).send('الدعوة غير موجودة');
  const guest = db
    .prepare('SELECT * FROM guests WHERE order_id = ? AND slug = ?')
    .get(order.id, req.params.guestSlug);
  if (!guest) return res.status(404).send('الرابط غير صحيح');
  const globalAssets = siteAssets();
  const musicUrl = order.music_url || globalAssets.musicUrl;
  // Background stickers are order-specific only — see note above.
  let backgroundStickers = [];
  if (order.sticker_urls) {
    try { backgroundStickers = JSON.parse(order.sticker_urls); } catch(e) { backgroundStickers = []; }
  }
  res.render('invitation', {
    order,
    guest,
    waLink: waLink(),
    BASE_URL,
    musicUrl,
    backgroundStickers,
    heroStickerUrl: globalAssets.heroStickerUrl,
    brideStickerUrl: globalAssets.brideStickerUrl,
    groomStickerUrl: globalAssets.groomStickerUrl,
  });
});

app.post('/invite/:slug/rsvp', rsvpLimiter, (req, res) => {
  const isAjax = req.get('X-Requested-With') === 'XMLHttpRequest';
  const order = loadOrderBySlug(req.params.slug);
  if (!order) return isAjax ? res.status(404).json({ ok: false, error: 'الدعوة غير موجودة' }) : res.status(404).send('الدعوة غير موجودة');

  // RSVP confirmation is a featured-plan capability — enforced here too
  // (not just hidden in the UI) so it can't be used against a basic-plan
  // invitation via a direct request.
  if (order.plan === 'basic') {
    const message = 'ميزة تأكيد الحضور غير متاحة لهذه الدعوة';
    return isAjax ? res.status(403).json({ ok: false, error: message }) : res.status(403).send(message);
  }

  let guest = null;
  if (req.body.guest_slug) {
    guest = db
      .prepare('SELECT * FROM guests WHERE order_id = ? AND slug = ?')
      .get(order.id, req.body.guest_slug);
  }

  // Honeypot tripped — pretend it worked, write nothing.
  if (isHoneypotTripped(req)) {
    if (isAjax) return res.json({ ok: true });
    const backTo = guest ? `/invite/${order.slug}/${guest.slug}` : `/invite/${order.slug}`;
    return res.render('rsvp-thanks', { order, backTo });
  }

  const name = (req.body.name || (guest ? guest.name : '')).trim();
  const attending = ['yes', 'no', 'maybe'].includes(req.body.attending) ? req.body.attending : 'yes';
  const guestCount = Math.max(1, parseInt(req.body.guest_count, 10) || 1);
  const note = (req.body.note || '').trim() || null;

  if (!name) return isAjax ? res.status(400).json({ ok: false, error: 'الاسم مطلوب' }) : res.status(400).send('الاسم مطلوب');

  db.prepare(
    `INSERT INTO rsvps (order_id, guest_id, name, attending, guest_count, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(order.id, guest ? guest.id : null, name, attending, guestCount, note);

  if (isAjax) return res.json({ ok: true });

  const backTo = guest ? `/invite/${order.slug}/${guest.slug}` : `/invite/${order.slug}`;
  res.render('rsvp-thanks', { order, backTo });
});

// ---------------------------------------------------------------------------
// Admin auth
// ---------------------------------------------------------------------------
app.get('/admin/login', (req, res) => {
  res.render('admin-login', { error: null });
});

app.post('/admin/login', loginLimiter, requireCsrf, (req, res) => {
  const { username, password } = req.body;
  const hash = process.env.ADMIN_PASSWORD_HASH;

  const usernameOk = Boolean(process.env.ADMIN_USERNAME) && username === process.env.ADMIN_USERNAME;
  const passwordOk = hash ? bcrypt.compareSync(password || '', hash) : false;

  if (usernameOk && passwordOk) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: 'بيانات الدخول غير صحيحة' });
});

app.post('/admin/logout', requireCsrf, (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

// ---------------------------------------------------------------------------
// Admin dashboard
// ---------------------------------------------------------------------------
const DASHBOARD_PAGE_SIZE = 20;

app.get('/admin', requireAdmin, (req, res) => {
  const q = (req.query.q || '').trim();
  const status = ['lead', 'confirmed', 'paid', 'published'].includes(req.query.status) ? req.query.status : '';

  const where = [];
  const params = [];
  if (q) {
    const like = `%${q}%`;
    where.push('(o.groom_name LIKE ? OR o.bride_name LIKE ? OR o.phone LIKE ?)');
    params.push(like, like, like);
  }
  if (status) {
    where.push('o.status = ?');
    params.push(status);
  }
  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = db.prepare(`SELECT COUNT(*) AS n FROM orders o ${whereClause}`).get(...params).n;
  const totalPages = Math.max(1, Math.ceil(total / DASHBOARD_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), totalPages);
  const offset = (currentPage - 1) * DASHBOARD_PAGE_SIZE;

  const orders = db
    .prepare(
      `SELECT o.*,
              (SELECT COUNT(*) FROM rsvps r WHERE r.order_id = o.id) AS rsvp_count,
              (SELECT COUNT(*) FROM rsvps r WHERE r.order_id = o.id AND r.attending = 'yes') AS rsvp_yes,
              (SELECT COUNT(*) FROM guests g WHERE g.order_id = o.id) AS guest_count
       FROM orders o
       ${whereClause}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, DASHBOARD_PAGE_SIZE, offset);

  // Unseen-lead count is intentionally global (not filtered/paged) — it's a
  // notification badge, not a result count.
  const newCount = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE viewed_at IS NULL').get().n;

  const filterQS = new URLSearchParams();
  if (q) filterQS.set('q', q);
  if (status) filterQS.set('status', status);

  res.render('admin-dashboard', {
    orders, PLAN_LABELS, STATUS_LABELS, newCount,
    q, status, currentPage, totalPages, total,
    filterQS: filterQS.toString(),
  });
});

app.get('/admin/orders/new', requireAdmin, (req, res) => {
  res.render('admin-order-form', { order: null, PLAN_LABELS });
});

app.post('/admin/orders', requireAdmin, requireCsrf, (req, res) => {
  const { groom_name, bride_name, event_date, event_time, venue, plan, style, phone, note } = req.body;
  if (!groom_name || !bride_name) {
    return res.render('admin-order-form', { order: req.body, PLAN_LABELS, error: 'أسماء العروسين مطلوبة' });
  }
  const slug = uniqueOrderSlug();
  const info = db
    .prepare(
      `INSERT INTO orders (slug, groom_name, bride_name, event_date, event_time, venue, plan, style, phone, note, status, source, viewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'confirmed', 'admin', datetime('now'))`
    )
    .run(
      slug,
      groom_name.trim(),
      bride_name.trim(),
      event_date || null,
      event_time || null,
      venue || null,
      plan || 'featured',
      style || 'v1',
      phone || null,
      note || null
    );
  res.redirect(`/admin/orders/${info.lastInsertRowid}`);
});

// All the upload routes below re-render admin-order-detail with a single
// error flag set on failure — this helper fills in the rest as null so each
// route only has to name the one error key it actually cares about.
const ORDER_DETAIL_ERROR_KEYS = [
  'videoUploadError', 'photoUploadError', 'bridePhotoUploadError',
  'groomPhotoUploadError', 'musicUploadError', 'stickersUploadError',
];

function renderOrderDetail(res, orderId, overrides = {}) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).send('غير موجود');
  const guests = db.prepare('SELECT * FROM guests WHERE order_id = ? ORDER BY created_at DESC').all(order.id);
  const rsvps = db.prepare('SELECT * FROM rsvps WHERE order_id = ? ORDER BY created_at DESC').all(order.id);
  const errors = {};
  ORDER_DETAIL_ERROR_KEYS.forEach((k) => { errors[k] = null; });
  res.render('admin-order-detail', { order, guests, rsvps, PLAN_LABELS, STATUS_LABELS, BASE_URL, ...errors, ...overrides });
}

app.get('/admin/orders/:id', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('غير موجود');
  if (!order.viewed_at) {
    db.prepare("UPDATE orders SET viewed_at = datetime('now') WHERE id = ?").run(order.id);
  }
  renderOrderDetail(res, req.params.id);
});

// Text-field update. Video is handled by a separate upload route below so a
// bad video upload never risks wiping out the rest of the saved details.
app.post('/admin/orders/:id', requireAdmin, requireCsrf, (req, res) => {
  const { groom_name, bride_name, event_date, event_time, venue, plan, style, phone, note, video_url, music_url } = req.body;
  // Also we could accept sticker_urls from a text input if we wanted, but we have a separate upload.
  db.prepare(
    `UPDATE orders SET groom_name=?, bride_name=?, event_date=?, event_time=?, venue=?, plan=?, style=?, phone=?, note=?, video_url=?, music_url=?
     WHERE id = ?`
  ).run(groom_name, bride_name, event_date || null, event_time || null, venue || null, plan, style, phone || null, note || null, video_url || null, music_url || null, req.params.id);
  res.redirect(`/admin/orders/${req.params.id}`);
});

// Upload a video file directly instead of pasting an external URL.
app.post('/admin/orders/:id/video', requireAdmin, (req, res) => {
  uploadVideo.single('video_file')(req, res, (err) => {
    if (err) {
      return renderOrderDetail(res, req.params.id, {
        videoUploadError: err.message === 'يجب أن يكون الملف فيديو' ? err.message : 'تعذر رفع الفيديو (الحجم الأقصى 80 ميجابايت)',
      });
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      const order = db.prepare('SELECT video_url FROM orders WHERE id = ?').get(req.params.id);
      deleteUploadedAsset(order && order.video_url);
      const publicPath = `/assets/uploads/videos/${req.file.filename}`;
      db.prepare('UPDATE orders SET video_url = ? WHERE id = ?').run(publicPath, req.params.id);
    }
    res.redirect(`/admin/orders/${req.params.id}`);
  });
});

// Upload the couple's shared photo directly for an existing order — used as
// a fallback background watermark on the invitation when no separate
// bride/groom photos are set below.
app.post('/admin/orders/:id/photo', requireAdmin, (req, res) => {
  uploadOrderPhoto.single('photo_file')(req, res, async (err) => {
    if (err) {
      return renderOrderDetail(res, req.params.id, {
        photoUploadError: err.message === 'يجب أن تكون الصورة بصيغة صحيحة' ? err.message : 'تعذر رفع الصورة (الحجم الأقصى 8 ميجابايت)',
      });
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      await resizeImageInPlace(req.file.path, PHOTO_MAX_DIMENSION);
      const order = db.prepare('SELECT photo_url FROM orders WHERE id = ?').get(req.params.id);
      deleteUploadedAsset(order && order.photo_url);
      const publicPath = `/assets/uploads/photos/${req.file.filename}`;
      db.prepare('UPDATE orders SET photo_url = ? WHERE id = ?').run(publicPath, req.params.id);
    }
    res.redirect(`/admin/orders/${req.params.id}`);
  });
});

// Upload the bride's individual photo — shown as a faded background
// watermark on the invitation card alongside the groom's.
app.post('/admin/orders/:id/bride-photo', requireAdmin, (req, res) => {
  uploadOrderBridePhoto.single('photo_file')(req, res, async (err) => {
    if (err) {
      return renderOrderDetail(res, req.params.id, {
        bridePhotoUploadError: err.message === 'يجب أن تكون الصورة بصيغة صحيحة' ? err.message : 'تعذر رفع الصورة (الحجم الأقصى 8 ميجابايت)',
      });
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      await resizeImageInPlace(req.file.path, PHOTO_MAX_DIMENSION);
      const order = db.prepare('SELECT bride_photo_url FROM orders WHERE id = ?').get(req.params.id);
      deleteUploadedAsset(order && order.bride_photo_url);
      const publicPath = `/assets/uploads/photos/${req.file.filename}`;
      db.prepare('UPDATE orders SET bride_photo_url = ? WHERE id = ?').run(publicPath, req.params.id);
    }
    res.redirect(`/admin/orders/${req.params.id}`);
  });
});

// Upload the groom's individual photo — same idea, mirrored.
app.post('/admin/orders/:id/groom-photo', requireAdmin, (req, res) => {
  uploadOrderGroomPhoto.single('photo_file')(req, res, async (err) => {
    if (err) {
      return renderOrderDetail(res, req.params.id, {
        groomPhotoUploadError: err.message === 'يجب أن تكون الصورة بصيغة صحيحة' ? err.message : 'تعذر رفع الصورة (الحجم الأقصى 8 ميجابايت)',
      });
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      await resizeImageInPlace(req.file.path, PHOTO_MAX_DIMENSION);
      const order = db.prepare('SELECT groom_photo_url FROM orders WHERE id = ?').get(req.params.id);
      deleteUploadedAsset(order && order.groom_photo_url);
      const publicPath = `/assets/uploads/photos/${req.file.filename}`;
      db.prepare('UPDATE orders SET groom_photo_url = ? WHERE id = ?').run(publicPath, req.params.id);
    }
    res.redirect(`/admin/orders/${req.params.id}`);
  });
});

// ---------------------------------------------------------------------------
// NEW: Order-specific music upload (file)
// ---------------------------------------------------------------------------
app.post('/admin/orders/:id/music', requireAdmin, (req, res) => {
  uploadMusic.single('music_file')(req, res, (err) => {
    if (err) {
      return renderOrderDetail(res, req.params.id, {
        musicUploadError: err.message === 'يجب أن يكون الملف صوتياً (mp3 أو ما شابه)' ? err.message : 'تعذر رفع الملف الصوتي (الحجم الأقصى 15 ميجابايت)',
      });
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      const order = db.prepare('SELECT music_url FROM orders WHERE id = ?').get(req.params.id);
      deleteUploadedAsset(order && order.music_url);
      const publicPath = `/assets/uploads/assets/${req.file.filename}`;
      db.prepare('UPDATE orders SET music_url = ? WHERE id = ?').run(publicPath, req.params.id);
    }
    res.redirect(`/admin/orders/${req.params.id}`);
  });
});

// ---------------------------------------------------------------------------
// NEW: Order-specific stickers upload (multiple files). New uploads are
// ADDED to the existing set rather than replacing it, so admins can build up
// a collection over several uploads and remove individual ones separately.
// ---------------------------------------------------------------------------
app.post('/admin/orders/:id/stickers', requireAdmin, (req, res) => {
  uploadOrderStickers(req, res, async (err) => {
    if (err) {
      return renderOrderDetail(res, req.params.id, {
        stickersUploadError: err.message === 'يجب أن تكون الصورة بصيغة صحيحة' ? err.message : 'تعذر رفع الصور (الحد الأقصى 5 ميجابايت لكل صورة)',
      });
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.files && req.files.length > 0) {
      await Promise.all(req.files.map((f) => resizeImageInPlace(f.path, STICKER_MAX_DIMENSION)));
      const order = db.prepare('SELECT sticker_urls FROM orders WHERE id = ?').get(req.params.id);
      let existing = [];
      if (order && order.sticker_urls) {
        try { existing = JSON.parse(order.sticker_urls); } catch (e) { existing = []; }
      }
      const newUrls = req.files.map(f => `/assets/uploads/assets/${f.filename}`);
      db.prepare('UPDATE orders SET sticker_urls = ? WHERE id = ?').run(JSON.stringify([...existing, ...newUrls]), req.params.id);
    }
    res.redirect(`/admin/orders/${req.params.id}`);
  });
});

// Delete a single order-specific sticker by its index in the saved array.
app.post('/admin/orders/:id/stickers/:index/delete', requireAdmin, requireCsrf, (req, res) => {
  const order = db.prepare('SELECT sticker_urls FROM orders WHERE id = ?').get(req.params.id);
  let stickers = [];
  if (order && order.sticker_urls) {
    try { stickers = JSON.parse(order.sticker_urls); } catch (e) { stickers = []; }
  }
  const index = Number(req.params.index);
  if (Number.isInteger(index) && index >= 0 && index < stickers.length) {
    const [removed] = stickers.splice(index, 1);
    deleteUploadedAsset(removed);
    db.prepare('UPDATE orders SET sticker_urls = ? WHERE id = ?').run(stickers.length ? JSON.stringify(stickers) : null, req.params.id);
  }
  res.redirect(`/admin/orders/${req.params.id}`);
});

// Remove the order-specific music track (file or URL) without uploading a
// replacement.
app.post('/admin/orders/:id/music/delete', requireAdmin, requireCsrf, (req, res) => {
  const order = db.prepare('SELECT music_url FROM orders WHERE id = ?').get(req.params.id);
  deleteUploadedAsset(order && order.music_url);
  db.prepare('UPDATE orders SET music_url = NULL WHERE id = ?').run(req.params.id);
  res.redirect(`/admin/orders/${req.params.id}`);
});

// ---------------------------------------------------------------------------
// NEW: Order-specific music URL (text field) - separate from file upload
// ---------------------------------------------------------------------------
app.post('/admin/orders/:id/music-url', requireAdmin, requireCsrf, (req, res) => {
  const { music_url } = req.body;
  const order = db.prepare('SELECT music_url FROM orders WHERE id = ?').get(req.params.id);
  if (order && order.music_url && order.music_url !== music_url) {
    deleteUploadedAsset(order.music_url);
  }
  db.prepare('UPDATE orders SET music_url = ? WHERE id = ?').run(music_url || null, req.params.id);
  res.redirect(`/admin/orders/${req.params.id}`);
});

app.post('/admin/orders/:id/status', requireAdmin, requireCsrf, (req, res) => {
  const { status } = req.body;
  if (!['lead', 'confirmed', 'paid', 'published'].includes(status)) {
    return res.status(400).send('حالة غير صحيحة');
  }
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  res.redirect(`/admin/orders/${req.params.id}`);
});

app.post('/admin/orders/:id/delete', requireAdmin, requireCsrf, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (order) {
    [order.video_url, order.photo_url, order.bride_photo_url, order.groom_photo_url, order.music_url]
      .forEach(deleteUploadedAsset);
    if (order.sticker_urls) {
      try { JSON.parse(order.sticker_urls).forEach(deleteUploadedAsset); } catch (e) { /* malformed, nothing to clean up */ }
    }
  }
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.redirect('/admin');
});

// Guest-specific personalized invite links — available regardless of plan.
app.post('/admin/orders/:id/guests', requireAdmin, requireCsrf, (req, res) => {
  const orderId = req.params.id;
  const name = (req.body.name || '').trim();
  if (name) {
    const slug = uniqueGuestSlug(orderId);
    db.prepare('INSERT INTO guests (order_id, name, slug) VALUES (?, ?, ?)').run(orderId, name, slug);
  }
  res.redirect(`/admin/orders/${orderId}`);
});

app.post('/admin/orders/:id/guests/:guestId/delete', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM guests WHERE id = ? AND order_id = ?').run(req.params.guestId, req.params.id);
  res.redirect(`/admin/orders/${req.params.id}`);
});

// Removes a spam/duplicate/mistaken RSVP entry. Scoped to order_id in the
// WHERE clause (not just the RSVP's own id) so a guessed/forged rsvpId can
// never delete a response belonging to a different order.
app.post('/admin/orders/:id/rsvps/:rsvpId/delete', requireAdmin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM rsvps WHERE id = ? AND order_id = ?').run(req.params.rsvpId, req.params.id);
  res.redirect(`/admin/orders/${req.params.id}`);
});

// CSV export of RSVPs for one order — for headcount planning with the venue/caterer.
app.get('/admin/orders/:id/rsvps.csv', requireAdmin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).send('غير موجود');
  const rsvps = db.prepare('SELECT * FROM rsvps WHERE order_id = ? ORDER BY created_at ASC').all(order.id);

  const esc = (val) => {
    const s = String(val === null || val === undefined ? '' : val);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const attendingLabel = { yes: 'حاضر', no: 'غير حاضر', maybe: 'ربما' };

  const rows = [['الاسم', 'الحضور', 'عدد الأشخاص', 'ملاحظة', 'التاريخ']];
  rsvps.forEach((r) => {
    rows.push([r.name, attendingLabel[r.attending] || r.attending, r.guest_count, r.note || '', r.created_at]);
  });
  const csv = '\uFEFF' + rows.map((row) => row.map(esc).join(',')).join('\n'); // BOM so Excel shows Arabic correctly

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="rsvps-${order.slug}.csv"`);
  res.send(csv);
});

// ---------------------------------------------------------------------------
// Site-wide settings: background music, background stickers, hero sticker,
// bride sticker, groom sticker.
// These apply to every invitation, not one specific order.
// ---------------------------------------------------------------------------
function renderSettings(res, error) {
  res.render('admin-settings', {
    musicUrl: getSetting('background_music_url'),
    heroStickerUrl: getSetting('hero_sticker_url'),
    brideStickerUrl: getSetting('bride_sticker_url'),
    groomStickerUrl: getSetting('groom_sticker_url'),
    backgroundStickers: db.prepare('SELECT * FROM stickers ORDER BY created_at DESC').all(),
    error: error || null,
  });
}

app.get('/admin/settings', requireAdmin, (req, res) => {
  renderSettings(res, null);
});

app.post('/admin/settings/music', requireAdmin, (req, res) => {
  uploadMusic.single('music_file')(req, res, (err) => {
    if (err) {
      return renderSettings(res, err.message === 'يجب أن يكون الملف صوتياً (mp3 أو ما شابه)' ? err.message : 'تعذر رفع الملف الصوتي (الحد الأقصى 15 ميجابايت)');
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      const oldUrl = getSetting('background_music_url');
      if (oldUrl) {
        const oldPath = path.join(__dirname, 'public', oldUrl.replace('/assets/', ''));
        fs.unlink(oldPath, () => {});
      }
      setSetting('background_music_url', `/assets/uploads/assets/${req.file.filename}`);
    }
    res.redirect('/admin/settings');
  });
});

app.post('/admin/settings/music/delete', requireAdmin, requireCsrf, (req, res) => {
  const oldUrl = getSetting('background_music_url');
  if (oldUrl) {
    const oldPath = path.join(__dirname, 'public', oldUrl.replace('/assets/', ''));
    fs.unlink(oldPath, () => {});
  }
  deleteSetting('background_music_url');
  res.redirect('/admin/settings');
});

app.post('/admin/settings/hero-sticker', requireAdmin, (req, res) => {
  uploadHeroSticker.single('sticker_file')(req, res, async (err) => {
    if (err) {
      return renderSettings(res, err.message === 'يجب أن تكون الصورة بصيغة صحيحة' ? err.message : 'تعذر رفع الصورة (الحد الأقصى 5 ميجابايت)');
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      await resizeImageInPlace(req.file.path, HERO_MAX_DIMENSION);
      const oldUrl = getSetting('hero_sticker_url');
      if (oldUrl) {
        const oldPath = path.join(__dirname, 'public', oldUrl.replace('/assets/', ''));
        fs.unlink(oldPath, () => {});
      }
      setSetting('hero_sticker_url', `/assets/uploads/assets/${req.file.filename}`);
    }
    res.redirect('/admin/settings');
  });
});

app.post('/admin/settings/hero-sticker/delete', requireAdmin, requireCsrf, (req, res) => {
  const oldUrl = getSetting('hero_sticker_url');
  if (oldUrl) {
    const oldPath = path.join(__dirname, 'public', oldUrl.replace('/assets/', ''));
    fs.unlink(oldPath, () => {});
  }
  deleteSetting('hero_sticker_url');
  res.redirect('/admin/settings');
});

// Bride sticker
app.post('/admin/settings/bride-sticker', requireAdmin, (req, res) => {
  uploadHeroSticker.single('sticker_file')(req, res, async (err) => {
    if (err) {
      return renderSettings(res, err.message === 'يجب أن تكون الصورة بصيغة صحيحة' ? err.message : 'تعذر رفع الصورة (الحد الأقصى 5 ميجابايت)');
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      await resizeImageInPlace(req.file.path, STICKER_MAX_DIMENSION);
      const oldUrl = getSetting('bride_sticker_url');
      if (oldUrl) {
        const oldPath = path.join(__dirname, 'public', oldUrl.replace('/assets/', ''));
        fs.unlink(oldPath, () => {});
      }
      setSetting('bride_sticker_url', `/assets/uploads/assets/${req.file.filename}`);
    }
    res.redirect('/admin/settings');
  });
});

app.post('/admin/settings/bride-sticker/delete', requireAdmin, requireCsrf, (req, res) => {
  const oldUrl = getSetting('bride_sticker_url');
  if (oldUrl) {
    const oldPath = path.join(__dirname, 'public', oldUrl.replace('/assets/', ''));
    fs.unlink(oldPath, () => {});
  }
  deleteSetting('bride_sticker_url');
  res.redirect('/admin/settings');
});

// Groom sticker
app.post('/admin/settings/groom-sticker', requireAdmin, (req, res) => {
  uploadHeroSticker.single('sticker_file')(req, res, async (err) => {
    if (err) {
      return renderSettings(res, err.message === 'يجب أن تكون الصورة بصيغة صحيحة' ? err.message : 'تعذر رفع الصورة (الحد الأقصى 5 ميجابايت)');
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      await resizeImageInPlace(req.file.path, STICKER_MAX_DIMENSION);
      const oldUrl = getSetting('groom_sticker_url');
      if (oldUrl) {
        const oldPath = path.join(__dirname, 'public', oldUrl.replace('/assets/', ''));
        fs.unlink(oldPath, () => {});
      }
      setSetting('groom_sticker_url', `/assets/uploads/assets/${req.file.filename}`);
    }
    res.redirect('/admin/settings');
  });
});

app.post('/admin/settings/groom-sticker/delete', requireAdmin, requireCsrf, (req, res) => {
  const oldUrl = getSetting('groom_sticker_url');
  if (oldUrl) {
    const oldPath = path.join(__dirname, 'public', oldUrl.replace('/assets/', ''));
    fs.unlink(oldPath, () => {});
  }
  deleteSetting('groom_sticker_url');
  res.redirect('/admin/settings');
});

// Background stickers are a gallery (many), unlike music/hero sticker (one each).
app.post('/admin/settings/stickers', requireAdmin, (req, res) => {
  uploadSticker.single('sticker_file')(req, res, async (err) => {
    if (err) {
      return renderSettings(res, err.message === 'يجب أن تكون الصورة بصيغة صحيحة' ? err.message : 'تعذر رفع الصورة (الحد الأقصى 5 ميجابايت)');
    }
    if (!csrfOk(req)) return rejectCsrfAfterUpload(req, res);
    if (req.file) {
      await resizeImageInPlace(req.file.path, STICKER_MAX_DIMENSION);
      const publicPath = `/assets/uploads/assets/${req.file.filename}`;
      db.prepare('INSERT INTO stickers (url) VALUES (?)').run(publicPath);
    }
    res.redirect('/admin/settings');
  });
});

app.post('/admin/settings/stickers/:id/delete', requireAdmin, requireCsrf, (req, res) => {
  const sticker = db.prepare('SELECT * FROM stickers WHERE id = ?').get(req.params.id);
  if (sticker) {
    const filePath = path.join(__dirname, 'public', sticker.url.replace('/assets/', ''));
    fs.unlink(filePath, () => {});
    db.prepare('DELETE FROM stickers WHERE id = ?').run(req.params.id);
  }
  res.redirect('/admin/settings');
});

// ---------------------------------------------------------------------------
// Fallbacks — never leak stack traces to a guest
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).send('الصفحة غير موجودة');
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('حدث خطأ غير متوقع، يرجى المحاولة لاحقاً');
});

if (require.main === module) {
  app.listen(PORT, () => {
    if (!process.env.ADMIN_PASSWORD_HASH) {
      console.warn(
        '\n⚠️  ADMIN_PASSWORD_HASH is not set in .env — admin login will not work.\n' +
        '   Run: node scripts/hash-password.js "yourPassword"  and paste the result into .env\n'
      );
    }
    if (!process.env.ADMIN_USERNAME) {
      console.warn(
        '⚠️  ADMIN_USERNAME is not set in .env — admin login will not work.\n'
      );
    }
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'change-this-to-a-long-random-string') {
      console.warn(
        '⚠️  SESSION_SECRET looks like a placeholder — run: node scripts/generate-secret.js\n'
      );
    }
    console.log(`Dawaat backend running on http://localhost:${PORT}`);
  });
}

module.exports = app;