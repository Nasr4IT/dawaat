'use strict';

// ---------------------------------------------------------------------------
// Point the app at a throwaway SQLite file and a fixed admin login BEFORE
// requiring server.js, since it reads these into top-level consts at load
// time. node's test runner gives each test file its own process, so this
// doesn't leak into other test files.
// ---------------------------------------------------------------------------
const os = require('os');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

const tmpDbPath = path.join(os.tmpdir(), `dawaat-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDbPath;
process.env.NODE_ENV = 'test'; // exempts rate limiters — see server.js

process.env.ADMIN_USERNAME = 'testadmin';
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('testpassword123', 4);
process.env.SESSION_SECRET = 'test-secret-not-for-prod';
process.env.WHATSAPP_NUMBER = '10000000000';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const sharp = require('sharp');

const app = require('../server');
const db = require('../db');

test.after(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(tmpDbPath + suffix); } catch (e) { /* already gone */ }
  }
});

// Every admin page carries a hidden `_csrf` field bound to the session; grab
// it from whatever admin HTML was last rendered so state-changing requests
// can echo it back the same way a real browser form submission would.
function extractCsrf(html) {
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error('no CSRF token found in page');
  return match[1];
}

// Logs the given supertest agent in as the test admin and returns the CSRF
// token bound to that session — reuse it for every subsequent POST on the
// same agent (the token doesn't change until the session does).
async function loginAsAdmin(agent) {
  const loginPage = await agent.get('/admin/login');
  const csrf = extractCsrf(loginPage.text);
  await agent.post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123', _csrf: csrf });
  return csrf;
}

test('GET / serves the landing page', async () => {
  const res = await request(app).get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /دعوات/);
});

test('GET /demo/v1 renders a sample invitation with an RSVP note instead of a live form', async () => {
  const res = await request(app).get('/demo/v1');
  assert.equal(res.status, 200);
  assert.match(res.text, /rsvp-demo-note/);
  assert.doesNotMatch(res.text, /id="rsvpForm"/);
});

test('GET /demo/does-not-exist returns 404', async () => {
  const res = await request(app).get('/demo/v99');
  assert.equal(res.status, 404);
});

test('POST /api/leads creates a lead order', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const res = await request(app)
    .post('/api/leads')
    .type('form')
    .send({ groom_name: 'أحمد', bride_name: 'سارة', phone: '0999999999', plan: 'featured', style: 'v2' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const after = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  assert.equal(after, before + 1);
  const row = db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.groom_name, 'أحمد');
  assert.equal(row.status, 'lead');
  assert.equal(row.source, 'landing_form');
});

test('POST /api/leads rejects missing required fields', async () => {
  const res = await request(app)
    .post('/api/leads')
    .type('form')
    .send({ groom_name: 'ناقص' });
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

test('POST /api/leads silently drops honeypot-tripped submissions', async () => {
  const before = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  const res = await request(app)
    .post('/api/leads')
    .type('form')
    .send({ groom_name: 'بوت', bride_name: 'بوت', phone: '123', website: 'http://spam.example' });
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  const after = db.prepare('SELECT COUNT(*) AS n FROM orders').get().n;
  assert.equal(after, before, 'honeypot submission must not create a row');
});

test('admin routes redirect to login when unauthenticated', async () => {
  const res = await request(app).get('/admin');
  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/admin\/login/);
});

test('admin login rejects wrong credentials and accepts right ones', async () => {
  const wrongAgent = request.agent(app);
  const wrongCsrf = extractCsrf((await wrongAgent.get('/admin/login')).text);
  const wrong = await wrongAgent.post('/admin/login').type('form').send({ username: 'testadmin', password: 'wrong', _csrf: wrongCsrf });
  assert.equal(wrong.status, 200);
  assert.match(wrong.text, /غير صحيحة/);

  const agent = request.agent(app);
  const csrf = extractCsrf((await agent.get('/admin/login')).text);
  const right = await agent.post('/admin/login').type('form').send({ username: 'testadmin', password: 'testpassword123', _csrf: csrf });
  assert.equal(right.status, 302);
  assert.match(right.headers.location, /\/admin$/);

  const dashboard = await agent.get('/admin');
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.text, /الطلبات/);
});

test('admin login rejects a request with no username field (defensive check)', async () => {
  // Regression test: usernameOk must not evaluate true just because both
  // sides are undefined when ADMIN_USERNAME or the form field is missing.
  const agent = request.agent(app);
  const csrf = extractCsrf((await agent.get('/admin/login')).text);
  const res = await agent.post('/admin/login').type('form').send({ password: 'testpassword123', _csrf: csrf });
  assert.equal(res.status, 200);
  assert.match(res.text, /غير صحيحة/);
});

test('admin POST without a valid CSRF token is rejected', async () => {
  const agent = request.agent(app);
  await loginAsAdmin(agent);
  const res = await agent.post('/admin/orders').type('form').send({ groom_name: 'بلا', bride_name: 'رمز' });
  assert.equal(res.status, 403);
  const created = db.prepare("SELECT * FROM orders WHERE groom_name = 'بلا' AND bride_name = 'رمز'").get();
  assert.equal(created, undefined, 'no order should be created without a valid CSRF token');
});

test('full order + RSVP flow: create order, load invite page, submit RSVP', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);

  const create = await agent
    .post('/admin/orders')
    .type('form')
    .send({ groom_name: 'كريم', bride_name: 'ليلى', plan: 'luxury', style: 'v3', _csrf: csrf });
  assert.equal(create.status, 302);
  const orderId = create.headers.location.split('/').pop();

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  assert.ok(order, 'order should exist');

  const invitePage = await request(app).get(`/invite/${order.slug}`);
  assert.equal(invitePage.status, 200);
  assert.match(invitePage.text, new RegExp(`action="/invite/${order.slug}/rsvp"`));

  // This mirrors exactly what the invitation page's JS sends: a
  // urlencoded body via fetch (NOT multipart/form-data, which
  // express.urlencoded() cannot parse) — this is the shape of a bug
  // caught during manual testing, pinned here as a regression test.
  const rsvp = await request(app)
    .post(`/invite/${order.slug}/rsvp`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form')
    .send({ name: 'ضيف الاختبار', attending: 'yes', guest_count: '2', note: '' });
  assert.equal(rsvp.status, 200);
  assert.equal(rsvp.body.ok, true);

  const savedRsvp = db.prepare('SELECT * FROM rsvps WHERE order_id = ?').get(order.id);
  assert.equal(savedRsvp.name, 'ضيف الاختبار');
  assert.equal(savedRsvp.attending, 'yes');
  assert.equal(savedRsvp.guest_count, 2);
});

test('RSVP submission sent as multipart/form-data is rejected as missing a name (documents the pitfall)', async () => {
  const slug = 'test-multipart-slug';
  db.prepare("INSERT INTO orders (slug, groom_name, bride_name) VALUES (?, 'م', 'ف')").run(slug);
  const res = await request(app)
    .post(`/invite/${slug}/rsvp`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .field('name', 'ضيف')
    .field('attending', 'yes');
  // express.urlencoded() does not parse multipart bodies, so req.body is
  // empty and this correctly fails validation rather than silently saving
  // a garbled/empty RSVP.
  assert.equal(res.status, 400);
  assert.equal(res.body.ok, false);
});

test('RSVP on an unknown order slug returns 404', async () => {
  const res = await request(app)
    .post('/invite/does-not-exist/rsvp')
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form')
    .send({ name: 'ضيف' });
  assert.equal(res.status, 404);
});

test('new leads show up as unviewed on the dashboard until opened', async () => {
  const agent = request.agent(app);
  await loginAsAdmin(agent);

  await request(app)
    .post('/api/leads')
    .type('form')
    .send({ groom_name: 'وسيم', bride_name: 'رنا', phone: '0988888888' });

  const lead = db.prepare("SELECT * FROM orders WHERE groom_name = 'وسيم' ORDER BY id DESC LIMIT 1").get();
  assert.equal(lead.viewed_at, null);

  const dashboardBefore = await agent.get('/admin');
  assert.match(dashboardBefore.text, /row-new/);

  await agent.get(`/admin/orders/${lead.id}`);
  const afterView = db.prepare('SELECT viewed_at FROM orders WHERE id = ?').get(lead.id);
  assert.ok(afterView.viewed_at, 'viewed_at should be set after opening the order');
});

test('orders created directly by admin are not flagged as new leads', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'يدوي', bride_name: 'يدوية', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();
  const order = db.prepare('SELECT viewed_at FROM orders WHERE id = ?').get(orderId);
  assert.ok(order.viewed_at, 'admin-created orders should already be marked viewed');
});

test('an uploaded lead photo gets downscaled on disk', async () => {
  const bigImage = await sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 150, b: 90 } },
  }).jpeg().toBuffer();

  const res = await request(app)
    .post('/api/leads')
    .field('groom_name', 'صورة')
    .field('bride_name', 'كبيرة')
    .field('phone', '0955555555')
    .attach('photo', bigImage, 'big.jpg');

  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);

  const order = db.prepare("SELECT * FROM orders WHERE groom_name = 'صورة' ORDER BY id DESC LIMIT 1").get();
  assert.ok(order.photo_url, 'photo_url should be saved');

  const diskPath = path.join(__dirname, '..', 'public', order.photo_url.replace('/assets/', ''));
  const meta = await sharp(diskPath).metadata();
  assert.ok(meta.width <= 1600 && meta.height <= 1600, `expected downscaled image, got ${meta.width}x${meta.height}`);

  fs.unlinkSync(diskPath); // clean up the test upload from public/uploads/
});

test('dashboard search filters by name/phone and status', async () => {
  const agent = request.agent(app);
  await loginAsAdmin(agent);

  db.prepare("INSERT INTO orders (slug, groom_name, bride_name, phone, status, viewed_at) VALUES ('search-slug-1','زيدونيق','هبة','0777000111','paid', datetime('now'))").run();
  db.prepare("INSERT INTO orders (slug, groom_name, bride_name, phone, status, viewed_at) VALUES ('search-slug-2','آخر','آخرى','0777000222','lead', datetime('now'))").run();

  const byName = await agent.get('/admin').query({ q: 'زيدونيق' });
  assert.match(byName.text, /زيدونيق/);
  assert.doesNotMatch(byName.text, /آخرى/);

  const byPhone = await agent.get('/admin').query({ q: '0777000222' });
  assert.match(byPhone.text, /آخر وآخرى/);
  assert.doesNotMatch(byPhone.text, /زيدونيق/);

  const byStatus = await agent.get('/admin').query({ status: 'paid', q: 'زيدونيق' });
  assert.match(byStatus.text, /زيدونيق/);

  const byWrongStatus = await agent.get('/admin').query({ status: 'lead', q: 'زيدونيق' });
  assert.match(byWrongStatus.text, /لا توجد طلبات مطابقة/);
  assert.doesNotMatch(byWrongStatus.text, />زيدونيق</);
});

test('dashboard paginates results', async () => {
  const agent = request.agent(app);
  await loginAsAdmin(agent);

  const insert = db.prepare("INSERT INTO orders (slug, groom_name, bride_name, viewed_at) VALUES (?, ?, 'صفحات', datetime('now'))");
  for (let i = 0; i < 25; i++) {
    insert.run(`page-slug-${i}`, `صفحة${i}`);
  }

  const page1 = await agent.get('/admin').query({ q: 'صفحات', page: 1 });
  assert.match(page1.text, /صفحة 1 من 2/);
  const page1Matches = page1.text.match(/صفحة\d+/g) || [];
  assert.equal(page1Matches.length, 20);

  const page2 = await agent.get('/admin').query({ q: 'صفحات', page: 2 });
  assert.match(page2.text, /صفحة 2 من 2/);
  const page2Matches = page2.text.match(/صفحة\d+/g) || [];
  assert.equal(page2Matches.length, 5);
});

test('guest-specific invite link personalizes the RSVP form', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);

  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'سامي', bride_name: 'هند', plan: 'luxury', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);

  await agent.post(`/admin/orders/${order.id}/guests`).type('form').send({ name: 'خالد الضيف', _csrf: csrf });
  const guest = db.prepare('SELECT * FROM guests WHERE order_id = ?').get(order.id);
  assert.ok(guest);

  const guestPage = await request(app).get(`/invite/${order.slug}/${guest.slug}`);
  assert.equal(guestPage.status, 200);
  assert.match(guestPage.text, /خالد الضيف/);
  assert.match(guestPage.text, new RegExp(`name="guest_slug" value="${guest.slug}"`));
});

test('re-uploading a photo deletes the old file from disk', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'ملف', bride_name: 'قديم', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();

  const img = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();

  await agent.post(`/admin/orders/${orderId}/bride-photo`).field('_csrf', csrf).attach('photo_file', img, 'first.jpg');
  const afterFirst = db.prepare('SELECT bride_photo_url FROM orders WHERE id = ?').get(orderId);
  const firstDiskPath = path.join(__dirname, '..', 'public', afterFirst.bride_photo_url.replace('/assets/', ''));
  assert.ok(fs.existsSync(firstDiskPath), 'first uploaded file should exist');

  await agent.post(`/admin/orders/${orderId}/bride-photo`).field('_csrf', csrf).attach('photo_file', img, 'second.jpg');
  const afterSecond = db.prepare('SELECT bride_photo_url FROM orders WHERE id = ?').get(orderId);
  assert.notEqual(afterSecond.bride_photo_url, afterFirst.bride_photo_url);
  assert.ok(!fs.existsSync(firstDiskPath), 'old file should have been deleted after replacement');

  const secondDiskPath = path.join(__dirname, '..', 'public', afterSecond.bride_photo_url.replace('/assets/', ''));
  assert.ok(fs.existsSync(secondDiskPath));
  fs.unlinkSync(secondDiskPath);
});

test('uploading a file with no CSRF token is rejected and leaves no orphaned file on disk', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'بلا', bride_name: 'رمز2', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();

  const img = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 1, g: 1, b: 1 } } }).jpeg().toBuffer();
  const before = fs.readdirSync(path.join(__dirname, '..', 'public', 'uploads', 'photos'));

  const res = await agent.post(`/admin/orders/${orderId}/bride-photo`).attach('photo_file', img, 'no-token.jpg');
  assert.equal(res.status, 403);

  const after = fs.readdirSync(path.join(__dirname, '..', 'public', 'uploads', 'photos'));
  assert.equal(after.length, before.length, 'the uploaded file must not be left behind on disk after a CSRF rejection');
  const order = db.prepare('SELECT bride_photo_url FROM orders WHERE id = ?').get(orderId);
  assert.equal(order.bride_photo_url, null);
});

test('deleting an order removes its uploaded files from disk', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'حذف', bride_name: 'كامل', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();

  const img = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 5, g: 5, b: 5 } } }).jpeg().toBuffer();
  await agent.post(`/admin/orders/${orderId}/bride-photo`).field('_csrf', csrf).attach('photo_file', img, 'bride.jpg');
  await agent.post(`/admin/orders/${orderId}/groom-photo`).field('_csrf', csrf).attach('photo_file', img, 'groom.jpg');

  const order = db.prepare('SELECT bride_photo_url, groom_photo_url FROM orders WHERE id = ?').get(orderId);
  const bridePath = path.join(__dirname, '..', 'public', order.bride_photo_url.replace('/assets/', ''));
  const groomPath = path.join(__dirname, '..', 'public', order.groom_photo_url.replace('/assets/', ''));
  assert.ok(fs.existsSync(bridePath));
  assert.ok(fs.existsSync(groomPath));

  await agent.post(`/admin/orders/${orderId}/delete`).type('form').send({ _csrf: csrf });

  assert.ok(!fs.existsSync(bridePath), 'bride photo should be deleted along with the order');
  assert.ok(!fs.existsSync(groomPath), 'groom photo should be deleted along with the order');
  assert.equal(db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId), undefined);
});

test('uploading more stickers adds to the existing set instead of replacing it', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'ملصق', bride_name: 'واحد', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();

  const img = await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();

  await agent.post(`/admin/orders/${orderId}/stickers`).field('_csrf', csrf).attach('sticker_files', img, 'a.png');
  const afterFirst = db.prepare('SELECT sticker_urls FROM orders WHERE id = ?').get(orderId);
  const firstUrls = JSON.parse(afterFirst.sticker_urls);
  assert.equal(firstUrls.length, 1);
  const firstPath = path.join(__dirname, '..', 'public', firstUrls[0].replace('/assets/', ''));
  assert.ok(fs.existsSync(firstPath));

  await agent.post(`/admin/orders/${orderId}/stickers`).field('_csrf', csrf).attach('sticker_files', img, 'b.png');
  const afterSecond = db.prepare('SELECT sticker_urls FROM orders WHERE id = ?').get(orderId);
  const secondUrls = JSON.parse(afterSecond.sticker_urls);
  assert.equal(secondUrls.length, 2, 'second upload should be added, not replace the first');
  assert.ok(fs.existsSync(firstPath), 'first sticker file should still exist after adding a second one');

  secondUrls.forEach((u) => fs.unlinkSync(path.join(__dirname, '..', 'public', u.replace('/assets/', ''))));
});

test('deleting a single sticker removes only that file, keeping the rest', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'حذف', bride_name: 'ملصق', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();

  const img = await sharp({ create: { width: 30, height: 30, channels: 3, background: { r: 4, g: 5, b: 6 } } }).png().toBuffer();
  await agent.post(`/admin/orders/${orderId}/stickers`).field('_csrf', csrf).attach('sticker_files', img, 'a.png').attach('sticker_files', img, 'b.png');

  const before = JSON.parse(db.prepare('SELECT sticker_urls FROM orders WHERE id = ?').get(orderId).sticker_urls);
  assert.equal(before.length, 2);
  const [urlA, urlB] = before;
  const pathA = path.join(__dirname, '..', 'public', urlA.replace('/assets/', ''));
  const pathB = path.join(__dirname, '..', 'public', urlB.replace('/assets/', ''));

  await agent.post(`/admin/orders/${orderId}/stickers/0/delete`).type('form').send({ _csrf: csrf });

  const after = JSON.parse(db.prepare('SELECT sticker_urls FROM orders WHERE id = ?').get(orderId).sticker_urls || '[]');
  assert.equal(after.length, 1);
  assert.equal(after[0], urlB);
  assert.ok(!fs.existsSync(pathA), 'deleted sticker file should be removed from disk');
  assert.ok(fs.existsSync(pathB), 'remaining sticker file should be untouched');

  fs.unlinkSync(pathB);
});

test('invitation page shows no background stickers for an order with none, even when a site-wide sticker gallery exists', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'بلا', bride_name: 'ملصقات', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();
  const order = db.prepare('SELECT slug FROM orders WHERE id = ?').get(orderId);

  db.prepare("INSERT INTO stickers (url) VALUES ('/assets/uploads/assets/global-gallery-sticker.png')").run();

  const page = await request(app).get(`/invite/${order.slug}`);
  assert.doesNotMatch(page.text, /global-gallery-sticker\.png/, 'an order with no stickers of its own must not show the site-wide gallery sticker');
});

test('deleting the order music removes the file and clears the field', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'موسيقى', bride_name: 'محذوفة', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();

  const audio = Buffer.from('ID3fake mp3 bytes for testing');
  await agent.post(`/admin/orders/${orderId}/music`).field('_csrf', csrf).attach('music_file', audio, { filename: 'song.mp3', contentType: 'audio/mpeg' });

  const withMusic = db.prepare('SELECT music_url FROM orders WHERE id = ?').get(orderId);
  assert.ok(withMusic.music_url, 'music_url should be set after upload');
  const musicPath = path.join(__dirname, '..', 'public', withMusic.music_url.replace('/assets/', ''));
  assert.ok(fs.existsSync(musicPath));

  await agent.post(`/admin/orders/${orderId}/music/delete`).type('form').send({ _csrf: csrf });

  const afterDelete = db.prepare('SELECT music_url FROM orders WHERE id = ?').get(orderId);
  assert.equal(afterDelete.music_url, null);
  assert.ok(!fs.existsSync(musicPath), 'music file should be removed from disk after delete');
});

test('saving a music URL through the text field replaces the old file and persists across requests', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'رابط', bride_name: 'موسيقى', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();

  const audio = Buffer.from('ID3fake mp3 bytes for testing');
  await agent.post(`/admin/orders/${orderId}/music`).field('_csrf', csrf).attach('music_file', audio, { filename: 'song.mp3', contentType: 'audio/mpeg' });
  const withFile = db.prepare('SELECT music_url FROM orders WHERE id = ?').get(orderId);
  const filePath = path.join(__dirname, '..', 'public', withFile.music_url.replace('/assets/', ''));
  assert.ok(fs.existsSync(filePath));

  await agent.post(`/admin/orders/${orderId}/music-url`).type('form').send({ music_url: 'https://example.com/song.mp3', _csrf: csrf });

  const afterUrl = db.prepare('SELECT music_url FROM orders WHERE id = ?').get(orderId);
  assert.equal(afterUrl.music_url, 'https://example.com/song.mp3');
  assert.ok(!fs.existsSync(filePath), 'old uploaded file should be removed once replaced by an external URL');

  const detailPage = await agent.get(`/admin/orders/${orderId}`);
  assert.match(detailPage.text, /https:\/\/example\.com\/song\.mp3/, 'the saved URL should be reflected back on reload');
});

test('invitation page shows the countdown/calendar block for featured and luxury plans, not basic', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);

  const featured = await agent.post('/admin/orders').type('form').send({ groom_name: 'م', bride_name: 'ف', plan: 'featured', event_date: '2027-01-01', event_time: '19:00', _csrf: csrf });
  const featuredOrder = db.prepare('SELECT slug FROM orders WHERE id = ?').get(featured.headers.location.split('/').pop());
  const featuredPage = await request(app).get(`/invite/${featuredOrder.slug}`);
  assert.match(featuredPage.text, /id="countdown"/);
  assert.match(featuredPage.text, new RegExp(`href="/invite/${featuredOrder.slug}/calendar.ics"`));

  const basic = await agent.post('/admin/orders').type('form').send({ groom_name: 'م', bride_name: 'ف', plan: 'basic', event_date: '2027-01-01', event_time: '19:00', _csrf: csrf });
  const basicOrder = db.prepare('SELECT slug FROM orders WHERE id = ?').get(basic.headers.location.split('/').pop());
  const basicPage = await request(app).get(`/invite/${basicOrder.slug}`);
  assert.doesNotMatch(basicPage.text, /id="countdown"/);
});

test('invitation page hides the countdown block when no event date is set', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'م', bride_name: 'ف', plan: 'luxury', _csrf: csrf });
  const order = db.prepare('SELECT slug FROM orders WHERE id = ?').get(create.headers.location.split('/').pop());
  const page = await request(app).get(`/invite/${order.slug}`);
  assert.doesNotMatch(page.text, /id="countdown"/);
});

test('GET /invite/:slug/calendar.ics returns a valid .ics file with the event details', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({
    groom_name: 'زياد', bride_name: 'رغد', plan: 'luxury',
    event_date: '2027-03-15', event_time: '20:00', venue: 'قاعة الأمل', _csrf: csrf,
  });
  const order = db.prepare('SELECT slug FROM orders WHERE id = ?').get(create.headers.location.split('/').pop());

  const res = await request(app).get(`/invite/${order.slug}/calendar.ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/calendar/);
  assert.match(res.text, /BEGIN:VCALENDAR/);
  assert.match(res.text, /DTSTART:20270315T200000/);
  assert.match(res.text, /LOCATION:قاعة الأمل/);
  assert.match(res.text, /SUMMARY:حفل زفاف زياد ورغد/);
});

