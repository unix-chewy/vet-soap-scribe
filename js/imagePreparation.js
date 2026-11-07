/** All image adjustments are ordinary pixel operations. The original file is
 * retained; no generative image model is used for rotation or preprocessing. */
export function imageGeometry(sourceWidth, sourceHeight, { rotation = 0, margins = {} } = {}) {
  if (![sourceWidth, sourceHeight].every(value => Number.isInteger(value) && value > 0)) throw new Error('Invalid image dimensions.');
  if (sourceWidth * sourceHeight > 40000000) throw new Error('Image dimensions are too large. Crop the photo in your camera app first.');
  if (!Number.isFinite(rotation) || rotation % 90 !== 0) throw new Error('Rotate in 90 degree steps.');
  const turn = ((rotation % 360) + 360) % 360;
  const width = turn % 180 ? sourceHeight : sourceWidth;
  const height = turn % 180 ? sourceWidth : sourceHeight;
  const { left = 0, right = 0, top = 0, bottom = 0 } = margins;
  if (![left, right, top, bottom].every(value => Number.isFinite(value) && value >= 0 && value <= 90) || left + right >= 95 || top + bottom >= 95) throw new Error('Crop margins must leave at least 5% of the photo.');
  const x = Math.round(width * left / 100), y = Math.round(height * top / 100);
  const crop = { x, y, width: width - x - Math.round(width * right / 100), height: height - y - Math.round(height * bottom / 100) };
  const scale = Math.min(1, 2400 / Math.max(crop.width, crop.height));
  return { rotation: turn, width, height, crop, outputWidth: Math.max(1, Math.round(crop.width * scale)), outputHeight: Math.max(1, Math.round(crop.height * scale)) };
}

export function analyzePixels(pixels) {
  let total = 0, low = 255, high = 0;
  const step = Math.max(4, Math.floor(pixels.length / 40000 / 4) * 4);
  let count = 0;
  for (let i = 0; i < pixels.length; i += step) {
    const value = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    total += value; low = Math.min(low, value); high = Math.max(high, value); count++;
  }
  const brightness = count ? total / count : 0;
  const warnings = [];
  if (brightness < 75) warnings.push('The photo looks dark. Try more even light or enable contrast enhancement.');
  if (brightness > 240) warnings.push('The photo looks very bright. Check for glare or washed-out writing.');
  if (high - low < 50) warnings.push('The photo has little contrast. Check that the writing is sharp and visible.');
  return { brightness, warnings };
}

export async function renderPhoto(file, options = {}) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const geometry = imageGeometry(bitmap.width, bitmap.height, options);
    const canvas = document.createElement('canvas');
    canvas.width = geometry.outputWidth; canvas.height = geometry.outputHeight;
    const output = canvas.getContext('2d');
    if (!output) throw new Error('Your browser could not prepare this photo.');
    output.fillStyle = '#fff'; output.fillRect(0, 0, canvas.width, canvas.height);
    const crop = geometry.crop;
    // Compose crop, scale, and quarter-turn transforms in one canvas, avoiding
    // a second full-resolution allocation on memory-constrained phones.
    output.save();
    output.scale(canvas.width / crop.width, canvas.height / crop.height);
    output.translate(-crop.x, -crop.y);
    output.translate(geometry.width / 2, geometry.height / 2);
    output.rotate(geometry.rotation * Math.PI / 180);
    output.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
    output.restore();
    const pixels = output.getImageData(0, 0, canvas.width, canvas.height);
    const quality = analyzePixels(pixels.data);
    if (options.enhance) {
      // Fixed, reversible-by-reset contrast adjustment. No generated pixels or
      // word substitutions; the unmodified original remains available.
      for (let i = 0; i < pixels.data.length; i += 4) {
        for (let channel = 0; channel < 3; channel++) pixels.data[i + channel] = Math.max(0, Math.min(255, (pixels.data[i + channel] - 90) * 1.45 + 125));
      }
      output.putImageData(pixels, 0, 0);
    }
    return { canvas, quality, geometry };
  } finally {
    bitmap.close();
  }
}

export function canvasBlob(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not prepare the photo.')), 'image/png'));
}

export function sourceLineImage(canvas, bounds) {
  const x = Math.max(0, Math.floor(bounds.x - 8)), y = Math.max(0, Math.floor(bounds.y - 8));
  const width = Math.min(canvas.width - x, Math.ceil(bounds.right - x + 8));
  const height = Math.min(canvas.height - y, Math.ceil(bounds.bottom - y + 8));
  if (width <= 0 || height <= 0) return '';
  const crop = document.createElement('canvas');
  crop.width = width; crop.height = height;
  crop.getContext('2d').drawImage(canvas, x, y, width, height, 0, 0, width, height);
  return crop.toDataURL('image/png');
}
