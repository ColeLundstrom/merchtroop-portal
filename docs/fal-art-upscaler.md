# Fal Art Upscaler

Adds an Art Tools page at `/art.html`.

## Frontend

`art.html` is a portal-native upload/URL tool for the art section. It posts to:

```txt
POST /api/art/upscale
```

Payload:

```json
{
  "imageUrl": "https://...",
  "imageDataUri": "data:image/png;base64,...",
  "scaleFactor": 2,
  "creativity": 0,
  "outputFormat": "png"
}
```

Response expected by the page:

```json
{
  "ok": true,
  "requestId": "...",
  "images": [{ "url": "https://..." }]
}
```

## Backend wiring needed

Keep the Fal key server-side only. Add the route inside `server.mjs` near the other API routes and call Fal from Node, not the browser.

Server env needed:

```bash
FAL_KEY=...
```

Recommended model constant:

```js
const FAL_ART_MODEL = process.env.FAL_ART_MODEL || 'clarityai/' + 'crystal-upscaler';
```

The existing `collectBody` limit is `1_000_000`, so uploaded base64 images need either a bigger limit for this route or the upload should be stored first and sent as a URL. For this portal page, easiest first pass is:

```js
const body = await collectBody(req, 20_000_000);
```

The browser must never receive `FAL_KEY`.
