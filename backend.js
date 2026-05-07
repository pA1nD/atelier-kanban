/* Kanban backend — file-backed store with a markdown-first HTTP API.
 *
 * Agents (and the dashboard) read + write cards via four endpoints. Every
 * request body and every response body is the same multi-doc markdown
 * format: YAML-ish frontmatter + markdown body, cards separated by bare
 * `---` lines. The dashboard opts into JSON via `Accept: application/json`.
 *
 * Routes:
 *   GET    /api/kanban/spaces                         list spaces
 *   POST   /api/kanban/spaces                         create/update space(s)
 *   GET    /api/kanban/spaces/:name/cards             cards in a space
 *   POST   /api/kanban/spaces/:name/cards             create/update card(s) in a space
 *
 * Persistence: state is mirrored to `kanban/data/board.md` (next to this
 * file). Loaded on boot if present; rewritten atomically after every
 * mutating POST. The file uses the same multi-doc markdown format, with a
 * `kind: space | card` discriminator on each block so we can round-trip.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = path.join(MODULE_DIR, 'data');
const BOARD_PATH = path.join(DATA_DIR, 'board.md');

/* ========================================================================
 * State
 * ====================================================================== */

const COLS = ['todo', 'doing', 'needs', 'done', 'archive'];
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

// Frontmatter keys the API accepts. Anything else is rejected with a
// message pointing at these lists — so agents get fast feedback when they
// invent a field ("priority", "due", …) that would otherwise be silently
// dropped. `created_at`/`updated_at`/`cards` are tolerated on input but
// server-owned (ignored) — makes round-tripping GET → edit → POST clean.
const CARD_KEYS  = new Set(['id', 'col', 'title', 'agent', 'tags', 'progress', 'question', 'created_at', 'updated_at']);
const SPACE_KEYS = new Set(['name', 'created_at', 'cards']);

function validateKeys(doc, allowed, kind) {
  const unknown = Object.keys(doc.frontmatter).filter((k) => !allowed.has(k));
  if (unknown.length === 0) return;
  const err = new Error(
    `${kind} has unknown field(s): ${unknown.join(', ')}. ` +
    `valid: ${[...allowed].join(', ')}`
  );
  err.code = 400;
  throw err;
}

const spaces  = new Map();   // name → { description, created_at }
const cards   = new Map();   // id   → { space, col, title, agent?, tags[], progress?, question?, notes, created_at, updated_at }
const bySpace = new Map();   // name → Set<id>
let   nextId  = 220;

/* ========================================================================
 * Persistence — load on boot, atomic write on every mutation
 * ====================================================================== */

function loadFromDisk() {
  if (!fs.existsSync(BOARD_PATH)) return;
  const src = fs.readFileSync(BOARD_PATH, 'utf8');
  const docs = parseDocs(src);
  for (const d of docs) {
    const fm = d.frontmatter;
    if (fm.kind === 'space') {
      if (typeof fm.name !== 'string') continue;
      spaces.set(fm.name, {
        description: d.body,
        created_at:  fm.created_at || new Date().toISOString(),
      });
      if (!bySpace.has(fm.name)) bySpace.set(fm.name, new Set());
    } else if (fm.kind === 'card') {
      if (typeof fm.id !== 'string' || typeof fm.space !== 'string') continue;
      if (!spaces.has(fm.space)) continue;      // skip orphaned cards
      const now = new Date().toISOString();
      cards.set(fm.id, {
        id:         fm.id,
        space:      fm.space,
        col:        fm.col,
        title:      fm.title || '(untitled)',
        agent:      fm.agent ?? null,
        tags:       Array.isArray(fm.tags) ? fm.tags : [],
        progress:   typeof fm.progress === 'number' ? fm.progress : null,
        question:   fm.question ?? null,
        notes:      d.body,
        created_at: fm.created_at || now,
        updated_at: fm.updated_at || now,
      });
      bySpace.get(fm.space).add(fm.id);
      const m = /^atl-(\d+)$/.exec(fm.id);
      if (m && Number(m[1]) >= nextId) nextId = Number(m[1]) + 1;
    }
  }
}

function persistToDisk() {
  const docs = [];
  for (const [name, s] of spaces) docs.push(renderSpaceForDisk(name, s));
  for (const [, c]   of cards)   docs.push(renderCardForDisk(c));
  const body = docs.join('\n\n') + (docs.length ? '\n' : '');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // Unique tmp per call: concurrent persistToDisk() calls would race on
    // a shared `.tmp` path; second rename throws ENOENT and the write is lost.
    const tmp = BOARD_PATH + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, BOARD_PATH);
  } catch (err) {
    console.error('[kanban] persist failed:', err.message);
  }
}

function renderSpaceForDisk(name, space) {
  const lines = [
    `kind: space`,
    `name: ${name}`,
    `created_at: ${space.created_at}`,
  ];
  return `---\n${lines.join('\n')}\n---\n${space.description || ''}`;
}