test('GET /invite/:slug/calendar.ics 404s when no event date is set, and works for demo slugs', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'بلا', bride_name: 'تاريخ', _csrf: csrf });
  const order = db.prepare('SELECT slug FROM orders WHERE id = ?').get(create.headers.location.split('/').pop());

  const noDate = await request(app).get(`/invite/${order.slug}/calendar.ics`);
  assert.equal(noDate.status, 404);

  const demo = await request(app).get('/invite/demo-v1/calendar.ics');
  assert.equal(demo.status, 200);
  assert.match(demo.text, /BEGIN:VCALENDAR/);
});

test('admin can delete a single RSVP entry', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'حذف', bride_name: 'تأكيد', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();
  const order = db.prepare('SELECT slug FROM orders WHERE id = ?').get(orderId);

  await request(app)
    .post(`/invite/${order.slug}/rsvp`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form')
    .send({ name: 'ضيف للحذف', attending: 'yes', guest_count: '1' });
  const rsvp = db.prepare('SELECT * FROM rsvps WHERE order_id = ?').get(orderId);
  assert.ok(rsvp);

  const res = await agent.post(`/admin/orders/${orderId}/rsvps/${rsvp.id}/delete`).type('form').send({ _csrf: csrf });
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT * FROM rsvps WHERE id = ?').get(rsvp.id), undefined);
});

