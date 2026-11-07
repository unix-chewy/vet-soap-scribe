// Pinned official worker bundle: it uses the SDK's supported OffscreenCanvas
// adapter rather than the DOM-only image adapter used on the main thread.
import 'https://cdn.jsdelivr.net/npm/@paddleocr/paddleocr-js@0.4.2/dist/assets/worker-entry-C9UNuyOJ.js';

const networkFetch = self.fetch.bind(self);
self.fetch = async (resource, options) => {
  const url = typeof resource === 'string' ? resource : resource.url;
  let cache;
  if (/\.tar(?:\?|$)/i.test(url) && self.caches) {
    try {
      cache = await caches.open('vet-soap-ocr-models-v1');
      const cached = await cache.match(resource);
      if (cached) return cached;
    } catch { /* Model caching is optional when storage is full or unavailable. */ }
  }
  const response = await networkFetch(resource, options);
  if (cache && response.ok) {
    try { await cache.put(resource, response.clone()); } catch { /* Quota is not fatal. */ }
  }
  return response;
};
