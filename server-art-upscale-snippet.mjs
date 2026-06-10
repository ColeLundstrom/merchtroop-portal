// Drop-in helper for server.mjs. Keep this server-side only.
// Wire it by importing this file, then adding this inside the main route chain:
// if (req.method === 'POST' && p === '/api/art/upscale') return handleArtUpscaleRequest({ req, res, collectBody, sendJson, bad, sleep });

export function getFalArtModel() {
  return process.env.FAL_ART_MODEL || 'clarityai/' + 'crystal-upscaler';
}

export function getFalAuthHeader() {
  const key = String(process.env.FAL_KEY || '').trim();
  return key ? (/^key\s/i.test(key) ? key : `Key ${key}`) : null;
}

function normalizeFalImage(image) {
  if (!image) return null;
  if (typeof image === 'string') return { url: image };
  if (image.url) return {
    url: image.url,
    width: image.width || null,
    height: image.height || null,
    contentType: image.content_type || image.contentType || null,
    fileName: image.file_name || image.fileName || null,
    fileSize: image.file_size || image.fileSize || null,
  };
  return null;
}

async function falJson(apiPath, options = {}, timeoutMs = 30000) {
  const auth = getFalAuthHeader();
  if (!auth) {
    const err = new Error('FAL_KEY is not configured on the portal server');
    err.statusCode = 500;
    throw err;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const response = await fetch(`https://queue.fal.run${apiPath}`, {
      ...options,
      signal: ac.signal,
      headers: {
        Authorization: auth,
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text || '{}'); } catch { json = { raw: text }; }
    if (!response.ok) {
      const err = new Error(`Fal HTTP ${response.status}`);
      err.statusCode = response.status;
      err.details = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function runFalArtUpscale(input, sleep) {
  const model = getFalArtModel();
  const submitted = await falJson(`/${model}`, {
    method: 'POST',
    body: JSON.stringify(input),
  }, 45000);

  if (Array.isArray(submitted.images)) return submitted;
  const requestId = submitted.request_id || submitted.requestId;
  if (!requestId) {
    const err = new Error('Fal did not return a request id');
    err.details = submitted;
    throw err;
  }

  for (let i = 0; i < 60; i++) {
    await sleep(1500);
    const status = await falJson(`/${model}/requests/${encodeURIComponent(requestId)}/status?logs=0`, {}, 15000);
    const s = String(status.status || '').toUpperCase();
    if (s === 'COMPLETED') {
      const result = await falJson(`/${model}/requests/${encodeURIComponent(requestId)}`, {}, 30000);
      return { ...result, request_id: requestId };
    }
    if (['FAILED', 'CANCELLED'].includes(s)) {
      const err = new Error(`Fal request ${s.toLowerCase()}`);
      err.details = status;
      throw err;
    }
  }

  const err = new Error('Fal request timed out');
  err.statusCode = 504;
  throw err;
}

export async function handleArtUpscaleRequest({ req, res, collectBody, sendJson, bad, sleep }) {
  let body;
  try { body = await collectBody(req, 20_000_000); }
  catch (e) { return bad(res, 413, e.message); }

  let payload;
  try { payload = JSON.parse(body || '{}'); } catch { return bad(res, 400, 'Invalid JSON'); }

  const imageSource = String(payload.imageDataUri || payload.imageUrl || '').trim();
  if (!imageSource) return bad(res, 400, 'Missing imageUrl or imageDataUri');
  if (!/^https?:\/\//i.test(imageSource) && !/^data:image\//i.test(imageSource)) {
    return bad(res, 400, 'Image source must be an http(s) URL or image data URI');
  }

  const scaleFactor = Math.min(20, Math.max(1, Number(payload.scaleFactor || 2)));
  const creativity = Math.min(10, Math.max(0, Number(payload.creativity || 0)));
  const outputFormat = String(payload.outputFormat || 'png').toLowerCase() === 'jpg' ? 'jpg' : 'png';

  try {
    const result = await runFalArtUpscale({
      image_url: imageSource,
      scale_factor: scaleFactor,
      creativity,
      output_format: outputFormat,
    }, sleep);

    const images = (Array.isArray(result.images) ? result.images : [])
      .map(normalizeFalImage)
      .filter(Boolean);

    return sendJson(res, {
      ok: true,
      model: 'fal-art-upscaler',
      requestId: result.request_id || result.requestId || null,
      images,
      input: { scaleFactor, creativity, outputFormat },
      capturedAt: new Date().toISOString(),
    });
  } catch (e) {
    return bad(res, e.statusCode || 502, 'Fal art upscale failed', e.details || { message: e.message });
  }
}
