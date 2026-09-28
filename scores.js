// Kernelbound class leaderboard: a Vercel serverless function backed by Upstash Redis.
//
// GET  /api/scores?class=<name>                      -> { rows: [...] } top 300 by score
// POST /api/scores { class, code, row }              -> saves your row, returns { id, row }
// POST /api/scores { class, code, action: "hide" }   -> removes your row
//
// Every browser holds a secret 16-character player code. Rows are stored under a hash of it,
// so nobody can overwrite someone else's row without their code. The server keeps each
// player's best-ever numbers and recomputes the score itself, so a client can't post a score
// that doesn't match its stats.
//
// Storage: connect "Upstash for Redis" in the Vercel project's Storage tab. The integration
// adds KV_REST_API_URL and KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL / _TOKEN); both work.

const crypto = require('crypto');

const N_CHAPTERS = 13;      // keep in sync with CHAPTERS in index.html
const N_CARDS = 102;        // total flashcards in the campaign
const SPEED_WINDOW = 900;   // seconds; must match SPEED_WINDOW in index.html
const MAX_ROWS = 3000;      // per class board
const TOP = 300;            // rows returned by GET

function redisConfig() {
  const e = process.env;
  let url = e.KV_REST_API_URL || e.UPSTASH_REDIS_REST_URL;
  let token = e.KV_REST_API_TOKEN || e.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    // the Storage tab lets you pick a custom prefix, e.g. KERNEL_KV_REST_API_URL
    for (const k of Object.keys(e)) {
      const m = k.match(/^(.*?)(KV_REST_API|REDIS_REST)_URL$/);
      if (m && e[k] && e[m[1] + m[2] + '_TOKEN']) { url = e[k]; token = e[m[1] + m[2] + '_TOKEN']; break; }
    }
  }
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

async function redis(cfg, commands) {
  const r = await fetch(cfg.url + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('redis http ' + r.status);
  const out = await r.json();
  return out.map(x => { if (x.error) throw new Error(x.error); return x.result; });
}

const num = (x, max) => { x = Number(x); return Number.isFinite(x) ? Math.max(0, Math.min(max, Math.round(x))) : 0; };

function sanitize(r) {
  r = r && typeof r === 'object' ? r : {};
  const ch = {};
  if (r.ch && typeof r.ch === 'object') {
    for (const k of Object.keys(r.ch)) {
      const i = Number(k), v = r.ch[k];
      if (Number.isInteger(i) && i >= 1 && i <= N_CHAPTERS && v && typeof v === 'object') {
        const s = num(v.s, 3);
        if (s >= 1) ch[i] = { s, t: num(v.t, 86400) };
      }
    }
  }
  const synced = num(r.synced, N_CARDS);
  const mastered = Math.min(synced, num(r.mastered, N_CARDS));
  const answered = num(r.answered, 1e6);
  let acc = Number(r.acc);
  acc = Number.isFinite(acc) && answered ? Math.max(0, Math.min(1, acc)) : 0;
  const tag = String(r.tag || 'Operator').replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 14) || 'Operator';
  return { tag, ch, synced, mastered, acc: Math.round(acc * 1000) / 1000, answered };
}

// best-ever merge, so a second computer or a progress reset never lowers a student's row
function merge(old, next) {
  if (!old) return next;
  const ch = Object.assign({}, old.ch);
  for (const k of Object.keys(next.ch)) {
    const a = ch[k], b = next.ch[k];
    ch[k] = !a ? b : { s: Math.max(a.s, b.s), t: a.t && b.t ? Math.min(a.t, b.t) : (a.t || b.t) };
  }
  const accSide = next.answered >= old.answered ? next : old;
  return {
    tag: next.tag, ch,
    synced: Math.max(old.synced, next.synced),
    mastered: Math.max(old.mastered, next.mastered),
    acc: accSide.acc, answered: accSide.answered,
  };
}

// same formula as scoreSummary() in index.html
function scoreOf(r) {
  let bosses = 0, stars = 0, speed = 0;
  for (const k of Object.keys(r.ch)) {
    const c = r.ch[k];
    bosses++; stars += c.s;
    if (c.t > 0) speed += Math.max(0, Math.round(300 * (1 - c.t / SPEED_WINDOW)));
  }
  const accPts = Math.round(600 * r.acc * Math.min(1, r.answered / 100));
  return { bosses, stars, score: bosses * 400 + stars * 100 + speed + r.synced * 15 + r.mastered * 25 + accPts };
}

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', cache || 'no-store');
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  const cfg = redisConfig();
  if (!cfg) return send(res, 503, { error: 'not_configured' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body && typeof body === 'object' ? body : {};
  const query = req.query || {};
  const rawClass = req.method === 'GET' ? query.class : body.class;
  const cls = String(rawClass || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32).toLowerCase() || 'main';
  const ROWS = 'kb:' + cls + ':rows', RANK = 'kb:' + cls + ':rank';

  try {
    if (req.method === 'GET') {
      const [ids] = await redis(cfg, [['ZREVRANGE', RANK, '0', String(TOP - 1)]]);
      let rows = [];
      if (ids && ids.length) {
        const [vals] = await redis(cfg, [['HMGET', ROWS, ...ids]]);
        rows = ids.map((id, i) => { try { return vals[i] ? Object.assign(JSON.parse(vals[i]), { id }) : null; } catch (e) { return null; } }).filter(Boolean);
      }
      return send(res, 200, { class: cls, rows }, 'public, s-maxage=5, stale-while-revalidate=20');
    }

    if (req.method === 'POST') {
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!/^[A-Z2-9]{16}$/.test(code)) return send(res, 400, { error: 'bad_code' });
      const id = crypto.createHash('sha256').update('kernelbound:' + code).digest('hex').slice(0, 24);

      if (body.action === 'hide') {
        await redis(cfg, [['HDEL', ROWS, id], ['ZREM', RANK, id]]);
        return send(res, 200, { id, hidden: true });
      }

      // at most one score write per player every 3 seconds
      const [fresh] = await redis(cfg, [['SET', 'kb:rl:' + id, '1', 'EX', '3', 'NX']]);
      if (fresh === null) return send(res, 429, { error: 'slow_down' });

      const [current, count] = await redis(cfg, [['HGET', ROWS, id], ['HLEN', ROWS]]);
      if (!current && count >= MAX_ROWS) return send(res, 507, { error: 'board_full' });
      let old = null;
      try { old = current ? sanitize(JSON.parse(current)) : null; } catch (e) { old = null; }
      const row = merge(old, sanitize(body.row));
      const full = Object.assign(row, scoreOf(row), { at: Date.now(), v: 1 });
      await redis(cfg, [['HSET', ROWS, id, JSON.stringify(full)], ['ZADD', RANK, String(full.score), id]]);
      return send(res, 200, { id, row: Object.assign({ id }, full) });
    }

    res.setHeader('Allow', 'GET, POST');
    return send(res, 405, { error: 'method_not_allowed' });
  } catch (e) {
    return send(res, 502, { error: 'storage_error' });
  }
};
