// ===========================================================================
// English-Kids Worker
// API endpoints + R2 video streaming
// ===========================================================================

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Auth, Range',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
  'Access-Control-Max-Age': '86400'
};

const STATE_KEY = 'state';
const VIDEO_PREFIX = 'videos/';

// ---------- helpers ----------
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS, ...extra }
  });

const err = (msg, status = 400) => json({ error: msg }, status);

const getToken = (req) => {
  const url = new URL(req.url);
  return req.headers.get('X-Auth') || url.searchParams.get('t') || '';
};

const checkAuth = (req, env) => {
  const t = getToken(req);
  return t && env.AUTH_TOKEN && t === env.AUTH_TOKEN;
};

const getState = async (env) => {
  const raw = await env.KV.get(STATE_KEY);
  if (raw) return JSON.parse(raw);
  return {
    profiles: [],
    vocab: [],
    movies: [],
    settings: { autoIntervalSec: 240 }
  };
};

const putState = async (env, state) => {
  await env.KV.put(STATE_KEY, JSON.stringify(state));
};

const uid = (prefix = 'mov') =>
  prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

const safeFileName = (name) =>
  (name || 'file').replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 80);

// Convert HTTP Range header → R2 range option
function parseRange(header) {
  if (!header) return undefined;
  const m = header.match(/bytes=(\d*)-(\d*)/);
  if (!m) return undefined;
  const start = m[1];
  const end = m[2];
  if (start === '' && end !== '') return { suffix: parseInt(end) };
  if (start !== '' && end === '') return { offset: parseInt(start) };
  if (start !== '' && end !== '')
    return { offset: parseInt(start), length: parseInt(end) - parseInt(start) + 1 };
  return undefined;
}