test('admin cannot delete an RSVP belonging to a different order', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const createA = await agent.post('/admin/orders').type('form').send({ groom_name: 'أ', bride_name: 'ب', _csrf: csrf });
  const orderAId = createA.headers.location.split('/').pop();
  const createB = await agent.post('/admin/orders').type('form').send({ groom_name: 'ج', bride_name: 'د', _csrf: csrf });
  const orderBId = createB.headers.location.split('/').pop();
  const orderB = db.prepare('SELECT slug FROM orders WHERE id = ?').get(orderBId);

  await request(app)
    .post(`/invite/${orderB.slug}/rsvp`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form')
    .send({ name: 'ضيف ب', attending: 'yes', guest_count: '1' });
  const rsvp = db.prepare('SELECT * FROM rsvps WHERE order_id = ?').get(orderBId);

  await agent.post(`/admin/orders/${orderAId}/rsvps/${rsvp.id}/delete`).type('form').send({ _csrf: csrf });
  assert.ok(db.prepare('SELECT * FROM rsvps WHERE id = ?').get(rsvp.id), 'an RSVP must not be deletable through a different order\'s URL');
});

test('duplicate RSVP names are flagged on the order detail page', async () => {
  const agent = request.agent(app);
  const csrf = await loginAsAdmin(agent);
  const create = await agent.post('/admin/orders').type('form').send({ groom_name: 'تكرار', bride_name: 'ضيوف', _csrf: csrf });
  const orderId = create.headers.location.split('/').pop();
  const order = db.prepare('SELECT slug FROM orders WHERE id = ?').get(orderId);

  for (let i = 0; i < 2; i++) {
    await request(app)
      .post(`/invite/${order.slug}/rsvp`)
      .set('X-Requested-With', 'XMLHttpRequest')
      .type('form')
      .send({ name: 'محمد كرار', attending: 'yes', guest_count: '1' });
  }
  await request(app)
    .post(`/invite/${order.slug}/rsvp`)
    .set('X-Requested-With', 'XMLHttpRequest')
    .type('form')
    .send({ name: 'ضيف وحيد', attending: 'yes', guest_count: '1' });

  const detailPage = await agent.get(`/admin/orders/${orderId}`);
  assert.match(detailPage.text, /rsvp-duplicate/, 'duplicate guest names should carry a visual flag');
});