function renderCardForDisk(card) {
  const lines = [
    `kind: card`,
    `id: ${card.id}`,
    `space: ${card.space}`,
    `col: ${card.col}`,
    `title: ${serializeScalar(card.title)}`,
  ];
  if (card.agent)           lines.push(`agent: ${serializeScalar(card.agent)}`);
  if (card.tags?.length)    lines.push(`tags: ${serializeScalar(card.tags)}`);
  if (card.progress != null) lines.push(`progress: ${card.progress}`);
  if (card.question)        lines.push(`question: ${serializeScalar(card.question)}`);
  lines.push(`created_at: ${card.created_at}`);
  lines.push(`updated_at: ${card.updated_at}`);
  return `---\n${lines.join('\n')}\n---\n${card.notes || ''}`;
}

// Load whatever's on disk at module-load time. Empty boot if no file yet.
loadFromDisk();

/* ========================================================================
 * YAML-subset parser
 *
 * Handles the fields the kanban uses and nothing more:
 *   key: string          (unquoted, 'single' or "double" quoted)
 *   key: 42              (integers and decimals)
 *   key: true|false|null
 *   key: [a, b, "c d"]   (flow sequence of strings)
 *
 * Cut semantics: the first `:` in a line separates key from value; any
 * subsequent colons are part of the value (so `title: metrics: add p99`
 * yields title = "metrics: add p99" — no need to quote).
 * Leading `#` is a comment line. Blank lines are skipped.
 * ====================================================================== */

function parseFrontmatter(src) {
  const out = {};
  for (const raw of src.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.replace(/^\s+/, '');
    if (!trimmed || trimmed.startsWith('#')) continue;
    const ci = trimmed.indexOf(':');
    if (ci < 0) continue;
    const key = trimmed.slice(0, ci).trim();
    let val = trimmed.slice(ci + 1).trim();
    if (!key) continue;
    out[key] = coerceScalar(val);
  }
  return out;
}

function coerceScalar(val) {
  if (val === '' || val === 'null' || val === '~') return null;
  if (val === 'true')  return true;
  if (val === 'false') return false;
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => {
      s = s.trim();
      if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) s = s.slice(1, -1);
      return s;
    }).filter((s) => s.length > 0);
  }
  if (/^-?\d+$/.test(val))           return parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val))      return parseFloat(val);
  return val;
}

/* ========================================================================
 * Multi-document parser
 *
 * Splits the input into { frontmatter, body } pairs by tracking bare `---`
 * lines. First `---` opens FM for card 1. Next `---` closes FM, body starts.
 * Next `---` commits card 1 and opens card 2's FM. Lather, rinse.
 *
 * A bare `---` inside a body is treated as a card separator — intentional.
 * Horizontal rules in card notes must use `----` or more.
 * ====================================================================== */

function parseDocs(src) {
  const out = [];
  let cur = null;   // { fm: string[], body: string[], inFm: boolean }
  const commit = () => {
    if (!cur) return;
    out.push({
      frontmatter: parseFrontmatter(cur.fm.join('\n')),
      body: cur.body.join('\n').trim(),
    });
    cur = null;
  };
  for (const line of src.split('\n')) {
    if (line.trim() === '---') {
      if (!cur)           cur = { fm: [], body: [], inFm: true };
      else if (cur.inFm)  cur.inFm = false;
      else              { commit(); cur = { fm: [], body: [], inFm: true }; }
    } else if (cur) {
      (cur.inFm ? cur.fm : cur.body).push(line);
    }
    // lines before the first `---` are ignored
  }
  commit();
  return out;
}

/* ========================================================================
 * Serializers — the inverse of parseDocs; same format out.
 * ====================================================================== */

