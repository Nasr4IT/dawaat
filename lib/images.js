const fs = require('fs');
const sharp = require('sharp');

// Downscales an uploaded image in place (same path, same extension) so an
// oversized phone photo doesn't get served at full resolution on every
// invitation page view. Leaves the file untouched if it's already small
// enough, an SVG (vector — nothing to resize), or something sharp can't
// read — never lose the upload over a compression failure.
async function resizeImageInPlace(filePath, maxDimension, quality = 82) {
  const ext = filePath.split('.').pop().toLowerCase();
  if (ext === 'svg') return;

  const tmpPath = `${filePath}.tmp`;
  try {
    const image = sharp(filePath).rotate(); // auto-orient from EXIF before measuring
    const meta = await image.metadata();
    if (meta.width && meta.height && meta.width <= maxDimension && meta.height <= maxDimension) {
      return;
    }

    let pipeline = image.resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true,
    });
    if (ext === 'jpg' || ext === 'jpeg') pipeline = pipeline.jpeg({ quality });
    else if (ext === 'png') pipeline = pipeline.png({ quality, compressionLevel: 9 });
    else if (ext === 'webp') pipeline = pipeline.webp({ quality });

    await pipeline.toFile(tmpPath);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (e) { /* nothing to clean up */ }
    console.warn(`تعذر ضغط الصورة (${filePath})، سيتم استخدامها كما هي:`, err.message);
  }
}

module.exports = { resizeImageInPlace };
