const db = require('../db');

console.log('🔄 جاري إضافة الأعمدة الجديدة إلى جدول orders...');

// إضافة عمود music_url
try {
  db.prepare("ALTER TABLE orders ADD COLUMN music_url TEXT").run();
  console.log('✅ عمود music_url تمت إضافته بنجاح');
} catch (error) {
  if (error.message && error.message.includes('duplicate column name')) {
    console.log('ℹ️ عمود music_url موجود بالفعل (لا حاجة للإضافة)');
  } else {
    console.error('❌ خطأ أثناء إضافة music_url:', error.message);
  }
}

// إضافة عمود sticker_urls
try {
  db.prepare("ALTER TABLE orders ADD COLUMN sticker_urls TEXT").run();
  console.log('✅ عمود sticker_urls تمت إضافته بنجاح');
} catch (error) {
  if (error.message && error.message.includes('duplicate column name')) {
    console.log('ℹ️ عمود sticker_urls موجود بالفعل (لا حاجة للإضافة)');
  } else {
    console.error('❌ خطأ أثناء إضافة sticker_urls:', error.message);
  }
}

console.log('✨ انتهى!');