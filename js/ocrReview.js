const MAX_NOTE_CHARS = 1500;

function itemBounds(poly) {
  if (!Array.isArray(poly) || poly.length < 4 || poly.some(point => !Array.isArray(point) || point.length !== 2 || !point.every(Number.isFinite))) return null;
  const xs = poly.map(point => point[0]), ys = poly.map(point => point[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

export function normalizeOcrResult(result) {
  const items = (result?.items || []).map(item => ({
    text: String(item.text ?? '').replace(/\s+/g, ' ').trim(),
    score: Number.isFinite(item.score) ? Math.max(0, Math.min(1, item.score)) : 0,
    bounds: itemBounds(item.poly),
  })).filter(item => /[\p{L}\p{N}]/u.test(item.text) && item.bounds);
  if (!items.length) throw new Error('No readable text found. Rotate or crop to the writing, try better lighting, or type the notes.');
  items.sort((a, b) => a.bounds.y - b.bounds.y || a.bounds.x - b.bounds.x);
  const groups = [];
  for (const item of items) {
    const group = groups.find(candidate => {
      const overlap = Math.min(candidate.bounds.bottom, item.bounds.bottom) - Math.max(candidate.bounds.y, item.bounds.y);
      return overlap > Math.min(candidate.bounds.bottom - candidate.bounds.y, item.bounds.bottom - item.bounds.y) * 0.5;
    });
    if (group) {
      group.items.push(item);
      group.bounds = { x: Math.min(group.bounds.x, item.bounds.x), y: Math.min(group.bounds.y, item.bounds.y), right: Math.max(group.bounds.right, item.bounds.right), bottom: Math.max(group.bounds.bottom, item.bounds.bottom) };
    } else groups.push({ items: [item], bounds: { ...item.bounds } });
  }
  const lines = groups.sort((a, b) => a.bounds.y - b.bounds.y).map(group => {
    group.items.sort((a, b) => a.bounds.x - b.bounds.x);
    const text = group.items.map(item => item.text).join(' ');
    const score = Math.min(...group.items.map(item => item.score));
    return { text, score, bounds: group.bounds, lowConfidence: score < 0.9, requiresReview: true, criticalValues: text.match(/\b\d+(?:[.,]\d+)?(?:\/\d+)?\b/g) || [] };
  });
  return { text: lines.map(line => line.text).join('\n'), lines, model: result.model || 'PaddleOCR PP-OCRv6 small', metrics: result.metrics || null };
}

export function canUseOcrText(text, reviewed) {
  return Boolean(reviewed && typeof text === 'string' && text.trim() && text.length <= MAX_NOTE_CHARS && !/\[\s*(unclear|unreadable|illegible)\s*\]/i.test(text));
}