// ---------- main router ----------
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: CORS });

    const url = new URL(request.url);
    const path = url.pathname;

    // Health check (no auth)
    if (path === '/api/health') return json({ ok: true, version: 1 });

    // Public ping for setup test (no auth)
    if (path === '/api/ping')
      return json({ ok: true, hasToken: !!env.AUTH_TOKEN });

    // Everything else requires auth
    if (!checkAuth(request, env)) return err('Unauthorized', 401);

    try {
      // ====== state sync ======
      if (path === '/api/state' && request.method === 'GET')
        return json(await getState(env));

      if (path === '/api/state' && request.method === 'POST') {
        const body = await request.json();
        // Light validation
        if (typeof body !== 'object' || !body) return err('Invalid body');
        // Preserve movies r2 fields (so client can't accidentally drop them)
        const existing = await getState(env);
        const existingByMovie = Object.fromEntries(
          (existing.movies || []).map((m) => [m.id, m])
        );
        body.movies = (body.movies || []).map((m) => {
          const ex = existingByMovie[m.id] || {};
          return { ...ex, ...m, r2Key: ex.r2Key || m.r2Key, uploaded: ex.uploaded ?? m.uploaded };
        });
        await putState(env, body);
        return json({ ok: true });
      }

      // ====== Multipart upload ======
      if (path === '/api/upload/init' && request.method === 'POST') {
        const body = await request.json();
        const {
          fileName = 'video.mp4',
          fileSize = 0,
          mimeType = 'video/mp4',
          name = '',
          autoIntervalSec = 240,
          duration = 0
        } = body;
        const movieId = uid();
        const r2Key = VIDEO_PREFIX + movieId + '_' + safeFileName(fileName);
        const upload = await env.VIDEOS.createMultipartUpload(r2Key, {
          httpMetadata: { contentType: mimeType }
        });
        const state = await getState(env);
        state.movies = state.movies || [];
        state.movies.push({
          id: movieId,
          name: name || fileName,
          fileName,
          fileSize,
          mimeType,
          duration,
          autoIntervalSec,
          customQuestions: [],
          r2Key,
          uploaded: false,
          uploadId: upload.uploadId,
          createdAt: Date.now()
        });
        await putState(env, state);
        return json({
          movieId,
          uploadId: upload.uploadId,
          r2Key,
          partSize: 20 * 1024 * 1024
        });
      }

      if (path === '/api/upload/part' && request.method === 'PUT') {
        const movieId = url.searchParams.get('movieId');
        const partNumber = parseInt(url.searchParams.get('partNumber') || '0');
        const uploadId = url.searchParams.get('uploadId');
        if (!movieId || !partNumber || !uploadId)
          return err('Missing movieId/partNumber/uploadId');
        const state = await getState(env);
        const movie = (state.movies || []).find((m) => m.id === movieId);
        if (!movie) return err('Movie not found', 404);
        const upload = env.VIDEOS.resumeMultipartUpload(movie.r2Key, uploadId);
        const part = await upload.uploadPart(partNumber, request.body);
        return json({ partNumber: part.partNumber, etag: part.etag });
      }

      if (path === '/api/upload/complete' && request.method === 'POST') {
        const body = await request.json();
        const { movieId, uploadId, parts } = body;
        const state = await getState(env);
        const movie = (state.movies || []).find((m) => m.id === movieId);
        if (!movie) return err('Movie not found', 404);
        const upload = env.VIDEOS.resumeMultipartUpload(movie.r2Key, uploadId);
        await upload.complete(parts);
        movie.uploaded = true;
        delete movie.uploadId;
        await putState(env, state);
        return json({ ok: true, movieId });
      }

      if (path === '/api/upload/abort' && request.method === 'POST') {
        const body = await request.json();
        const { movieId, uploadId } = body;
        const state = await getState(env);
        const movie = (state.movies || []).find((m) => m.id === movieId);
        if (movie) {
          try {
            const upload = env.VIDEOS.resumeMultipartUpload(
              movie.r2Key,
              uploadId || movie.uploadId
            );
            await upload.abort();
          } catch (_) {}
          state.movies = state.movies.filter((m) => m.id !== movieId);
          await putState(env, state);
        }
        return json({ ok: true });
      }

      // ====== Direct PUT (small files) ======
      if (path === '/api/upload/direct' && request.method === 'PUT') {
        const fileName = url.searchParams.get('fileName') || 'video.mp4';
        const name = url.searchParams.get('name') || fileName;
        const autoIntervalSec = parseInt(url.searchParams.get('autoIntervalSec') || '240');
        const duration = parseFloat(url.searchParams.get('duration') || '0');
        const fileSize = parseInt(request.headers.get('Content-Length') || '0');
        const mimeType = request.headers.get('Content-Type') || 'video/mp4';

        const movieId = uid();
        const r2Key = VIDEO_PREFIX + movieId + '_' + safeFileName(fileName);
        await env.VIDEOS.put(r2Key, request.body, {
          httpMetadata: { contentType: mimeType }
        });

        const state = await getState(env);
        state.movies = state.movies || [];
        state.movies.push({
          id: movieId,
          name,
          fileName,
          fileSize,
          mimeType,
          duration,
          autoIntervalSec,
          customQuestions: [],
          r2Key,
          uploaded: true,
          createdAt: Date.now()
        });
        await putState(env, state);
        return json({ movieId });
      }

      // ====== Manual register (already in R2) ======
      if (path === '/api/movies/list-r2' && request.method === 'GET') {
        const list = await env.VIDEOS.list({ prefix: VIDEO_PREFIX, include: ['httpMetadata'] });
        const state = await getState(env);
        const registered = new Set((state.movies || []).map((m) => m.r2Key));
        const objects = (list.objects || []).map((o) => ({
          key: o.key,
          name: o.key.replace(VIDEO_PREFIX, ''),
          size: o.size,
          uploaded: o.uploaded,
          mimeType: o.httpMetadata?.contentType || 'video/mp4',
          isRegistered: registered.has(o.key)
        }));
        return json({ objects });
      }

      if (path === '/api/movies/register' && request.method === 'POST') {
        const body = await request.json();
        const { r2Key, name, autoIntervalSec = 240, duration = 0 } = body;
        if (!r2Key || !name) return err('Missing r2Key or name');
        const obj = await env.VIDEOS.head(r2Key);
        if (!obj) return err('R2 object not found', 404);
        const state = await getState(env);
        // Skip if already registered
        if ((state.movies || []).some((m) => m.r2Key === r2Key))
          return err('Already registered', 409);
        const movieId = uid();
        state.movies = state.movies || [];
        state.movies.push({
          id: movieId,
          name,
          fileName: r2Key.replace(VIDEO_PREFIX, ''),
          fileSize: obj.size,
          mimeType: obj.httpMetadata?.contentType || 'video/mp4',
          duration,
          autoIntervalSec,
          customQuestions: [],
          r2Key,
          uploaded: true,
          createdAt: Date.now()
        });
        await putState(env, state);
        return json({ movieId });
      }

      // ====== Delete movie ======
      if (path.startsWith('/api/movies/') && request.method === 'DELETE') {
        const movieId = path.split('/').pop();
        const state = await getState(env);
        const movie = (state.movies || []).find((m) => m.id === movieId);
        if (!movie) return err('Not found', 404);
        try {
          if (movie.uploadId) {
            const upload = env.VIDEOS.resumeMultipartUpload(movie.r2Key, movie.uploadId);
            await upload.abort().catch(() => {});
          }
          await env.VIDEOS.delete(movie.r2Key);
        } catch (e) {
          console.error('delete failed', e);
        }
        state.movies = state.movies.filter((m) => m.id !== movieId);
        await putState(env, state);
        return json({ ok: true });
      }

      // ====== Stream video from R2 (with Range support) ======
      if (path.startsWith('/api/video/')) {
        const movieId = path.replace('/api/video/', '');
        const state = await getState(env);
        const movie = (state.movies || []).find((m) => m.id === movieId);
        if (!movie) return err('Movie not found', 404);
        if (!movie.uploaded) return err('Upload not complete', 425);

        const rangeHeader = request.headers.get('Range');
        const range = parseRange(rangeHeader);

        const obj = range
          ? await env.VIDEOS.get(movie.r2Key, { range })
          : await env.VIDEOS.get(movie.r2Key);

        if (!obj) return err('R2 object not found', 404);

        const headers = new Headers(CORS);
        headers.set('Content-Type', movie.mimeType || obj.httpMetadata?.contentType || 'video/mp4');
        headers.set('Accept-Ranges', 'bytes');
        headers.set('Cache-Control', 'private, max-age=3600');

        if (range && obj.range) {
          const start = obj.range.offset || 0;
          const length = obj.range.length;
          headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${obj.size}`);
          headers.set('Content-Length', String(length));
          return new Response(obj.body, { status: 206, headers });
        }
        headers.set('Content-Length', String(obj.size));
        return new Response(obj.body, { status: 200, headers });
      }

      // ====== Translate subtitles batch via Anthropic Claude API ======
      // POST { sentences: ["text1", "text2", ...] }
      // Returns: { translations: [{he: "...", words: {"love":"אוהב", ...}}, ...] }
      if (path === '/api/translate-batch' && request.method === 'POST') {
        if (!env.ANTHROPIC_API_KEY) return err('ANTHROPIC_API_KEY not configured', 500);
        const body = await request.json();
        const sentences = body.sentences || [];
        if (!Array.isArray(sentences) || sentences.length === 0)
          return err('sentences[] required');
        if (sentences.length > 50) return err('Max 50 sentences per batch');

        // Prepare numbered list for the model
        const numbered = sentences.map((s, i) => `${i + 1}. ${s}`).join('\n');

        const prompt = `You are translating English movie subtitles for a children's English-learning app. Hebrew-speaking kids ages 6-12 will use this to learn English.

For EACH numbered subtitle below, provide:
1. "he": A natural, simple Hebrew translation. CRITICAL RULES:
   - Use Hebrew gender that matches the speaker if obvious from context (use the surrounding subtitles as context)
   - If the speaker's gender is unknown, prefer feminine forms when speaking to/about a female child, masculine otherwise
   - Avoid overly literal translations - prefer natural spoken Hebrew
   - Keep it short and clear
2. "words": A dictionary of meaningful English words → Hebrew. RULES:
   - Include nouns, verbs, adjectives, adverbs (skip "the", "a", "an", "of")
   - Translate each word in the CONTEXT of this sentence (e.g., "spoken for" = "מאורסת" not "מדבר")
   - Use simple Hebrew kids understand
   - Match gender to the sentence

Return STRICTLY valid JSON in this exact format, no markdown, no extra text:
{"results":[{"i":1,"he":"...","words":{"english":"עברית", ...}}, {"i":2,"he":"...","words":{...}}, ...]}

Subtitles to translate:
${numbered}`;

        try {
          const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'claude-haiku-4-5',
              max_tokens: 8000,
              messages: [{ role: 'user', content: prompt }]
            })
          });
          if (!claudeResp.ok) {
            const t = await claudeResp.text();
            return err('Claude API: ' + t.slice(0, 300), claudeResp.status);
          }
          const data = await claudeResp.json();
          const text = data.content?.[0]?.text || '';
          // Try to extract JSON
          let parsed;
          try {
            // strip optional markdown fences
            const cleaned = text.replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
            parsed = JSON.parse(cleaned);
          } catch (e) {
            // try to find first { ... last }
            const m = text.match(/\{[\s\S]*\}/);
            if (m) parsed = JSON.parse(m[0]);
            else return err('Failed to parse Claude response', 500);
          }
          // Map results back to original order
          const translations = sentences.map((_, i) => {
            const r = (parsed.results || []).find((x) => x.i === i + 1);
            return r ? { he: r.he, words: r.words || {} } : { he: null, words: {} };
          });
          return json({ translations });
        } catch (e) {
          return err('Translation failed: ' + (e.message || e), 500);
        }
      }

      return err('Not found', 404);
    } catch (e) {
      console.error('worker err:', e);
      return err((e && e.message) || String(e), 500);
    }
  }
};