function serializeScalar(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return '[' + v.map(serializeItem).join(', ') + ']';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  // Quote if value has a leading/trailing space or starts with a YAML meta char
  if (/^[\s\[\]{}&*!|>'"%@`#]/.test(s) || /\s$/.test(s)) return JSON.stringify(s);
  return s;
}
function serializeItem(v) {
  if (typeof v === 'string' && /[,\s\[\]"]/.test(v)) return JSON.stringify(v);
  return String(v);
}

function renderCard(card) {
  const fm = [
    ['id',         card.id],
    ['col',        card.col],
    ['title',      card.title],
    ['agent',      card.agent ?? null],
    ['tags',       card.tags ?? []],
    ['progress',   card.progress ?? null],
    ['question',   card.question ?? null],
    ['created_at', card.created_at],
    ['updated_at', card.updated_at],
  ].filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0));
  const lines = fm.map(([k, v]) => `${k}: ${serializeScalar(v)}`);
  return `---\n${lines.join('\n')}\n---\n${card.notes || ''}`;
}

function renderSpace(space, extras = {}) {
  const fm = [
    ['name',       space.name],
    ['cards',      extras.cards],
    ['created_at', space.created_at],
  ].filter(([, v]) => v !== undefined && v !== null);
  const lines = fm.map(([k, v]) => `${k}: ${serializeScalar(v)}`);
  return `---\n${lines.join('\n')}\n---\n${space.description || ''}`;
}

function renderMany(docs) { return docs.join('\n\n'); }

/* ========================================================================
 * JSON equivalents (for the dashboard).
 * ====================================================================== */

const toJsonCard  = (c) => ({ ...c });
const toJsonSpace = (name) => ({
  name,
  description: spaces.get(name).description,
  created_at:  spaces.get(name).created_at,
  cards:       bySpace.get(name).size,
});

/* ========================================================================
 * HTTP helpers
 * ====================================================================== */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function wantsJson(req) {
  const accept = (req.headers && req.headers.accept) || '';
  return accept.includes('application/json');
}

function sendMd(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/markdown; charset=utf-8' });
  res.end(body);
}
function sendJson(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function sendText(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

/* ========================================================================
 * SSE push — live UI updates when agents (or the UI itself) mutate state.
 *
 * Clients subscribe with `new EventSource('/api/kanban/events')`. Every
 * mutating route calls notify() at the end with a small JSON payload so
 * listeners can decide whether to refetch.
 * ====================================================================== */

const subscribers = new Set();

function notify(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subscribers) {
    try { res.write(line); } catch { subscribers.delete(res); }
  }
}

/* ========================================================================
 * Upsert logic
 * ====================================================================== */

function assignNextId() {
  while (cards.has(`atl-${nextId}`)) nextId += 1;
  const id = `atl-${nextId}`;
  nextId += 1;
  return id;
}

/* Validation is split from application so a batch POST rejects wholesale
 * when any doc is malformed — no partial writes. validate* throws; apply*
 * assumes validation has already passed. */

function validateSpaceDoc(doc) {
  validateKeys(doc, SPACE_KEYS, 'space');
  const name = doc.frontmatter.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new Error(`invalid space name: ${JSON.stringify(name)} (kebab-case, a-z 0-9 -)`);
  }
}

function applySpace(doc) {
  const name = doc.frontmatter.name;
  const existing = spaces.get(name);
  const now = new Date().toISOString();
  const description = doc.body || (existing?.description || '');
  spaces.set(name, { description, created_at: existing?.created_at || now });
  if (!bySpace.has(name)) bySpace.set(name, new Set());
  return name;
}

function validateCardDoc(spaceName, doc) {
  validateKeys(doc, CARD_KEYS, 'card');
  if (!spaces.has(spaceName)) {
    const err = new Error(`space '${spaceName}' does not exist`);
    err.code = 404;
    err.hint = `create it first: POST /api/kanban/spaces`;
    throw err;
  }
  const fm = doc.frontmatter;
  const id = typeof fm.id === 'string' && fm.id ? fm.id : null;
  const existing = id ? cards.get(id) : null;
  const col = fm.col ?? existing?.col ?? null;
  if (!COLS.includes(col)) {
    throw new Error(`card ${id ? `'${id}'` : '(new)'} has invalid col: ${JSON.stringify(col)} (one of ${COLS.join(', ')})`);
  }
}

function applyCard(spaceName, doc) {
  const fm = doc.frontmatter;
  const now = new Date().toISOString();
  let id = typeof fm.id === 'string' && fm.id ? fm.id : null;
  const existing = id ? cards.get(id) : null;

  if (!existing && !id) id = assignNextId();
  else if (!existing && id) {
    const m = /^atl-(\d+)$/.exec(id);
    if (m && Number(m[1]) >= nextId) nextId = Number(m[1]) + 1;
  }

  const col = fm.col ?? existing?.col ?? null;

  const card = {
    id,
    space:      spaceName,
    col,
    title:      fm.title    ?? existing?.title    ?? '(untitled)',
    agent:      fm.agent    ?? existing?.agent    ?? null,
    tags:       Array.isArray(fm.tags)   ? fm.tags   : (existing?.tags     || []),
    progress:   typeof fm.progress === 'number' ? fm.progress : (existing?.progress ?? null),
    question:   fm.question ?? existing?.question ?? null,
    notes:      doc.body !== ''         ? doc.body  : (existing?.notes    || ''),
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  // Relocate if the card existed in a different space
  if (existing && existing.space !== spaceName) {
    bySpace.get(existing.space)?.delete(id);
  }
  cards.set(id, card);
  bySpace.get(spaceName).add(id);
  return card;
}

/* ========================================================================
 * Routes
 * ====================================================================== */

export default {
  mountRoutes(router, ctx) {
    ctx.log(`kanban · ${spaces.size} spaces, ${cards.size} cards (${fs.existsSync(BOARD_PATH) ? 'loaded from disk' : 'empty — no board.md yet'})`);

    // GET /api/kanban/events — SSE stream of mutation events.
    router.get('/api/kanban/events', (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 500\n\n');
      subscribers.add(res);
      req.on('close', () => subscribers.delete(res));
    });

    // GET /api/kanban/spaces
    router.get('/api/kanban/spaces', (req, res) => {
      const names = [...spaces.keys()].sort();
      if (wantsJson(req)) {
        return sendJson(res, { spaces: names.map(toJsonSpace) });
      }
      const docs = names.map((n) => renderSpace({ name: n, ...spaces.get(n) }, { cards: bySpace.get(n).size }));
      sendMd(res, renderMany(docs) + '\n');
    });

    // POST /api/kanban/spaces — one or many space docs
    router.post('/api/kanban/spaces', async (req, res) => {
      const body = await readBody(req);
      let docs;
      try { docs = parseDocs(body); }
      catch (e) { return sendText(res, `parse error: ${e.message}\n`, 400); }
      if (docs.length === 0) return sendText(res, 'no space documents found\n', 400);

      // Phase 1 — validate; one bad doc rejects the batch.
      const errors = [];
      for (let i = 0; i < docs.length; i++) {
        try { validateSpaceDoc(docs[i]); }
        catch (e) { errors.push(`[space ${i + 1}] ${e.message}`); }
      }
      if (errors.length) return sendText(res, errors.join('\n') + '\n', 400);

      // Phase 2 — apply.
      const created = [];
      const updated = [];
      for (const d of docs) {
        const existed = spaces.has(d.frontmatter.name);
        const name = applySpace(d);
        (existed ? updated : created).push(name);
      }
      persistToDisk();
      notify({ type: 'spaces-changed' });
      if (wantsJson(req)) return sendJson(res, { created, updated });
      sendText(res, [
        ...created.map((n) => `created: ${n}`),
        ...updated.map((n) => `updated: ${n}`),
      ].join('\n') + '\n');
    });

    // GET /api/kanban/spaces/:name/cards
    router.get('/api/kanban/spaces/:name/cards', (req, res) => {
      const name = req.params.name;
      if (!spaces.has(name)) return sendText(res, `space '${name}' not found\n`, 404);
      const ids = [...bySpace.get(name)];
      const list = ids.map((id) => cards.get(id));
      list.sort((a, b) => (a.id < b.id ? 1 : -1));    // newest ids first
      if (wantsJson(req)) return sendJson(res, { cards: list.map(toJsonCard) });
      if (list.length === 0) return sendMd(res, '');
      sendMd(res, renderMany(list.map(renderCard)) + '\n');
    });

    // POST /api/kanban/spaces/:name/cards — one or many card docs
    router.post('/api/kanban/spaces/:name/cards', async (req, res) => {
      const name = req.params.name;
      if (!spaces.has(name)) {
        return sendText(res,
          `space '${name}' does not exist.\n` +
          `hint: create it first — POST /api/kanban/spaces with a frontmatter doc {name: ${name}}\n`,
          404);
      }
      const body = await readBody(req);
      let docs;
      try { docs = parseDocs(body); }
      catch (e) { return sendText(res, `parse error: ${e.message}\n`, 400); }
      if (docs.length === 0) return sendText(res, 'no card documents found\n', 400);

      // Phase 1 — validate everything. Collect all errors; one bad card
      // rejects the whole batch (no partial writes).
      const errors = [];
      for (let i = 0; i < docs.length; i++) {
        try { validateCardDoc(name, docs[i]); }
        catch (e) { errors.push(`[card ${i + 1}] ${e.message}`); }
      }
      if (errors.length) return sendText(res, errors.join('\n') + '\n', 400);

      // Phase 2 — apply, and track relocations for SSE.
      const plans = docs.map((d) => {
        const id = typeof d.frontmatter.id === 'string' && d.frontmatter.id ? d.frontmatter.id : null;
        const existed = id ? cards.has(id) : false;
        const prevSpace = existed ? cards.get(id).space : null;
        return { d, existed, prevSpace };
      });
      const created = [];
      const updated = [];
      for (const p of plans) {
        const card = applyCard(name, p.d);
        (p.existed ? updated : created).push(card.id);
      }

      // Emit cards-changed for every space touched (source + destination).
      const touched = new Set([name]);
      for (const p of plans) if (p.prevSpace) touched.add(p.prevSpace);
      persistToDisk();
      for (const sp of touched) notify({ type: 'cards-changed', space: sp });
      if (wantsJson(req)) return sendJson(res, { created, updated });
      sendText(res, [
        ...created.map((id) => `created: ${id}`),
        ...updated.map((id) => `updated: ${id}`),
      ].join('\n') + '\n');
    });
  },
};