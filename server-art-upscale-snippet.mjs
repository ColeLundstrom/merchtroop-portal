// Drop-in helper for server.mjs. Keep this server-side only.

export function getFalArtModel() {
  return process.env.FAL_ART_MODEL || 'clarityai/' + 'crystal-upscaler';
}

export function getFalAuthHeader() {
  const key = String(process.env.FAL_KEY || '').trim();
  return key ? (/^key\s/i.test(key) ? key : `Key ${key}`) : null;
}
