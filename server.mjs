#!/usr/bin/env node
/**
 * Rosie Portal local server
 * - Serves portal UI
 * - Exposes JSON/text endpoints backed by workspace/memory files
 * - Lightweight POST updates (chat queue, mark-done, order stage)
 * - Local integrations: OpenClaw status, GHL Estimates (read-only)
 *
 * Safety:
 * - Binds to 127.0.0.1 by default.
 * - Reads local tokens from workspace.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const WORKSPACE = process.env.WORKSPACE || path.resolve(__dirname, '..');
const MEMORY_DIR = path.join(WORKSPACE, 'memory');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8789);

const FILES = {
  triageState: path.join(MEMORY_DIR, 'triage-state.json'),
  latestSummary: path.join(MEMORY_DIR, 'triage-latest.txt'),
  calendar: path.join(MEMORY_DIR, 'calendar-snapshot.json'),
  orders: path.join(MEMORY_DIR, 'orders-state.json'),
  chatInbox: path.join(MEMORY_DIR, 'portal-chat-inbox.jsonl'),
  chatOutbox: path.join(MEMORY_DIR, 'portal-chat-outbox.jsonl'),
  actionResults: path.join(MEMORY_DIR, 'portal-action-results.json'),
  tasksFile:  path.join(MEMORY_DIR, 'portal-tasks.jsonl'),
  eventsFile: path.join(MEMORY_DIR, 'portal-events.json'),
  usersFile: path.join(MEMORY_DIR, 'portal-users.json'),
  sessionsFile: path.join(MEMORY_DIR, 'portal-sessions.json'),
  ghlToken: path.join(WORKSPACE, 'projects', 'ghl', 'ghl.token.json'),
  ghlEnv: path.join(WORKSPACE, 'projects', 'ghl', '.env'),
  draftsDir: path.join(WORKSPACE, 'out', 'drafts'),
  portalState: path.join(MEMORY_DIR, 'portal-state.json'),
  accessRequestsFile: path.join(MEMORY_DIR, 'portal-access-requests.json'),
  scrubLogFile: path.join(MEMORY_DIR, 'portal-scrub-log.jsonl'),
};

function ensureFile(filePath, defaultContent) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, defaultContent);
  } catch (e) {
    console.error(`[ensureFile] Failed to ensure ${filePath}:`, e.message);
  }
}

ensureFile(FILES.orders, JSON.stringify({ lastUpdated: null, orders: [] }, null, 2));
ensureFile(FILES.calendar, JSON.stringify({ lastUpdated: null, calendarId: null, events: [] }, null, 2));
ensureFile(FILES.chatInbox, '');
ensureFile(FILES.chatOutbox, '');
ensureFile(FILES.actionResults, JSON.stringify({ lastUpdated: null, items: [] }, null, 2));
ensureFile(FILES.tasksFile,  '');
ensureFile(FILES.eventsFile, JSON.stringify({ events: [] }, null, 2));
ensureFile(FILES.portalState, JSON.stringify({ lastGhlSync: null, lastBriefDate: null }, null, 2));
ensureFile(FILES.usersFile, JSON.stringify({ users: [
  { id: 'u_cole', name: 'Cole', role: 'admin', passwordHash: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8' },
  { id: 'u_christine', name: 'Christine', role: 'va', passwordHash: '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8' },
] }, null, 2));
ensureFile(FILES.sessionsFile, JSON.stringify({ sessions: [] }, null, 2));
ensureFile(FILES.accessRequestsFile, JSON.stringify({ requests: [] }, null, 2));
ensureFile(FILES.scrubLogFile, '');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function readText(p, fallback='') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function appendJsonl(p, obj) {
  fs.appendFileSync(p, JSON.stringify(obj) + '\n');
}
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function writeJsonl(p, items) {
  fs.writeFileSync(p, items.map(i => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
}
function readJsonl(p) {
  const text = readText(p, '');
  return text.split(/\r?\n/).filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

function sendJson(res, obj) {
  send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify(obj));
}

function bad(res, status, msg, details=null) {
  send(res, status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify({ error: msg, details }));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1_000_000) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function serveStatic(reqPath, res) {
  // Map / -> index.html, else serve from portal directory.
  const rel = reqPath === '/' ? '/index.html' : reqPath;
  const fsPath = path.join(__dirname, rel);
  const normalized = path.normalize(fsPath);
  if (!normalized.startsWith(__dirname)) return bad(res, 403, 'Forbidden');

  if (!fs.existsSync(normalized) || fs.statSync(normalized).isDirectory()) {
    return bad(res, 404, 'Not found');
  }

  const ext = path.extname(normalized).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
  }[ext] || 'application/octet-stream';

  const body = fs.readFileSync(normalized);
  send(res, 200, { 'Content-Type': mime, 'Cache-Control': 'no-store' }, body);
}

async function runCmd(cmd, args, { timeoutMs = 8000, env = {} } = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env } });
    let out = '';
    let err = '';

    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      reject(new Error(`Timeout running ${cmd}`));
    }, timeoutMs);

    child.stdout.on('data', d => out += d.toString('utf8'));
    child.stderr.on('data', d => err += d.toString('utf8'));
    child.on('error', e => { clearTimeout(t); reject(e); });
    child.on('close', code => {
      clearTimeout(t);
      resolve({ code, stdout: out.trimEnd(), stderr: err.trimEnd() });
    });
  });
}

function parseDotEnv(envPath) {
  try {
    const text = fs.readFileSync(envPath, 'utf8');
    const out = {};
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
    return out;
  } catch { return {}; }
}

function ghlToken() {
  const t = readJson(FILES.ghlToken, null);
  if (!t?.access_token) return null;
  return t;
}

// -- Slack -----------------------------------------------------------------
const SLACK_OPS_CHANNEL = 'C0AGZ4875MG'; // merch-troop-ops

function slackBotToken() {
  try {
    const cfg = readJson(path.join(process.env.HOME || '/Users/colelundstrom', '.openclaw', 'openclaw.json'), {});
    return cfg?.channels?.slack?.botToken || null;
  } catch { return null; }
}

async function slackPost(channel, text) {
  const token = slackBotToken();
  if (!token) return { ok: false, error: 'no_token' };
  try {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text }),
    });
    return await r.json();
  } catch (e) { return { ok: false, error: e.message }; }
}

function ghlApiKey() {
  return { key: null, locationId: null };
}

async function ghlPost(path, body) {
  const t = ghlToken();
  if (!t?.access_token) throw new Error('GHL token not configured');
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      Version: '2021-07-28',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!r.ok) { const err = new Error(`GHL HTTP ${r.status}`); err.details = json; throw err; }
  return json;
}

async function ghlFetch(p) {
  // OAuth-only path by policy.
  const t = ghlToken();
  if (!t?.access_token) throw new Error('GHL OAuth token not found (projects/ghl/ghl.token.json access_token required)');

  const r = await fetch(`https://services.leadconnectorhq.com${p}` , {
    headers: {
      Authorization: `Bearer ${t.access_token}`,
      Version: '2021-07-28',
      Accept: 'application/json'
    }
  });

  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!r.ok) {
    const err = new Error(`GHL HTTP ${r.status}`);
    err.details = json;
    throw err;
  }

  return json;
}

function actionKeyFor(target = {}) {
  return `${target.kind || 'record'}:${target.id || target.invoiceNumber || target.name || 'unknown'}`;
}

function buildFallbackOutput(actionType, target = {}) {
  const name = target.contactName || target.name || target.invoiceNumber || target.id || 'record';
  if (actionType === 'lead_followup') {
    return `SMS: Hi ${name}, quick check-in from Merch Troop. Want me to lock in a quote and timeline for your project?\n\nEmail: Subject: Quick follow-up on your Merch Troop project\nHi ${name}, just following up to keep this moving. If you share quantity + due date, I can send options and next steps today.`;
  }
  if (actionType === 'estimate_followup') {
    return `Day 1: "Wanted to make sure you saw estimate ${target.id || ''}. Happy to walk through options."\nDay 3: "Checking timing on this project and any revisions needed."\nDay 7: "Last nudge before I archive this estimate--reply and I'll reopen priority."`;
  }
  if (actionType === 'production_plan') {
    return `Production plan for ${name}:\n1) Confirm art approval\n2) Order blanks and verify stock\n3) Assign press/date window\n4) QA + pack-out\n5) Confirm ship/pickup and notify client`;
  }
  return `Action prepared for ${name}.`;
}

async function runActionWithFallback(actionType, target = {}) {
  const msg = {
    id: `a_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    at: new Date().toISOString(),
    text: `[${actionType}] ${JSON.stringify(target)}`,
    source: 'portal-action',
    actionType,
  };
  appendJsonl(FILES.chatInbox, msg);

  let responderOutput = null;
  try {
    const started = Date.now();
    while (Date.now() - started < 1400) {
      const out = readJsonl(FILES.chatOutbox).reverse();
      const hit = out.find(x => x.replyTo === msg.id && (x.text || '').trim());
      if (hit) {
        responderOutput = String(hit.text || '').trim();
        break;
      }
      await sleep(250);
    }
  } catch (e) {
    console.error('[action-fallback] Error waiting for responder:', e.message);
  }

  const output = responderOutput || buildFallbackOutput(actionType, target);
  const fallbackUsed = !responderOutput;
  return {
    id: `r_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    actionType,
    target,
    key: actionKeyFor(target),
    status: 'success',
    output,
    fallbackUsed,
    createdAt: new Date().toISOString(),
  };
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function getSession(req) {
  // Support both cookie and Authorization header token
  const cookie = req.headers['cookie'] || '';
  const tokenFromCookie = cookie.match(/portal_session=([^;]+)/)?.[1];
  const authHeader = req.headers['authorization'] || '';
  const tokenFromHeader = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  const token = tokenFromCookie || tokenFromHeader;
  if (!token) return null;
  const store = readJson(FILES.sessionsFile, { sessions: [] });
  const session = (store.sessions || []).find(s => s.token === token);
  if (!session) return null;
  if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now()) return null;
  return session;
}

function checkBasicAuth(req) {
  // Legacy Basic auth still works for backward compat (Rosie, scripts)
  const h = req.headers['authorization'] || '';
  const m = String(h).match(/^Basic\s+(.+)$/i);
  if (m) {
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const [user, pass] = decoded.split(':');
    const legacyUser = process.env.PORTAL_USER || 'team';
    const legacyPass = process.env.PORTAL_PASS || 'MerchTroopTeam';
    if (user === legacyUser && pass === legacyPass) return true;
    // Also accept name:password for individual users
    const users = readJson(FILES.usersFile, { users: [] }).users || [];
    const found = users.find(u => u.name.toLowerCase() === user.toLowerCase() && u.passwordHash === sha256(pass));
    if (found) return true;
  }
  // Session token check
  return !!getSession(req);
}

// -- Task pipeline --------------------------------------------------------
const TASK_STAGES = {
  follow_up_lead: {
    label: 'Follow up with lead', next: 'send_estimate', color: 'attention', slaDays: 0.25,
    instructions: [
      'Check GHL for any previous contact history or notes',
      'Send a quick intro text or email -- respond within the hour',
      'Key info to gather: qty, item type, decoration method, event or ship date',
      'Goal: book a call or get enough detail to draft an estimate',
    ],
    quickLinks: [],
  },
  send_estimate: {
    label: 'Send estimate', next: 'follow_up_estimate', color: 'normal', slaDays: 1,
    instructions: [
      'Use the Calculator to price the job (check job notes for details)',
      'Create the estimate in GHL with separate line items -- no bundled packages',
      'Include event date/location in line item descriptions (customer-facing)',
      'Default travel = $300 unless Cole says otherwise',
      'Send the estimate share link directly to the customer',
    ],
    quickLinks: [{ label: 'Open GHL', href: 'https://app.gohighlevel.com' }],
  },
  follow_up_estimate: {
    label: 'Follow up on estimate', next: null, color: 'attention', slaDays: 3,
    instructions: [
      'Day 1: "Wanted to make sure you got the estimate -- happy to walk through it"',
      'Day 3: "Checking in on timing and whether any revisions are needed"',
      'Day 7: "Last follow-up before I archive this -- reply if you want to move forward"',
      'Log each attempt in GHL contact notes with date and method (text/email)',
    ],
    quickLinks: [{ label: 'Open GHL', href: 'https://app.gohighlevel.com' }],
  },
  order_blanks: {
    label: 'Order blanks', next: 'confirm_art', color: 'urgent', slaDays: 1,
    instructions: [
      'Check job notes for exact style, color, and size breakdown',
      'Log into S&S Activewear and add items to cart',
      'Add 5–10% overage for misprints on large orders',
      'Confirm delivery date meets the production schedule',
      'Save the S&S order confirmation number in task notes when done',
    ],
    quickLinks: [{ label: 'S&S Activewear', href: 'https://www.ssactivewear.com' }],
  },
  confirm_art: {
    label: 'Confirm art approval', next: 'schedule_production', color: 'attention', slaDays: 2,
    instructions: [
      'Send the art mockup to the customer for approval',
      'Get written confirmation (text or email reply) before printing',
      'Note any color call-outs, placement adjustments, or special instructions',
      'If no response in 24h, follow up once -- then flag for Cole',
    ],
    quickLinks: [],
  },
  schedule_production: {
    label: 'Schedule production', next: 'qc_pack', color: 'normal', slaDays: 2,
    instructions: [
      'Confirm blanks have arrived before scheduling',
      'Block the production window on the calendar',
      'Assign press and staff based on job size and method',
      'Notify Cole of the scheduled date and time',
    ],
    quickLinks: [],
  },
  qc_pack: {
    label: 'QC + pack out', next: 'ship_deliver', color: 'normal', slaDays: 1,
    instructions: [
      'Count all pieces against the order sheet -- verify quantities and sizes',
      'Check print quality: no smears, correct colors, correct placement',
      'Pack securely; include any inserts, tags, or custom labels',
      'Take a photo of the finished packed order for the file',
    ],
    quickLinks: [],
  },
  ship_deliver: {
    label: 'Ship / deliver', next: null, color: 'normal', slaDays: 1,
    instructions: [
      'Create shipping label or confirm local delivery time with customer',
      'Send tracking number to customer via text or email',
      'Update GHL contact notes with delivery confirmation',
      'Mark the invoice as delivered in GHL',
    ],
    quickLinks: [],
  },
  confirm_event: {
    label: 'Confirm event details + art', next: 'order_event_supplies', color: 'urgent', slaDays: 1,
    instructions: [
      'Confirm: venue address, event start time, setup/arrival time, # stations',
      'Get final art files -- all print locations, correct colors',
      'Confirm full garment/item list with quantities from customer',
      'Send a confirmation email back to customer with all event details',
    ],
    quickLinks: [],
  },
  order_event_supplies: {
    label: 'Order blanks + supplies', next: 'event_production', color: 'attention', slaDays: 2,
    instructions: [
      'Order blanks: exact style, color, size breakdown from job notes',
      'Order consumables as needed: ink, transfers, DTF film, patches',
      'Confirm delivery arrives at least 3 days before the event',
      'Save all order confirmation numbers in task notes',
    ],
    quickLinks: [{ label: 'S&S Activewear', href: 'https://www.ssactivewear.com' }],
  },
  event_production: {
    label: 'Production run', next: 'pack_event_kit', color: 'attention', slaDays: 3,
    instructions: [
      'Complete all pre-event printing: transfers, patches, pre-prints',
      'Test all equipment before event day -- no surprises on-site',
      'Prepare pre-made inventory buffer for expected volume',
      'Bag and label pre-made items separately by design/size',
    ],
    quickLinks: [],
  },
  pack_event_kit: {
    label: 'Pack event kit', next: null, color: 'urgent', slaDays: 1,
    instructions: [
      'Load all equipment: presses, heat guns, power strips, extension cords',
      'Pack all garments/blanks in labeled bags by size',
      'Pack consumables: transfers, ink, supplies kit, tape, scissors',
      'Print the event sheet: customer name, address, start time, contact number',
      'Double-check everything against the event checklist before leaving',
    ],
    quickLinks: [],
  },
};

function generatePackingChecklist(task) {
  const notes = (task.notes || '').toLowerCase();
  const stationMatch = notes.match(/(\d+)\s*station/);
  const stations = stationMatch ? parseInt(stationMatch[1]) : 1;

  const items = [
    { id: 'press', text: `Heat press${stations > 1 ? 'es' : ''} (${stations}x)`, checked: false },
    { id: 'power', text: 'Power strips + extension cords', checked: false },
    { id: 'transfers', text: 'Transfers / print files', checked: false },
    { id: 'blanks', text: 'All garments/blanks (labeled by size)', checked: false },
    { id: 'consumables', text: 'Consumables kit (tape, scissors, spare ink)', checked: false },
    { id: 'sheet', text: 'Event sheet (address, time, contact #)', checked: false },
    { id: 'heat_gun', text: 'Heat gun + temp gun', checked: false },
    { id: 'table', text: 'Folding table + tablecloth', checked: false },
    { id: 'signage', text: 'Merch Troop signage / banner', checked: false },
    { id: 'backup', text: 'Backup supplies (extra transfers, gloves)', checked: false },
  ];

  if (/uv dtf|uv-dtf/.test(notes)) {
    items.push({ id: 'uv_lamp', text: 'UV lamp / curing station', checked: false });
  }
  if (/embroid/.test(notes)) {
    items.push({ id: 'embroid', text: 'Embroidery machine + thread', checked: false });
  }

  return items;
}

const ORDER_PIPELINE = ['follow_up_lead','send_estimate','follow_up_estimate','order_blanks','confirm_art','schedule_production','qc_pack','ship_deliver'];
const EVENT_PIPELINE = ['follow_up_lead','send_estimate','follow_up_estimate','confirm_event','order_event_supplies','event_production','pack_event_kit'];

// Stages that require a confirmed payment before they can be created.
// Nothing past follow_up_estimate should exist without paidAt on the task.
const POST_PAYMENT_STAGES = new Set([
  'order_blanks','confirm_art','schedule_production','qc_pack','ship_deliver',
  'confirm_event','order_event_supplies','event_production','pack_event_kit',
]);

function computePriority(task) {
  if (task.priorityOverride) return task.priorityOverride;
  const base = TASK_STAGES[task.stage]?.color || 'normal';
  const waitDays = (Date.now() - new Date(task.waitingSince).getTime()) / 86400000;
  // Due-date escalation: event approaching fast → bump up
  if (task.dueDate) {
    const daysUntil = (new Date(task.dueDate).setHours(23,59,59) - Date.now()) / 86400000;
    if (daysUntil < 2)  return 'urgent';
    if (daysUntil < 7  && base !== 'urgent') return 'urgent';
    if (daysUntil < 14 && base === 'normal') return 'attention';
  }
  // Wait-time escalation
  if (base === 'normal'    && waitDays > 3) return 'attention';
  if (base === 'attention' && waitDays > 5) return 'urgent';
  return base;
}

function computeSla(task) {
  const sla = TASK_STAGES[task.stage]?.slaDays;
  if (!sla) return { status: 'none', text: null };
  const elapsed = (Date.now() - new Date(task.waitingSince).getTime()) / 86400000;
  const remaining = sla - elapsed;
  const pct = elapsed / sla;
  let status = pct >= 1 ? 'overdue' : pct >= 0.7 ? 'dueSoon' : 'onTrack';
  let text;
  if (remaining <= 0) {
    const over = -remaining;
    text = over < 1 ? Math.round(over * 24) + 'h overdue' : Math.round(over) + 'd overdue';
  } else if (remaining < 1) {
    text = Math.round(remaining * 24) + 'h left';
  } else {
    text = Math.round(remaining) + 'd left';
  }
  return { status, text };
}

// Numeric sort score within a priority tier.
// Higher = more urgent within the tier.
function computePriorityScore(task, priority, sla) {
  const tierWeight = { urgent: 1000, attention: 500, normal: 100 }[priority] ?? 100;
  // Revenue: logarithmic -- $1k ≈ +30pts, $10k ≈ +40pts, capped at 80
  const rev = Number(task.amount) || 0;
  const revScore = rev > 0 ? Math.min(80, Math.round(Math.log10(rev + 1) * 20)) : 0;
  // SLA overrun: +3pts per hour overdue, capped at 150
  let slaScore = 0;
  if (sla.status === 'overdue' && task.waitingSince) {
    const slaDays = TASK_STAGES[task.stage]?.slaDays || 1;
    const elapsed = (Date.now() - new Date(task.waitingSince).getTime()) / 86400000;
    const hoursOverdue = Math.max(0, (elapsed - slaDays) * 24);
    slaScore = Math.min(150, Math.round(hoursOverdue * 3));
  }
  // Due-date proximity: closer deadline = higher score (only within 14 days)
  let dueScore = 0;
  if (task.dueDate) {
    const daysUntil = (new Date(task.dueDate + 'T23:59:59').getTime() - Date.now()) / 86400000;
    if (daysUntil <= 0)   dueScore = 100;
    else if (daysUntil < 7)  dueScore = Math.round((7 - daysUntil) / 7 * 80);
    else if (daysUntil < 14) dueScore = Math.round((14 - daysUntil) / 14 * 30);
  }
  return tierWeight + revScore + slaScore + dueScore;
}

// Infer what/who is blocking a task based on stage semantics.
const BLOCKED_BY_STAGE = {
  follow_up_estimate: 'customer',
  confirm_art:        'customer',
  confirm_event:      'customer',
};
function inferBlockedBy(stage) {
  return BLOCKED_BY_STAGE[stage] || null;
}

// Compute AI-suggested next actions for a task based on stage + context.
function computeSuggestedActions(task, priority, sla) {
  const suggestions = [];
  const stage = task.stage;
  const waitDays = task.waitingSince ? (Date.now() - new Date(task.waitingSince).getTime()) / 86400000 : 0;
  const contact = task.contactName || 'the customer';

  if (stage === 'follow_up_lead') {
    if (waitDays < 1) {
      suggestions.push({ id: 'draft_intro', label: 'Draft intro message', action: 'draft_email', icon: '✉', priority: 'high' });
    } else {
      suggestions.push({ id: 'draft_followup', label: 'Draft follow-up', action: 'draft_email', icon: '✉', priority: 'high' });
    }
    suggestions.push({ id: 'draft_estimate', label: 'Draft estimate', action: 'draft_estimate', icon: '📋', priority: 'medium' });
  }

  if (stage === 'send_estimate') {
    suggestions.push({ id: 'draft_estimate', label: 'Auto-draft estimate', action: 'draft_estimate', icon: '📋', priority: 'high' });
    suggestions.push({ id: 'open_ghl', label: 'Open in GHL', action: 'open_url', url: 'https://app.gohighlevel.com', icon: '↗', priority: 'medium' });
  }

  if (stage === 'follow_up_estimate') {
    const followUpDay = waitDays < 1.5 ? 1 : waitDays < 3.5 ? 3 : 7;
    suggestions.push({ id: 'draft_fu_email', label: `Send Day ${followUpDay} follow-up`, action: 'draft_email', icon: '✉', priority: 'high' });
    if (task.amount) {
      suggestions.push({ id: 'mark_paid', label: 'Mark as paid', action: 'mark_paid', icon: '💳', priority: 'medium' });
    }
  }

  if (stage === 'confirm_art') {
    suggestions.push({ id: 'chase_art', label: 'Chase art approval', action: 'draft_email', icon: '✉', priority: 'high' });
  }

  if (stage === 'confirm_event') {
    suggestions.push({ id: 'confirm_details', label: 'Request event details', action: 'draft_email', icon: '✉', priority: 'high' });
  }

  if (stage === 'order_blanks' || stage === 'order_event_supplies') {
    suggestions.push({ id: 'open_ss', label: 'Open S&S Activewear', action: 'open_url', url: 'https://www.ssactivewear.com', icon: '↗', priority: 'high' });
  }

  if (sla.status === 'overdue') {
    suggestions.push({ id: 'flag_cole', label: 'Flag for Cole', action: 'flag_urgent', icon: '🚨', priority: 'urgent' });
  }

  return suggestions;
}

// -- Event schedule -------------------------------------------------------
function parseStaffCount(text) {
  if (!text) return 2;
  let m = text.match(/(\d+)\s*-?\s*station/i); if (m) return parseInt(m[1]);
  m = text.match(/(\d+)\s*staff/i);             if (m) return parseInt(m[1]);
  m = text.match(/(\d+)\s*press/i);             if (m) return parseInt(m[1]);
  m = text.match(/crew\s+of\s+(\d+)/i);         if (m) return parseInt(m[1]);
  return 2;
}

function readEvents() { return readJson(FILES.eventsFile, { events: [] }); }
function writeEvents(store) { writeJson(FILES.eventsFile, store); }

async function sendCalendarInvite(event, claim) {
  // Uses gog CLI (available on Rosie's machine) to send a Google Calendar invite.
  const start = `${event.date}T${(event.startTime || '09:00')}:00`;
  const end   = `${event.date}T${(event.endTime   || '17:00')}:00`;
  const title = `Merch Troop: ${event.eventName || event.contactName}`;
  const notes = [event.notes, event.address].filter(Boolean).join(' | ');
  try {
    const r = await runCmd('gog', [
      'calendar', 'events', 'create', 'primary',
      '--account', 'cole@merchtroop.com',
      '--title',   title,
      '--start',   start,
      '--end',     end,
      '--location', event.address || event.location || '',
      '--description', `Worker: ${claim.name} (${claim.email})\n${notes}`,
      '--attendee', claim.email,
      '--json',
    ], { timeoutMs: 15000 });
    if (r.code !== 0) return { ok: false };
    // Parse the created event's Google Calendar ID so we can poll RSVP status later.
    let googleCalEventId = null;
    try {
      const parsed = JSON.parse(r.stdout || '{}');
      googleCalEventId = parsed.id || parsed.eventId || null;
    } catch (e) {
      console.error('[calendar-invite] Failed to parse calendar response:', e.message);
    }
    return { ok: true, googleCalEventId };
  } catch (e) {
    console.error('[calendar-invite] Failed to send invite:', e.message);
    return { ok: false };
  }
}

// -- Task-Event Cascade --------------------------------------------------
// When a task is completed as LOST or set to cold/archived, cancel any linked
// mock events that share the same contactName+jobId to prevent orphan events
// (the "Andrea Benarroch bug": task marked LOST but event still showing).
function cascadeTaskToEvents(task, action) {
  if (!task) return 0;
  const store = readEvents();
  let cancelled = 0;
  const isLost = action === 'lost' || (task.completionNote && /lost|declined|cancel/i.test(task.completionNote));
  const isCold = action === 'cold' || action === 'archived';

  if (!isLost && !isCold) return 0;

  for (const ev of store.events) {
    if (ev.cancelled) continue;
    // Match by contactName (case-insensitive) -- events don't always have jobId
    const nameMatch = ev.contactName && task.contactName &&
      ev.contactName.toLowerCase() === task.contactName.toLowerCase();
    // Also match by invoiceId if the task has a sourceId
    const invoiceMatch = task.sourceId && ev.invoiceId && ev.invoiceId === task.sourceId;

    if (nameMatch || invoiceMatch) {
      ev.cancelled = true;
      ev.cancelledAt = new Date().toISOString();
      ev.cancelReason = isLost
        ? `Task marked LOST: ${task.completionNote || 'no note'}`
        : `Task set to ${action}`;
      cancelled++;
      console.log(`[cascade] Cancelled event "${ev.eventName}" (${ev.id}) -- task ${task.id} ${action}`);
    }
  }

  if (cancelled > 0) writeEvents(store);
  return cancelled;
}

function seedMockEventsIfEmpty() {
  // No more mock data -- all events come from GHL invoice sync
  return;
}
seedMockEventsIfEmpty();

function seedMockTasksIfEmpty() {
  // No more mock data -- all tasks come from GHL invoice sync
  return;
}
seedMockTasksIfEmpty();

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const p = u.pathname;

    // Auth endpoints (no auth required)
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { name, password } = payload;
      if (!name || !password) return bad(res, 400, 'Missing name/password');
      const users = readJson(FILES.usersFile, { users: [] }).users || [];
      const user = users.find(u => u.name.toLowerCase() === name.toLowerCase() && u.passwordHash === sha256(password));
      if (!user) return bad(res, 401, 'Invalid credentials');
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days
      const store = readJson(FILES.sessionsFile, { sessions: [] });
      store.sessions = (store.sessions || []).filter(s => s.userId !== user.id); // clear old sessions for this user
      store.sessions.push({ token, userId: user.id, name: user.name, role: user.role, createdAt: new Date().toISOString(), expiresAt });
      writeJson(FILES.sessionsFile, store);
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': `portal_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 3600}`,
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify({ ok: true, token, name: user.name, role: user.role }));
    }

    if (p === '/api/auth/logout' && req.method === 'POST') {
      const session = getSession(req);
      if (session) {
        const store = readJson(FILES.sessionsFile, { sessions: [] });
        store.sessions = (store.sessions || []).filter(s => s.token !== session.token);
        writeJson(FILES.sessionsFile, store);
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': 'portal_session=; Path=/; HttpOnly; Max-Age=0',
        'Cache-Control': 'no-store',
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (p === '/api/auth/me' && req.method === 'GET') {
      const session = getSession(req);
      if (!session) return bad(res, 401, 'Not authenticated');
      return sendJson(res, { ok: true, name: session.name, role: session.role, userId: session.userId });
    }

    if (p === '/api/auth/change-password' && req.method === 'POST') {
      const session = getSession(req);
      if (!session) return bad(res, 401, 'Not authenticated');
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { currentPassword, newPassword } = payload;
      if (!currentPassword || !newPassword) return bad(res, 400, 'Missing passwords');
      const store = readJson(FILES.usersFile, { users: [] });
      const idx = (store.users || []).findIndex(u => u.id === session.userId);
      if (idx < 0) return bad(res, 404, 'User not found');
      if (store.users[idx].passwordHash !== sha256(currentPassword)) return bad(res, 401, 'Wrong current password');
      store.users[idx].passwordHash = sha256(newPassword);
      writeJson(FILES.usersFile, store);
      return sendJson(res, { ok: true });
    }

    // Login page -- serve for unauthenticated browser requests
    if (p === '/login' && req.method === 'GET') {
      return serveStatic('/login.html', res);
    }

    // Request access page -- no auth required
    if (p === '/request-access' && req.method === 'GET') {
      return serveStatic('/request-access.html', res);
    }

    // Health
    if (p === '/healthz') return sendJson(res, { ok: true, port: PORT });

    // Public access request endpoint -- no auth required
    if (req.method === 'POST' && p === '/api/auth/request-access') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { name, reason } = payload;
      if (!name?.trim()) return bad(res, 400, 'Missing name');
      const store = readJson(FILES.accessRequestsFile, { requests: [] });
      const existing = (store.requests || []).find(r => r.name.toLowerCase() === name.trim().toLowerCase() && r.status === 'pending');
      if (existing) return sendJson(res, { ok: true, queued: true, message: 'Request already pending' });
      store.requests = store.requests || [];
      store.requests.push({ id: `req_${Date.now()}`, name: name.trim(), reason: (reason || '').trim(), status: 'pending', requestedAt: new Date().toISOString() });
      writeJson(FILES.accessRequestsFile, store);
      await slackPost(SLACK_OPS_CHANNEL, `:wave: *New access request* from *${name.trim()}*${reason ? '\n> ' + reason : ''}\nApprove in the portal → Admin tab`);
      return sendJson(res, { ok: true, queued: true });
    }

    // Skip auth for login page and assets
    const isPublic = ['/login', '/login.html', '/request-access', '/request-access.html'].includes(p) || p.startsWith('/login.');
    if (!isPublic && !checkBasicAuth(req)) {
      // For browser requests (no auth header), redirect to login
      const acceptsHtml = (req.headers['accept'] || '').includes('text/html');
      if (acceptsHtml && req.method === 'GET' && !p.startsWith('/api/')) {
        res.writeHead(302, { Location: '/login' });
        return res.end();
      }
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="MerchTroop Portal"', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'Auth required' }));
    }
    // Attach session to use downstream (for stamping who did what)
    req._session = getSession(req);

    // Role-based access: onsite users can only access schedule endpoints
    if (req._session?.role === 'onsite') {
      const onsiteAllowed = ['/api/schedule', '/api/schedule/claim', '/api/schedule/unclaim', '/api/schedule/staff-overview', '/api/auth/me', '/api/auth/logout', '/api/auth/change-password', '/healthz'];
      if (!onsiteAllowed.includes(p)) {
        return bad(res, 403, 'Access restricted to schedule only');
      }
    }

    // --- Data endpoints (memory-backed) ---
    if (req.method === 'GET' && p === '/triage-state.json') {
      return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, readText(FILES.triageState, '{}'));
    }
    if (req.method === 'GET' && p === '/latest-summary.txt') {
      return send(res, 200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, readText(FILES.latestSummary, 'No summary captured yet.'));
    }
    if (req.method === 'GET' && p === '/calendar.json') {
      return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, readText(FILES.calendar, '{"events":[]}'));
    }
    if (req.method === 'GET' && p === '/orders.json') {
      return send(res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, readText(FILES.orders, '{"orders":[]}'));
    }

    // --- Integrations: OpenClaw ---
    if (req.method === 'GET' && p === '/api/openclaw/status') {
      try {
        const r = await runCmd('openclaw', ['status', '--json'], { timeoutMs: 9000 });
        if (r.code !== 0) return bad(res, 500, 'openclaw status failed', { stderr: r.stderr });
        let j;
        try { j = JSON.parse(r.stdout || '{}'); } catch { j = { raw: r.stdout }; }
        return sendJson(res, { ok: true, status: j, capturedAt: new Date().toISOString() });
      } catch (e) {
        return bad(res, 500, 'openclaw status error', { message: e.message });
      }
    }

    // --- Integrations: GHL (read-only) ---
    if (req.method === 'GET' && p === '/api/ghl/status') {
      const t = ghlToken();
      const configured = !!(t?.access_token);
      return sendJson(res, {
        ok: true,
        configured,
        mode: t?.access_token ? 'oauth' : 'none',
        locationId: t?.locationId || null,
        scopes: t?.scope || null,
      });
    }

    if (req.method === 'GET' && p === '/api/ghl/estimates') {
      const locationId = u.searchParams.get('locationId') || ghlToken()?.locationId;
      if (!locationId) return bad(res, 400, 'Missing locationId (OAuth token locationId required)');
      const limit = Math.min(50, Math.max(1, Number(u.searchParams.get('limit') || 20)));
      const offset = Math.max(0, Number(u.searchParams.get('offset') || 0));

      try {
        const data = await ghlFetch(`/invoices/estimate/list?altType=location&altId=${encodeURIComponent(locationId)}&offset=${offset}&limit=${limit}`);
        const items = (data?.estimates || data?.invoices || data?.items || []).map(e => ({
          id: e.id || e._id || null,
          name: e.name || e.title || e.invoiceNumber || '(untitled)',
          contactName: e.contactDetails?.name || e.contactName || null,
          contactId: e.contactDetails?.id || e.contactDetails?._id || e.contactId || null,
          total: e.total || e.amount || e.totalAmount || null,
          status: e.status || e.invoiceStatus || null,
          createdAt: e.createdAt || e.dateAdded || null,
          updatedAt: e.updatedAt || e.dateUpdated || null,
          description: e.description || e.note || e.notes || e.internalNotes || null,
          lineSummary: Array.isArray(e.items)
            ? e.items.slice(0, 4).map(it => it?.name || it?.description).filter(Boolean).join(' • ')
            : null,
        }));
        return sendJson(res, { ok: true, locationId, offset, limit, items, rawCount: items.length, capturedAt: new Date().toISOString(), freshnessSec: 0, stale: false });
      } catch (e) {
        return bad(res, 500, 'Failed to load GHL estimates', e.details || { message: e.message });
      }
    }

    // --- Integrations: GHL Opportunities (leads) ---
    if (req.method === 'GET' && p === '/api/ghl/pipelines') {
      const locationId = u.searchParams.get('locationId') || ghlToken()?.locationId;
      if (!locationId) return bad(res, 400, 'Missing locationId');
      try {
        const data = await ghlFetch(`/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
        const pipelines = (data?.pipelines || []).map(p => ({
          id: p.id,
          name: p.name,
          stages: (p.stages || []).map(s => ({ id: s.id, name: s.name }))
        }));
        return sendJson(res, { ok: true, locationId, pipelines, capturedAt: new Date().toISOString() });
      } catch (e) {
        return bad(res, 500, 'Failed to load pipelines', e.details || { message: e.message });
      }
    }

    if (req.method === 'GET' && p === '/api/ghl/opportunities') {
      const locationId = u.searchParams.get('locationId') || ghlToken()?.locationId;
      if (!locationId) return bad(res, 400, 'Missing locationId');
      const stageId = u.searchParams.get('stageId');
      if (!stageId) return bad(res, 400, 'Missing stageId');
      const limit = Math.min(50, Math.max(1, Number(u.searchParams.get('limit') || 25)));
      try {
        const data = await ghlFetch(`/opportunities/search?location_id=${encodeURIComponent(locationId)}&pipeline_stage_id=${encodeURIComponent(stageId)}&limit=${limit}`);
        const items = (data?.opportunities || []).map(o => ({
          id: o.id,
          name: o.name,
          status: o.status,
          monetaryValue: o.monetaryValue || null,
          createdAt: o.createdAt || null,
          updatedAt: o.updatedAt || null,
          contactId: o.contactId || null,
          contactName: o.contactName || o?.contact?.name || null,
          source: o.source || null,
          notes: o.notes || o.note || o.description || o.internalNotes || null,
        }));
        return sendJson(res, { ok: true, locationId, stageId, limit, items, capturedAt: new Date().toISOString(), freshnessSec: 0, stale: false });
      } catch (e) {
        return bad(res, 500, 'Failed to load opportunities', e.details || { message: e.message });
      }
    }

    // --- Integrations: GHL Paid invoices (recent) ---
    if (req.method === 'GET' && p === '/api/ghl/paid-invoices') {
      const locationId = u.searchParams.get('locationId') || ghlToken()?.locationId;
      if (!locationId) return bad(res, 400, 'Missing locationId');
      const days = Math.min(30, Math.max(1, Number(u.searchParams.get('days') || 7)));
      const cutoffIso = new Date(Date.now() - days * 86400000).toISOString();
      const limit = 100;
      const items = [];

      try {
        for (let offset = 0; offset < 1200; offset += limit) {
          const data = await ghlFetch(`/invoices/?altType=location&altId=${encodeURIComponent(locationId)}&offset=${offset}&limit=${limit}`);
          const invoices = data?.invoices || [];
          if (!invoices.length) break;

          for (const inv of invoices) {
            const paidAt = inv.lastPaidAt || inv.paidAt || inv.updatedAt || inv.createdAt;
            if (inv.status === 'paid' && paidAt && paidAt >= cutoffIso) {
              items.push({
                id: inv._id || inv.id || null,
                invoiceNumber: inv.invoiceNumber || null,
                contactName: inv?.contactDetails?.name || inv.contactName || null,
                contactId: inv?.contactDetails?.id || inv?.contactDetails?._id || inv.contactId || null,
                total: inv.totalAmount || inv.total || inv.amount || null,
                paidAt,
              });
            }
          }

          const last = invoices[invoices.length - 1];
          const lastStamp = last?.lastPaidAt || last?.paidAt || last?.updatedAt || last?.createdAt;
          if (lastStamp && lastStamp < cutoffIso) break;
        }

        return sendJson(res, { ok: true, locationId, days, items: items.slice(0, 50), rawCount: items.length, capturedAt: new Date().toISOString(), freshnessSec: 0, stale: false });
      } catch (e) {
        return bad(res, 500, 'Failed to load paid invoices', e.details || { message: e.message });
      }
    }

    // --- Integrations: Calendar (live via gog) ---
    if (req.method === 'GET' && p === '/api/calendar/upcoming') {
      const days = Math.min(60, Math.max(1, Number(u.searchParams.get('days') || 14)));
      try {
        const from = new Date();
        const to = new Date(Date.now() + days * 86400000);
        const fromYmd = from.toISOString().slice(0, 10);
        const toYmd = to.toISOString().slice(0, 10);

        // Ensure gog uses the portal service's token store.
        const gogEnv = {
          HOME: process.env.HOME || '/var/lib/merchtroop-portal',
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/var/lib/merchtroop-portal/.config',
          GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || 'MerchTroopGogKeyring2026!',
        };

        const r = await runCmd('gog', ['calendar', 'events', 'primary', '--account', 'cole@merchtroop.com', '--from', fromYmd, '--to', toYmd, '--json', '--results-only', '--max', '200'], { timeoutMs: 12000, env: gogEnv });
        if (r.code !== 0) return bad(res, 500, 'gog calendar events failed', { stderr: r.stderr });
        let events;
        try { events = JSON.parse(r.stdout || '[]'); } catch { events = []; }
        const items = (events || []).map(ev => ({
          id: ev.id,
          title: ev.summary || ev.title || '(untitled)',
          start: ev.start?.dateTime || ev.start?.date || null,
          end: ev.end?.dateTime || ev.end?.date || null,
          location: ev.location || null,
          htmlLink: ev.htmlLink || null,
        }));
        return sendJson(res, { ok: true, days, items, capturedAt: new Date().toISOString(), freshnessSec: 0, stale: false });
      } catch (e) {
        return bad(res, 500, 'calendar upcoming error', { message: e.message });
      }
    }

    // --- Chat: read outbox (so UI can show replies) ---
    if (req.method === 'GET' && p === '/api/chat/outbox') {
      const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit') || 40)));
      const text = readText(FILES.chatOutbox, '');
      const lines = text.split(/\r?\n/).filter(Boolean);
      const slice = lines.slice(-limit).map(l => {
        try { return JSON.parse(l); } catch { return { raw: l }; }
      });
      return sendJson(res, { ok: true, limit, items: slice });
    }

    if (req.method === 'GET' && p === '/api/actions/results') {
      const limit = Math.min(200, Math.max(1, Number(u.searchParams.get('limit') || 40)));
      const data = readJson(FILES.actionResults, { lastUpdated: null, items: [] });
      const items = Array.isArray(data.items) ? data.items.slice(0, limit) : [];
      return sendJson(res, { ok: true, lastUpdated: data.lastUpdated || null, items });
    }

    if (req.method === 'POST' && p === '/api/actions/run') {
      const body = await collectBody(req);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return bad(res, 400, 'Invalid JSON'); }
      const actionType = String(payload.actionType || '').trim();
      const targets = Array.isArray(payload.targets) ? payload.targets.slice(0, 50) : [];
      if (!actionType) return bad(res, 400, 'Missing actionType');
      if (!targets.length) return bad(res, 400, 'Missing targets');

      const results = [];
      for (const t of targets) {
        const startedAt = new Date().toISOString();
        const t0 = Date.now();
        try {
          const r = await runActionWithFallback(actionType, t || {});
          results.push({ ...r, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - t0 });
        } catch (e) {
          results.push({
            id: `r_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            actionType,
            target: t || {},
            key: actionKeyFor(t || {}),
            status: 'failed',
            output: `Failed to generate output: ${e.message}`,
            fallbackUsed: true,
            createdAt: new Date().toISOString(),
            startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - t0,
            errorClass: 'runtime_error',
          });
        }
      }

      const store = readJson(FILES.actionResults, { lastUpdated: null, items: [] });
      const merged = [...results, ...(Array.isArray(store.items) ? store.items : [])].slice(0, 300);
      writeJson(FILES.actionResults, { lastUpdated: new Date().toISOString(), items: merged });

      return sendJson(res, {
        ok: true,
        actionType,
        count: results.length,
        successCount: results.filter(x => x.status === 'success').length,
        failCount: results.filter(x => x.status !== 'success').length,
        fallbackCount: results.filter(x => x.fallbackUsed).length,
        results,
      });
    }

    // --- Overview KPIs ---
    if (req.method === 'GET' && p === '/api/overview/kpis') {
      const now = Date.now();
      const todayStr = new Date().toISOString().slice(0, 10);
      const weekEnd  = new Date(now + 7 * 86400000).toISOString().slice(0, 10);
      const all      = readJsonl(FILES.tasksFile);
      const active   = all.filter(t => !t.completedAt && (!t.snoozedUntil || new Date(t.snoozedUntil).getTime() <= now));

      const pipelineRevenue    = active.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
      const overdueCount       = active.filter(t => computeSla(t).status === 'overdue').length;
      const followUpsDueToday  = active.filter(t => {
        if (!['follow_up_estimate', 'follow_up_lead'].includes(t.stage)) return false;
        const s = computeSla(t).status;
        return s === 'overdue' || s === 'dueSoon';
      }).length;

      const evStore        = readJson(FILES.eventsFile, { events: [] });
      const eventsThisWeek = evStore.events.filter(e => !e.cancelled && e.date >= todayStr && e.date <= weekEnd).length;

      return sendJson(res, {
        ok: true,
        pipelineRevenue,
        overdueCount,
        followUpsDueToday,
        eventsThisWeek,
        capturedAt: new Date().toISOString(),
      });
    }

    // --- Integrations: PromoStandards (placeholder) ---
    if (req.method === 'GET' && p === '/api/promostandards/status') {
      // Not yet wired; we'll add credentials + endpoints once we pick supplier(s) + auth method.
      return sendJson(res, { ok: false, configured: false, reason: 'not wired yet' });
    }

    // -- Pricing API (reads from context/pricing.json) ---------------------
    if (req.method === 'GET' && p === '/api/pricing') {
      const pricingPath = path.join(WORKSPACE, 'context', 'pricing.json');
      let pricing = readJson(pricingPath, null);
      if (!pricing) return bad(res, 500, 'pricing.json not found');

      const type = (u.searchParams.get('type') || '').toLowerCase();
      const qty = Math.max(1, Number(u.searchParams.get('qty') || 0));
      const colors = Math.max(1, Math.min(8, Number(u.searchParams.get('colors') || 1)));
      const width = Number(u.searchParams.get('width') || 10);
      const height = Number(u.searchParams.get('height') || 10);
      const live = u.searchParams.get('live') === 'true';
      const designCount = Math.max(1, Number(u.searchParams.get('designs') || 1));

      let costPerUnit = 0;
      let detail = {};

      if (type === 'screen') {
        // Screen print: use rates_by_range from pricing.json
        // color_index_key: 0=1color, 1=2color, 2=3color, 3=4color, 4=5plus_fullcolor
        const ranges = pricing.screen_print?.rates_by_range || {};
        const colorIdx = Math.min(colors, 5) - 1; // 0-indexed, max index 4 (5+ fullcolor)
        let rate = null;
        for (const [rangeKey, rates] of Object.entries(ranges)) {
          const m = rangeKey.match(/^(\d+)-?(\d+|\+)?$/);
          if (!m) continue;
          const lo = parseInt(m[1]);
          const hi = m[2] === '+' ? Infinity : (m[2] ? parseInt(m[2]) : lo);
          if (qty >= lo && qty <= hi) {
            rate = rates[colorIdx];
            break;
          }
        }
        // null means not available at this color count (e.g. 5+ colors)
        if (rate === null || rate === undefined) {
          return bad(res, 400, `Screen print with ${colors} color(s) is not available at qty ${qty}. Max 4 colors for standard screen print pricing.`);
        }
        costPerUnit = rate;
        if (live) costPerUnit += 1.50;
        detail = { method: 'screen', colors, qtyBreak: qty, rate, liveAddon: live ? 1.50 : 0 };
      } else if (type === 'dtf') {
        const sqin = width * height;
        const costPerSqin = pricing.dtf?.cost_per_sqin ?? 0.03;
        const pressFee = pricing.dtf?.press_fee_per_location ?? 1.50;
        costPerUnit = (sqin * costPerSqin) + pressFee;
        detail = { method: 'dtf', width, height, sqin, costPerSqin, pressFee };
      } else if (type === 'uvdtf') {
        const sqin = width * height;
        const costPerSqin = pricing.uvdtf?.cost_per_sqin ?? 0.05;
        const pressFee = pricing.uvdtf?.press_fee_per_location ?? 1.50;
        costPerUnit = (sqin * costPerSqin) + pressFee;
        detail = { method: 'uvdtf', width, height, sqin, costPerSqin, pressFee };
      } else if (type === 'embroidery') {
        if (live) {
          costPerUnit = qty >= 150 ? (pricing.embroidery?.live_rate_gte_150_units ?? 15) : (pricing.embroidery?.live_rate_under_150_units ?? 20);
        } else {
          costPerUnit = pricing.embroidery?.bulk_rate ?? 7;
        }
        detail = { method: 'embroidery', live, qty };
      } else if (type === 'laser') {
        const tiers = pricing.laser?.tiered_rates || [];
        for (const tier of tiers) {
          if (qty >= (tier.min_qty || 0)) { costPerUnit = tier.rate_per_unit; break; }
        }
        detail = { method: 'laser', qty };
      } else if (type === 'patch' || type === 'woven_patch' || type === 'leather_patch' || type === 'heat_patch') {
        const perDesign = qty > 150
          ? (pricing.patches?.per_design_rate_gt_150_units ?? 5)
          : (pricing.patches?.per_design_rate_lte_150_units ?? 8);
        costPerUnit = perDesign * designCount;
        if (live) costPerUnit += (pricing.patches?.live_addon_per_unit ?? 1.50);
        detail = { method: type, designCount, perDesign, liveAddon: live ? (pricing.patches?.live_addon_per_unit ?? 1.50) : 0 };
      } else {
        return bad(res, 400, 'Unknown type. Valid: screen, dtf, uvdtf, embroidery, laser, patch, woven_patch, leather_patch, heat_patch');
      }

      // Markup calculation
      const markupPct = Number(u.searchParams.get('markup') || pricing.defaults?.markup_pct || 40);
      const mode = u.searchParams.get('mode') || pricing.defaults?.mode || 'markup';
      let pricePerUnit;
      if (mode === 'margin') {
        const marginPct = Math.min(99.9, Math.max(0, markupPct));
        pricePerUnit = costPerUnit / (1 - marginPct / 100);
      } else {
        pricePerUnit = costPerUnit * (1 + markupPct / 100);
      }

      return sendJson(res, {
        ok: true,
        type,
        qty,
        costPerUnit: +costPerUnit.toFixed(4),
        pricePerUnit: +pricePerUnit.toFixed(4),
        markupPct,
        mode,
        totalCost: +(costPerUnit * qty).toFixed(2),
        totalPrice: +(pricePerUnit * qty).toFixed(2),
        detail,
        source: 'pricing.json',
      });
    }

    // -- Pricing: full table dump (for calculator UI) ----------------------
    if (req.method === 'GET' && p === '/api/pricing/tables') {
      const pricingPath = path.join(WORKSPACE, 'context', 'pricing.json');
      const pricing = readJson(pricingPath, null);
      if (!pricing) return bad(res, 500, 'pricing.json not found or invalid — check ~/.openclaw/workspace/context/pricing.json');
      return sendJson(res, { ok: true, pricing });
    }

    // --- Chat queue ---
    if (req.method === 'POST' && p === '/api/chat') {
      const body = await collectBody(req);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return bad(res, 400, 'Invalid JSON'); }
      const text = String(payload.text || '').trim();
      if (!text) return bad(res, 400, 'Missing text');

      const msg = {
        id: `m_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        at: new Date().toISOString(),
        text,
        source: 'portal',
      };
      appendJsonl(FILES.chatInbox, msg);

      // Lightweight built-in responder (no LLM) so chat never feels dead.
      // Produces a short operational response for common commands.
      let replyText = 'Queued. If this needs deeper work, Rosie will follow up here shortly.';
      try {
        const t = text.toLowerCase();
        if (t.includes('lead') && t.includes('audit')) {
          replyText = 'Lead audit: check Overview → Sales -- New leads (no contact yet). Use Open GHL to contact/book, then move stage in GHL.';
        } else if (t.includes('estimate') && (t.includes('follow') || t.includes('follow-up'))) {
          replyText = "Estimate follow-ups: check Overview → GHL Estimates (latest). I'll add a dedicated Follow-ups card next.";
        } else if (t.includes('calendar')) {
          replyText = 'Calendar is live now. Check Overview → Calendar (jobs + meetings) and expand rows for links.';
        }
      } catch (e) {
        console.error('[chat-responder] Error generating response:', e.message);
      }

      const reply = {
        replyTo: msg.id,
        at: new Date().toISOString(),
        text: replyText,
        source: 'rosie',
      };
      appendJsonl(FILES.chatOutbox, reply);

      return sendJson(res, { ok: true, queued: true, id: msg.id });
    }

    // --- Email triage: surface actionable threads without tasks ---
    if (req.method === 'GET' && p === '/api/email/triage') {
      const state = readJson(FILES.triageState, {});
      const open = state?.email?.open || {};
      const allTasks = readJsonl(FILES.tasksFile);
      const tasksByThread = new Set(
        allTasks.filter(t => t.source === 'email' && !t.completedAt).map(t => t.sourceId).filter(Boolean)
      );
      const guessSuggestedStage = item => {
        const text = [item.subject, item.summary, item.snippet, item.body].filter(Boolean).join(' ').toLowerCase();
        if (/invoice|paid|payment|deposit/.test(text)) return 'follow_up_estimate';
        if (/estimate|quote|pricing|cost|price/.test(text)) return 'send_estimate';
        if (/art|design|approve|mockup/.test(text)) return 'confirm_art';
        return 'follow_up_lead';
      };
      const extractNameFromEmail = emailStr => {
        if (!emailStr) return 'Unknown';
        const m = String(emailStr).match(/^([^<@]+?)(?:\s*<|@)/);
        return m ? m[1].trim().replace(/^"|"$/g, '') : String(emailStr).split('@')[0];
      };
      const threads = Object.entries(open)
        .filter(([, item]) => !item.doneAt && !tasksByThread.has(item.threadId || ''))
        .map(([threadId, item]) => ({
          threadId,
          subject: item.subject || item.title || '(no subject)',
          from: item.from || null,
          receivedAt: item.receivedAt || item.date || null,
          summary: item.summary || item.snippet || null,
          suggestedStage: guessSuggestedStage(item),
          contactName: item.contactName || extractNameFromEmail(item.from || ''),
        }))
        .sort((a, b) => new Date(b.receivedAt || 0) - new Date(a.receivedAt || 0))
        .slice(0, 30);
      return sendJson(res, { ok: true, threads, totalOpen: Object.keys(open).length });
    }

    // --- Mark email item done ---
    if (req.method === 'POST' && p === '/api/email/done') {
      const body = await collectBody(req);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return bad(res, 400, 'Invalid JSON'); }
      const threadId = String(payload.threadId || '').trim();
      const note = String(payload.note || '').trim();
      if (!threadId) return bad(res, 400, 'Missing threadId');

      const state = readJson(FILES.triageState, {});
      const item = state?.email?.open?.[threadId];
      if (!item) return bad(res, 404, 'Thread not found in open list');

      item.doneAt = new Date().toISOString();
      item.doneNote = note || null;
      item.doneBy = 'portal';
      state.lastUpdatedByPortal = item.doneAt;

      writeJson(FILES.triageState, state);
      return sendJson(res, { ok: true });
    }

    // --- Orders: create/update ---
    if (req.method === 'POST' && p === '/api/orders/upsert') {
      const body = await collectBody(req);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return bad(res, 400, 'Invalid JSON'); }

      const ordersState = readJson(FILES.orders, { lastUpdated: null, orders: [] });
      const o = payload.order || {};

      const now = new Date().toISOString();
      const id = String(o.id || '').trim() || `o_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      const existingIdx = ordersState.orders.findIndex(x => x.id === id);

      const cleaned = {
        id,
        customer: (o.customer || '').toString().trim(),
        jobName: (o.jobName || '').toString().trim(),
        stage: (o.stage || 'Paid').toString().trim(),
        dueDate: (o.dueDate || null),
        amount: (o.amount || null),
        nextAction: (o.nextAction || '').toString().trim(),
        links: Array.isArray(o.links) ? o.links.slice(0, 10) : [],
        updatedAt: now,
        createdAt: existingIdx >= 0 ? ordersState.orders[existingIdx].createdAt : now,
      };

      if (existingIdx >= 0) ordersState.orders[existingIdx] = { ...ordersState.orders[existingIdx], ...cleaned };
      else ordersState.orders.unshift(cleaned);

      ordersState.lastUpdated = now;
      writeJson(FILES.orders, ordersState);
      return sendJson(res, { ok: true, id });
    }

    if (req.method === 'POST' && p === '/api/orders/stage') {
      const body = await collectBody(req);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return bad(res, 400, 'Invalid JSON'); }
      const id = String(payload.id || '').trim();
      const stage = String(payload.stage || '').trim();
      if (!id || !stage) return bad(res, 400, 'Missing id/stage');

      const ordersState = readJson(FILES.orders, { lastUpdated: null, orders: [] });
      const idx = ordersState.orders.findIndex(x => x.id === id);
      if (idx < 0) return bad(res, 404, 'Order not found');
      ordersState.orders[idx].stage = stage;
      ordersState.orders[idx].updatedAt = new Date().toISOString();
      ordersState.lastUpdated = ordersState.orders[idx].updatedAt;
      writeJson(FILES.orders, ordersState);
      return sendJson(res, { ok: true });
    }

    // -- Task board ------------------------------------------------------
    if (req.method === 'GET' && p === '/api/tasks') {
      const now = Date.now();
      const statusFilter = u.searchParams.get('status') || 'active'; // active | cold | archived | all
      const all = readJsonl(FILES.tasksFile);
      const active = all
        .filter(t => !t.completedAt)
        .filter(t => {
          if (statusFilter === 'all') return true;
          const ls = t.leadStatus || 'active';
          return ls === statusFilter;
        })
        .filter(t => !t.snoozedUntil || new Date(t.snoozedUntil).getTime() <= now)
        .map(t => {
          const stage    = TASK_STAGES[t.stage] || {};
          const sla      = computeSla(t);
          const priority = computePriority(t);
          const score    = computePriorityScore(t, priority, sla);
          // Flag any post-payment stage task that has no paidAt -- data integrity warning.
          const paymentRequired = POST_PAYMENT_STAGES.has(t.stage) && !t.paidAt;
          const followUpDay = (() => {
            if (!['follow_up_estimate','follow_up_lead'].includes(t.stage)) return null;
            const waitDays = t.waitingSince ? (Date.now() - new Date(t.waitingSince).getTime()) / 86400000 : 0;
            return waitDays < 1.5 ? 1 : waitDays < 3.5 ? 3 : 7;
          })();
          const responseHours = t.stage === 'follow_up_lead' && !t.assignee
            ? Math.round((Date.now() - new Date(t.createdAt).getTime()) / 3600000)
            : null;
          return {
            ...t,
            priority:        paymentRequired ? 'normal' : priority,  // demote until fixed
            priorityScore:   paymentRequired ? 0 : score,
            blockedBy:       paymentRequired ? 'payment' : inferBlockedBy(t.stage),
            paymentRequired,
            taskLabel:       stage.label || t.stage,
            instructions:    stage.instructions || [],
            quickLinks:      stage.quickLinks || [],
            pipeline:        t.jobType === 'event' ? EVENT_PIPELINE : ORDER_PIPELINE,
            slaStatus:       paymentRequired ? 'none' : sla.status,
            slaText:         paymentRequired ? null : sla.text,
            suggestedActions: computeSuggestedActions(t, paymentRequired ? 'normal' : priority, sla),
            followUpDay,
            responseHours,
          };
        })
        .sort((a, b) => {
          const rank = { urgent: 0, attention: 1, normal: 2 };
          const diff = (rank[a.priority] ?? 3) - (rank[b.priority] ?? 3);
          if (diff !== 0) return diff;
          return b.priorityScore - a.priorityScore;
        });
      return sendJson(res, { ok: true, items: active, capturedAt: new Date().toISOString() });
    }

    if (req.method === 'GET' && p === '/api/tasks/history') {
      const limit = Math.min(200, Number(u.searchParams.get('limit') || 60));
      const all = readJsonl(FILES.tasksFile);
      const done = all
        .filter(t => t.completedAt)
        .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
        .slice(0, limit)
        .map(t => ({ ...t, taskLabel: TASK_STAGES[t.stage]?.label || t.stage }));
      return sendJson(res, { ok: true, items: done });
    }

    if (req.method === 'POST' && p === '/api/tasks/snooze') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, days = 1, reason } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');
      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');
      all[idx] = { ...all[idx], snoozedUntil: new Date(Date.now() + days * 86400000).toISOString(), snoozeReason: reason || null };
      writeJsonl(FILES.tasksFile, all);
      return sendJson(res, { ok: true });
    }

    // GHL sync -- called by Rosie on a schedule to auto-create/complete tasks from live data
    if (req.method === 'POST' && p === '/api/sync/ghl') {
      const token = ghlToken();
      if (!token?.access_token) return bad(res, 400, 'GHL token not configured');
      const locationId = token.locationId;
      const all = readJsonl(FILES.tasksFile);
      const now = new Date().toISOString();
      let created = 0, completed = 0;

      try {
        // Paid invoices → auto-complete follow_up_estimate, create order_blanks
        const invData = await ghlFetch(`/invoices/?altType=location&altId=${encodeURIComponent(locationId)}&offset=0&limit=100`);
        for (const inv of (invData?.invoices || [])) {
          if (inv.status !== 'paid') continue;
          const contactId   = inv?.contactDetails?.id || inv.contactId;
          const contactName = inv?.contactDetails?.name || inv.contactName || 'Unknown';
          const sourceId    = inv._id || inv.id;

          // Auto-complete any open follow_up or send_estimate tasks for this contact
          for (const t of all) {
            if (t.completedAt) continue;
            if (t.sourceContactId !== contactId) continue;
            if (!['follow_up_estimate','send_estimate','follow_up_lead'].includes(t.stage)) continue;
            t.completedAt    = now;
            t.completionNote = 'Auto-completed: invoice paid in GHL';
            completed++;
          }

          // Create order_blanks task if not already exists -- paidAt is required since invoice is paid
          // Check for any existing task with this sourceId at order_blanks (or later production stages)
          const exists = all.some(t => t.sourceId === sourceId && ['order_blanks','confirm_art','schedule_production','qc_pack','ship_deliver','confirm_event','order_event_supplies','event_production','pack_event_kit'].includes(t.stage));
          if (!exists) {
            const paidAt = inv.lastPaidAt || inv.paidAt || now;
            all.push({
              id: `t_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              jobId: `j_${sourceId}`, stage: 'order_blanks', jobType: 'order',
              contactName, jobName: inv.title || inv.name || contactName,
              amount: inv.totalAmount || null, dueDate: null, paidAt,
              waitingSince: now, createdAt: now,
              assignee: null, completedAt: null,
              notes: `Invoice #${inv.invoiceNumber || ''} paid -- $${inv.totalAmount || '?'}`,
              links: [], sourceId, sourceContactId: contactId, source: 'ghl_invoice',
            });
            created++;
          }
        }

        // New opportunities in "New Lead" stage → create follow_up_lead tasks
        const pipeData = await ghlFetch(`/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`);
        for (const pipe of (pipeData?.pipelines || [])) {
          const newStage = (pipe.stages || []).find(s => /new|lead|inquiry/i.test(s.name));
          if (!newStage) continue;
          const oppData = await ghlFetch(`/opportunities/search?location_id=${encodeURIComponent(locationId)}&pipeline_stage_id=${encodeURIComponent(newStage.id)}&limit=50`);
          for (const opp of (oppData?.opportunities || [])) {
            const contactId   = opp.contactId;
            const contactName = opp.contactName || opp?.contact?.name || 'Unknown';
            const sourceId    = opp.id;
            const exists = all.some(t => t.sourceId === sourceId);
            if (exists) continue;
            all.push({
              id: `t_${Date.now()}_${Math.random().toString(16).slice(2)}`,
              jobId: `j_${sourceId}`, stage: 'follow_up_lead', jobType: 'order',
              contactName, jobName: opp.name || contactName,
              amount: opp.monetaryValue || null, dueDate: null,
              waitingSince: opp.createdAt || now, createdAt: now,
              assignee: null, completedAt: null,
              notes: opp.source ? `Source: ${opp.source}` : null,
              links: [], sourceId, sourceContactId: contactId, source: 'ghl_opportunity',
            });
            created++;
          }
        }

        writeJsonl(FILES.tasksFile, all);
        const ps = readJson(FILES.portalState, {});
        ps.lastGhlSync = now;
        writeJson(FILES.portalState, ps);
        return sendJson(res, { ok: true, created, completed, capturedAt: now });
      } catch (e) {
        return bad(res, 500, 'GHL sync failed', { message: e.message });
      }
    }

    // -- Create GHL estimate (Rosie entry point) --------------------------
    // POST /api/estimates/create
    // Body: { contact:{name,email?,phone?,companyName?}, estimateName, eventDate?, eventCity?,
    //         venue?, apparel:{qty,style?,color?,blankCost?,decoration:[{method,location,colors?,width?,height?}]},
    //         staffing:{hoursPerDay,days,extraStaff?}, travel:"local"|"outside"|number }
    // decoration methods: screen | preprinted_screen | dtf | uvdtf | embroidery
    // travel: "local"=$0  "outside"=$900  or a number
    if (req.method === 'POST' && p === '/api/estimates/create') {
      const body = await collectBody(req);
      let d; try { d = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }

      const tok = ghlToken();
      if (!tok?.access_token) return bad(res, 400, 'GHL token not configured');
      const locId = tok.locationId;
      const API = 'https://services.leadconnectorhq.com';
      const headers = { Authorization: `Bearer ${tok.access_token}`, Version: '2021-07-28', 'Content-Type': 'application/json', Accept: 'application/json' };

      // -- Pricing helpers ------------------------------------------------
      const pMarkup = (cost, pct = 40) => +((cost * (1 + pct / 100)).toFixed(2));
      const pScreen = (qty, colors) => {
        const ranges = [
          [1001,Infinity,[0.84,1.26,1.68,2.10]],[701,1000,[1.09,1.51,1.93,2.27]],
          [501,700,[1.26,1.68,2.10,2.52]],[201,500,[1.68,2.10,2.52,2.94]],
          [101,200,[2.52,2.94,3.36,3.78]],[76,100,[3.36,3.78,4.20,4.62]],
          [51,75,[3.78,4.20,4.62,5.46]],[41,50,[4.62,5.46,6.30,7.14]],
          [31,40,[5.46,6.30,7.14,7.98]],[24,30,[5.88,6.72,7.56,8.40]],
        ];
        const idx = Math.min(Math.max(colors, 1), 4) - 1;
        for (const [lo, hi, rates] of ranges) if (qty >= lo && qty <= hi) return rates[idx];
        return null;
      };
      const pDtf   = (w, h) => +((w * h * 0.03) + 1.50).toFixed(4);
      const pUvdtf = (w, h) => +((w * h * 0.05) + 1.50).toFixed(4);
      const pEmb   = (qty) => qty >= 150 ? 15 : 20;

      // -- Contact: find or create ----------------------------------------
      const c = d.contact ?? {};
      if (!c.name) return bad(res, 400, 'contact requires at least a name');

      let contactId, contactName = c.name, contactEmail = c.email ?? '';
      try {
        // Search by email, then phone, then name -- first match wins
        const queries = [c.email, c.phone, c.name].filter(Boolean);
        for (const q of queries) {
          if (contactId) break;
          const sr = await fetch(`${API}/contacts/?locationId=${encodeURIComponent(locId)}&query=${encodeURIComponent(q)}`, { headers });
          const sj = await sr.json();
          const found = sj?.contacts?.[0];
          if (found) { contactId = found.id; contactName = found.name ?? c.name; contactEmail = found.email ?? c.email ?? ''; }
        }
        if (!contactId) {
          // Not found -- create if we have email or phone
          if (!c.email && !c.phone) return bad(res, 400, 'Contact not found in GHL by name. Provide email or phone to create.');
          const [firstName, ...rest] = c.name.split(' ');
          const cr = await fetch(`${API}/contacts/`, {
            method: 'POST', headers,
            body: JSON.stringify({ locationId: locId, firstName, lastName: rest.join(' '),
              ...(c.email ? { email: c.email } : {}), ...(c.phone ? { phone: c.phone } : {}),
              ...(c.companyName ? { companyName: c.companyName } : {}) }),
          });
          const cj = await cr.json();
          contactId = cj?.contact?.id ?? cj?.id;
          if (!contactId) return bad(res, 502, 'Failed to create GHL contact', cj);
        }
      } catch (e) { return bad(res, 502, 'GHL contact lookup failed', { message: e.message }); }

      // -- Apparel + decoration -------------------------------------------
      const app       = d.apparel ?? {};
      const qty       = app.qty;
      if (!qty) return bad(res, 400, 'apparel.qty required');
      const style     = app.style    ?? 'Premium T-shirt';
      const color     = app.color    ?? 'TBD';
      const blankCost = app.blankCost ?? 4.00;
      const decos     = app.decoration ?? [];

      let decoPerUnit = 0;
      const decoLabels = [];
      for (const deco of decos) {
        const m = (deco.method ?? '').toLowerCase();
        if (m === 'screen' || m === 'screen_print') {
          const r = pScreen(qty, deco.colors ?? 1);
          decoPerUnit += r; decoLabels.push(`<p><strong>${deco.location ?? 'Front'}:</strong> ${deco.colors ?? 1}-color screen print</p>`);
        } else if (m === 'preprinted_screen' || m === 'pre-printed') {
          const r = pScreen(qty, deco.colors ?? 1);
          decoPerUnit += r; decoLabels.push(`<p><strong>${deco.location ?? 'Left Chest'}:</strong> Pre-printed screen, ${deco.colors ?? 1} color</p>`);
        } else if (m === 'dtf') {
          const r = pDtf(deco.width ?? 12, deco.height ?? 14);
          decoPerUnit += r; decoLabels.push(`<p><strong>${deco.location ?? 'Back'}:</strong> Full-color DTF transfer</p>`);
        } else if (m === 'uvdtf') {
          const r = pUvdtf(deco.width ?? 12, deco.height ?? 14);
          decoPerUnit += r; decoLabels.push(`<p><strong>${deco.location ?? 'Back'}:</strong> UV DTF transfer</p>`);
        } else if (m === 'embroidery') {
          const r = pEmb(qty);
          decoPerUnit += r; decoLabels.push(`<p><strong>${deco.location ?? 'Left Chest'}:</strong> Embroidery</p>`);
        }
      }
      const apparelUnit  = +(pMarkup(blankCost) + decoPerUnit).toFixed(2);

      // -- Staffing -------------------------------------------------------
      const stf       = d.staffing ?? {};
      const hpd       = stf.hoursPerDay ?? 8;
      const days      = stf.days ?? 1;
      const extra     = stf.extraStaff ?? 0;
      const staffHrs  = (hpd + 2) * days;  // +1 setup +1 teardown per day
      const staffRate = 250 + (extra * 125);

      // -- Travel ---------------------------------------------------------
      const tv = d.travel ?? 'outside';
      const travelAmt = typeof tv === 'number' ? tv : tv === 'local' ? 0 : 900;

      const city  = d.eventCity ?? '';
      const date  = d.eventDate ?? '';
      const venue = d.venue     ?? '';

      // -- Line items -----------------------------------------------------
      const apparelDesc = [
        `<p><strong>Live Event Printing${city ? ` -- ${city}` : ''}${date ? ` -- ${date}` : ''}</strong></p>`,
        `<p><strong>Apparel:</strong> ${style} -- ${color} -- ${qty} pcs</p>`,
        ...decoLabels,
        venue ? `<p><strong>Venue:</strong> ${venue}</p>` : '',
      ].filter(Boolean).join('');

      const staffDesc = [
        '<p>Two-person Merch Troop team with full heat press equipment.</p>',
        `<p>Includes event production, setup, and teardown${date ? `. ${date}` : ''}${city ? `, ${city}` : ''}${venue ? ` -- ${venue}` : ''}.</p>`,
        extra > 0 ? `<p>${2 + extra} staff members on-site.</p>` : '',
      ].filter(Boolean).join('');

      const items = [
        { type:'one_time', name:`${style} + Print -- ${qty} pcs`, qty, amount: apparelUnit, currency:'USD', description: apparelDesc },
        { type:'one_time', name:`On-Site Staffing & Equipment${date ? ` -- ${date}` : ''}${city ? ` ${city}` : ''}`.slice(0,80), qty: staffHrs, amount: staffRate, currency:'USD', description: staffDesc },
        ...(travelAmt > 0 ? [{ type:'one_time', name:'Travel & Accommodations', qty:1, amount: travelAmt, currency:'USD',
          description: `<p>Travel and accommodations${city ? ` to ${city}` : ''} for on-site event production.</p>` }] : []),
      ];

      const total = +(apparelUnit * qty + staffRate * staffHrs + travelAmt).toFixed(2);

      // -- Estimate name (max 40 chars) -----------------------------------
      const rawName = (d.estimateName ?? `${c.name.split(' ').pop()} -- ${city} ${date}`).slice(0, 40);

      const businessDetails = {
        logoUrl: 'https://msgsndr-private.storage.googleapis.com/locationPhotos/f002192a-b20f-4bd7-8291-8d5863fb3428.png',
        name: 'Merch Troop',
        address: { addressLine1: '', city: 'La Habra', state: 'California', countryCode: 'US', postalCode: '90631' },
        phoneNo: '+1 5626144800', website: 'https://merchtroop.com/', customValues: [],
      };

      const issueDate  = new Date().toISOString().slice(0, 10);
      const expiryDate = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);

      const payload = {
        altType: 'location', altId: locId, liveMode: true, title: 'ESTIMATE', name: rawName,
        currency: 'USD', discount: { type: 'percentage', value: 0 }, issueDate, expiryDate,
        businessDetails,
        contactDetails: { id: contactId, name: contactName, email: contactEmail, address: { countryCode: 'US' } },
        frequencySettings: { enabled: false }, configuration: { precision: 4 },
        currencyOptions: { code: 'USD', symbol: '$' },
        items,
      };

      try {
        const er = await fetch(`${API}/invoices/estimate`, { method: 'POST', headers, body: JSON.stringify(payload) });
        const ej = await er.json();
        if (!er.ok) return bad(res, 502, 'GHL estimate creation failed', ej);
        const estimateNumber = ej?.estimateNumber ?? ej?.estimate?.estimateNumber ?? null;
        const estimateId     = ej?._id ?? ej?.id ?? ej?.estimate?.id ?? null;
        return sendJson(res, { ok: true, estimateNumber, estimateId, total, contactId, name: rawName });
      } catch (e) { return bad(res, 502, 'GHL estimate request failed', { message: e.message }); }
    }

    // -- Sync calendar events → schedule ---------------------------------
    if (req.method === 'POST' && p === '/api/sync/events') {
      try {
        const days = 60;
        const from = new Date();
        const to   = new Date(Date.now() + days * 86400000);
        const gogEnv = {
          HOME: process.env.HOME || '/var/lib/merchtroop-portal',
          XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/var/lib/merchtroop-portal/.config',
          GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || 'MerchTroopGogKeyring2026!',
        };
        const r = await runCmd('gog', [
          'calendar', 'events', 'primary',
          '--account', 'cole@merchtroop.com',
          '--from', from.toISOString().slice(0, 10),
          '--to',   to.toISOString().slice(0, 10),
          '--json', '--results-only', '--max', '200',
        ], { timeoutMs: 15000, env: gogEnv });
        if (r.code !== 0) return bad(res, 500, 'gog calendar failed', { stderr: r.stderr });

        let calEvents;
        try { calEvents = JSON.parse(r.stdout || '[]'); } catch { calEvents = []; }

        // Only process "Merch Troop -- Contact -- Invoice XXXXXX" events
        const merchEvents = calEvents.filter(e => {
          const t = (e.summary || e.title || '').toLowerCase();
          return t.includes('merch troop') && t.includes('invoice');
        });

        const store = readEvents();
        const existingIds = new Set(store.events.map(e => e.id));
        // Also deduplicate by date+invoice to avoid calendar duplicates
        const existingKeys = new Set(store.events.map(e => {
          const inv = (e.notes || '').match(/Invoice #?(\d+)/i)?.[1];
          return `${e.date}::${inv || e.contactName?.slice(0, 20)}`;
        }));
        let added = 0;

        for (const ev of merchEvents) {
          const calId = `cal_${ev.id}`;
          if (existingIds.has(calId)) continue;

          const title  = ev.summary || ev.title || '';
          // Parse "Merch Troop -- Contact Name -- Invoice 002712 -- City" style titles
          const parts  = title.split(/\s*[--\-–]\s*/);
          // Strip leading "Merch Troop" part, use next segment as contact name
          const contactName = (parts[0]?.trim().toLowerCase() === 'merch troop' ? parts[1] : parts[0])?.trim() || title;
          const invoiceMatch = title.match(/invoice\s+(\d+)/i);
          const invoiceRef = invoiceMatch ? invoiceMatch[1] : null;

          const startDt = ev.start?.dateTime || ev.start?.date || null;
          const endDt   = ev.end?.dateTime   || ev.end?.date   || null;
          const date    = startDt ? startDt.slice(0, 10) : null;
          if (!date) continue;
          const dedupKey = `${date}::${invoiceRef || contactName.slice(0, 20)}`;
          if (existingKeys.has(dedupKey)) continue;

          const toTime = dt => dt && dt.length > 10
            ? new Date(dt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'America/Los_Angeles' })
            : '09:00';

          const newEv = {
            id: calId,
            source: 'calendar_materialized',
            invoiceId: null,
            contactName,
            eventName: title,
            date,
            startTime: toTime(startDt),
            endTime:   toTime(endDt),
            location:  ev.location || '',
            address:   ev.location || '',
            eventType: 'Live event',
            staffNeeded: parseStaffCount(ev.description || '') || 2,
            amount: null,
            notes: invoiceRef ? `Invoice #${invoiceRef}\nCalendar Source: INVOICE_PARSE\n${ev.description || ''}`.trim() : (ev.description || null),
            htmlLink: ev.htmlLink || null,
            claims: [],
            createdAt: new Date().toISOString(),
          };
          store.events.push(newEv);
          existingIds.add(calId);
          existingKeys.add(dedupKey);
          added++;
        }

        writeEvents(store);
        return sendJson(res, { ok: true, added, total: store.events.length, capturedAt: new Date().toISOString() });
      } catch (e) {
        return bad(res, 500, 'Event sync failed', { message: e.message });
      }
    }

    // -- Event schedule ---------------------------------------------------
    if (req.method === 'GET' && p === '/api/schedule') {
      const store = readEvents();
      const now   = new Date().toISOString();
      const items = store.events
        .filter(e => !e.cancelled)
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(e => ({
          ...e,
          spotsLeft:  Math.max(0, e.staffNeeded - (e.claims || []).length),
          spotsFilled: (e.claims || []).length,
          isFull:     (e.claims || []).length >= e.staffNeeded,
          isPast:     e.date < now.slice(0, 10),
        }));
      return sendJson(res, { ok: true, items, capturedAt: now });
    }

    if (req.method === 'POST' && p === '/api/schedule/claim') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { eventId, name, email } = payload;
      if (!eventId || !name?.trim() || !email?.trim()) return bad(res, 400, 'Missing eventId, name, or email');

      const store = readEvents();
      const ev    = store.events.find(e => e.id === eventId);
      if (!ev) return bad(res, 404, 'Event not found');
      if (ev.claims.length >= ev.staffNeeded) return bad(res, 409, 'Event is fully staffed');
      if (ev.claims.some(c => c.email.toLowerCase() === email.toLowerCase()))
        return bad(res, 409, 'This email has already claimed a spot');

      const claim = { name: name.trim(), email: email.trim().toLowerCase(), claimedAt: new Date().toISOString(), inviteSent: false, rsvpStatus: 'pending' };
      ev.claims.push(claim);
      writeEvents(store);

      // Attempt calendar invite (works on Rosie's machine with gog)
      const inviteResult = await sendCalendarInvite(ev, claim);
      if (inviteResult.ok) {
        claim.inviteSent = true;
        if (inviteResult.googleCalEventId) claim.googleCalEventId = inviteResult.googleCalEventId;
        writeEvents(store);
      }

      // Auto-draft confirmation email to the staff member
      const fmt12Claim = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM'); };
      const confirmationEmail = {
        to: claim.email,
        subject: `Event Booking Confirmed: ${ev.eventName || ev.contactName} -- ${ev.date}`,
        body: [
          `Hi ${claim.name.split(' ')[0]},`,
          '',
          `You're confirmed for the following Merch Troop event:`,
          '',
          `Event: ${ev.eventName || ev.contactName}`,
          `Date: ${new Date(ev.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
          `Time: ${fmt12Claim(ev.startTime)} - ${fmt12Claim(ev.endTime)}`,
          ev.address || ev.location ? `Location: ${ev.address || ev.location}` : null,
          '',
          `What to bring:`,
          `- Black Merch Troop crew shirt`,
          `- Comfortable closed-toe shoes`,
          `- Phone charger / portable battery`,
          `- Water bottle`,
          '',
          ev.notes ? `Event notes: ${ev.notes}` : null,
          '',
          `Arrive 1 hour before event start for setup.`,
          `If you need to cancel, please unclaim in the portal ASAP so we can fill the spot.`,
          '',
          `- Merch Troop`,
        ].filter(l => l !== null).join('\n'),
        createdAt: new Date().toISOString(),
      };

      // Save confirmation draft to memory for pickup by email sender
      const confirmDraftPath = path.join(MEMORY_DIR, 'portal-event-confirmations.jsonl');
      appendJsonl(confirmDraftPath, { ...confirmationEmail, eventId: ev.id, claimName: claim.name });

      return sendJson(res, { ok: true, claim, inviteSent: inviteResult.ok, confirmationDrafted: true, spotsLeft: Math.max(0, ev.staffNeeded - ev.claims.length) });
    }

    if (req.method === 'POST' && p === '/api/schedule/unclaim') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { eventId, email, reason } = payload;
      if (!eventId || !email) return bad(res, 400, 'Missing eventId/email');
      if (typeof reason !== 'string' || !reason.trim()) return bad(res, 400, 'A reason is required to unclaim an event spot');
      if (reason.length > 1000) return bad(res, 400, 'Reason is too long (max 1000 chars)');
      const store = readEvents();
      const ev    = store.events.find(e => e.id === eventId);
      if (!ev) return bad(res, 404, 'Event not found');
      if (!Array.isArray(ev.claims)) ev.claims = [];
      const claim = ev.claims.find(c => c.email && c.email.toLowerCase() === email.toLowerCase());
      if (!claim) return bad(res, 404, 'Claim not found');
      // Log the unclaim with reason before removing
      if (!ev.unclaimLog) ev.unclaimLog = [];
      ev.unclaimLog.push({
        name: claim.name,
        email: claim.email,
        reason: reason.trim(),
        unclaimedAt: new Date().toISOString(),
        unclaimedBy: req._session?.name || claim.name,
      });
      ev.claims = ev.claims.filter(c => c.email.toLowerCase() !== email.toLowerCase());
      writeEvents(store);

      // Notify via Slack about the unclaim (best-effort; never fails the unclaim)
      const slackMsg = `:warning: *Staff unclaim*: ${claim.name} dropped out of *${ev.eventName || ev.contactName}* (${ev.date})\n> Reason: ${reason.trim()}`;
      try { await slackPost(SLACK_OPS_CHANNEL, slackMsg); }
      catch (e) { console.error('[unclaim] Slack notify failed:', e.message); }

      return sendJson(res, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/schedule/add') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { contactName, eventName, date, startTime, endTime, location, address, eventType, staffNeeded, notes, amount } = payload;
      if (!contactName || !date) return bad(res, 400, 'Missing contactName/date');

      // Validate date format
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return bad(res, 400, 'Invalid date format (expected YYYY-MM-DD)');
      const dateObj = new Date(date + 'T12:00:00');
      if (isNaN(dateObj.getTime())) return bad(res, 400, 'Invalid date');

      // Validate time formats if provided
      const timeRe = /^\d{2}:\d{2}$/;
      if (startTime && !timeRe.test(startTime)) return bad(res, 400, 'Invalid startTime format (expected HH:MM)');
      if (endTime && !timeRe.test(endTime)) return bad(res, 400, 'Invalid endTime format (expected HH:MM)');
      if (startTime && endTime && startTime >= endTime) return bad(res, 400, 'startTime must be before endTime');

      // Validate staff count
      const parsedStaff = parseInt(staffNeeded) || parseStaffCount(notes);
      if (parsedStaff < 1 || parsedStaff > 50) return bad(res, 400, 'staffNeeded must be between 1 and 50');

      const store = readEvents();
      const ev = {
        id: `ev_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        source: 'manual', invoiceId: null,
        contactName: contactName.trim(), eventName: (eventName || contactName).trim(), date,
        startTime: startTime || '09:00', endTime: endTime || '17:00',
        location: location || '', address: address || '',
        eventType: eventType || 'Live event',
        staffNeeded: Math.max(1, parsedStaff),
        amount: amount || null, notes: notes || null,
        claims: [], createdAt: new Date().toISOString(),
      };
      store.events.push(ev);
      writeEvents(store);
      return sendJson(res, { ok: true, event: ev });
    }

    // -- Staff availability overview -------------------------------------
    if (req.method === 'GET' && p === '/api/schedule/staff-overview') {
      try {
        const store = readEvents();
        const allEvents = Array.isArray(store?.events) ? store.events : [];
        const todayStr = new Date().toISOString().slice(0, 10);
        const upcoming = allEvents
          .filter(e => e && !e.cancelled && typeof e.date === 'string' && e.date >= todayStr)
          .sort((a, b) => a.date.localeCompare(b.date));

        // Build a map of staff member -> their bookings
        const staffMap = {};
        for (const ev of upcoming) {
          const claims = Array.isArray(ev.claims) ? ev.claims : [];
          for (const claim of claims) {
            if (!claim?.email) continue;
            const key = String(claim.email).toLowerCase();
            if (!staffMap[key]) staffMap[key] = { name: claim.name || 'Unknown', email: claim.email, events: [] };
            staffMap[key].events.push({
              eventId: ev.id,
              eventName: ev.eventName || ev.contactName || 'Untitled event',
              date: ev.date,
              startTime: ev.startTime || null,
              endTime: ev.endTime || null,
              location: ev.address || ev.location || '',
              rsvpStatus: claim.rsvpStatus || 'pending',
            });
          }
        }

        // Events with open spots
        const eventsNeedingStaff = upcoming
          .filter(e => {
            const needed = Number(e.staffNeeded) || 0;
            const filled = (Array.isArray(e.claims) ? e.claims : []).length;
            return needed > 0 && filled < needed;
          })
          .map(e => {
            const needed = Number(e.staffNeeded) || 0;
            const filled = (Array.isArray(e.claims) ? e.claims : []).length;
            return {
              eventId: e.id,
              eventName: e.eventName || e.contactName || 'Untitled event',
              date: e.date,
              startTime: e.startTime || null,
              endTime: e.endTime || null,
              location: e.address || e.location || '',
              staffNeeded: needed,
              staffFilled: filled,
              spotsOpen: needed - filled,
            };
          });

        // Known staff from the users file with role 'onsite'
        const users = readJson(FILES.usersFile, { users: [] }).users || [];
        const onsiteUsers = users.filter(u => u && u.role === 'onsite').map(u => u.name).filter(Boolean);

        return sendJson(res, {
          ok: true,
          bookedStaff: Object.values(staffMap),
          eventsNeedingStaff,
          knownOnsiteStaff: onsiteUsers,
          capturedAt: new Date().toISOString(),
        });
      } catch (e) {
        console.error('[staff-overview] Error:', e.message);
        return bad(res, 500, 'Failed to build staff overview', { message: e.message });
      }
    }

    // Called by GHL sync when a paid event invoice is found
    if (req.method === 'POST' && p === '/api/schedule/from-invoice') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { invoiceId, contactName, eventName, date, startTime, endTime, location, address, eventType, notes, amount } = payload;
      if (!invoiceId || !contactName || !date) return bad(res, 400, 'Missing invoiceId/contactName/date');
      const store = readEvents();
      if (store.events.some(e => e.invoiceId === invoiceId)) return sendJson(res, { ok: true, skipped: true });
      const ev = {
        id: `ev_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        source: 'ghl_invoice', invoiceId, contactName,
        eventName: eventName || contactName, date,
        startTime: startTime || '09:00', endTime: endTime || '17:00',
        location: location || '', address: address || '',
        eventType: eventType || 'Live event',
        staffNeeded: parseStaffCount(notes),
        amount: amount || null, notes: notes || null,
        claims: [], createdAt: new Date().toISOString(),
      };
      store.events.push(ev);
      writeEvents(store);
      return sendJson(res, { ok: true, event: ev });
    }

    // -- Sync RSVP statuses from Google Calendar -----------------------------
    // For each claim that has a googleCalEventId, fetches the event from gog and
    // updates rsvpStatus to 'accepted' | 'declined' | 'tentative' | 'pending'.
    // Also adds new claims for attendees who accepted but claimed outside the portal.
    if (req.method === 'POST' && p === '/api/schedule/sync-rsvp') {
      const store = readEvents();
      const gogEnv = {
        HOME: process.env.HOME || '/var/lib/merchtroop-portal',
        XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || '/var/lib/merchtroop-portal/.config',
        GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || 'MerchTroopGogKeyring2026!',
      };

      let updated = 0;
      const errors = [];

      for (const ev of store.events) {
        if (!Array.isArray(ev.claims)) continue;
        for (const claim of ev.claims) {
          if (!claim.googleCalEventId) continue;
          try {
            const r = await runCmd('gog', [
              'calendar', 'events', 'get', claim.googleCalEventId,
              '--account', 'cole@merchtroop.com',
              '--json',
            ], { timeoutMs: 10000, env: gogEnv });
            if (r.code !== 0) { errors.push({ id: claim.googleCalEventId, err: r.stderr }); continue; }
            let calEvent;
            try { calEvent = JSON.parse(r.stdout || '{}'); } catch { continue; }

            // Find this attendee's RSVP in the event response
            const attendees = calEvent.attendees || [];
            const match = attendees.find(a =>
              a.email?.toLowerCase() === claim.email?.toLowerCase()
            );
            if (match) {
              const newStatus = match.responseStatus || 'pending'; // 'accepted'|'declined'|'tentative'|'needsAction'
              const mapped = newStatus === 'accepted' ? 'accepted'
                : newStatus === 'declined'  ? 'declined'
                : newStatus === 'tentative' ? 'tentative'
                : 'pending';
              if (claim.rsvpStatus !== mapped) {
                claim.rsvpStatus = mapped;
                updated++;
              }
            }
          } catch (e) { errors.push({ id: claim.googleCalEventId, err: e.message }); }
        }
      }

      writeEvents(store);
      return sendJson(res, { ok: true, updated, errors: errors.length ? errors : undefined, capturedAt: new Date().toISOString() });
    }

    // Email-to-task hook -- called by Rosie when she detects an estimate request or adjustment
    if (req.method === 'POST' && p === '/api/tasks/from-email') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { contactName, emailSubject, emailSummary, stage, jobType, amount, dueDate, threadId } = payload;
      if (!contactName || !stage) return bad(res, 400, 'Missing contactName/stage');
      // Deduplicate by email thread
      if (threadId) {
        const all = readJsonl(FILES.tasksFile);
        if (all.some(t => t.sourceId === threadId && !t.completedAt)) {
          return sendJson(res, { ok: true, skipped: true, reason: 'Task already exists for this thread' });
        }
      }
      const task = {
        id: `t_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        jobId: `j_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        stage, jobType: jobType || 'order', contactName,
        jobName: emailSubject || contactName,
        amount: amount || null, dueDate: dueDate || null,
        waitingSince: new Date().toISOString(), createdAt: new Date().toISOString(),
        assignee: null, completedAt: null,
        notes: emailSummary || null, links: [],
        sourceId: threadId || null, source: 'email',
      };
      appendJsonl(FILES.tasksFile, task);
      return sendJson(res, { ok: true, task });
    }

    if (req.method === 'POST' && p === '/api/tasks/accept') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, assignee } = payload;
      if (!taskId || !assignee) return bad(res, 400, 'Missing taskId/assignee');
      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');
      all[idx] = { ...all[idx], assignee, acceptedAt: new Date().toISOString(), claimedBy: req._session?.name || assignee };
      writeJsonl(FILES.tasksFile, all);
      return sendJson(res, { ok: true, task: all[idx] });
    }

    if (req.method === 'POST' && p === '/api/tasks/unclaim') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');
      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');
      all[idx] = { ...all[idx], assignee: null, acceptedAt: null };
      writeJsonl(FILES.tasksFile, all);
      return sendJson(res, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/tasks/complete') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, note } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');
      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');
      const task = all[idx];
      all[idx] = { ...task, completedAt: new Date().toISOString(), completionNote: note || null, completedBy: req._session?.name || null };
      let nextTask = null;
      const nextStage = TASK_STAGES[task.stage]?.next;
      // Payment gate: never auto-create a post-payment stage without confirmed paidAt.
      const nextNeedsPayment = nextStage && POST_PAYMENT_STAGES.has(nextStage);
      if (nextStage && (!nextNeedsPayment || task.paidAt)) {
        nextTask = {
          id: `t_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          jobId: task.jobId, stage: nextStage, jobType: task.jobType,
          contactName: task.contactName, jobName: task.jobName,
          amount: task.amount, dueDate: task.dueDate, paidAt: task.paidAt || null,
          waitingSince: new Date().toISOString(), createdAt: new Date().toISOString(),
          assignee: null, completedAt: null, notes: task.notes || null, links: task.links || [],
        };
        all.push(nextTask);
      }
      writeJsonl(FILES.tasksFile, all);

      // Cascade: if task is LOST or has cancel keywords, cancel linked events
      const completedTask = all[idx];
      const eventsCancelled = cascadeTaskToEvents(completedTask, 'completed');

      if (task.sourceContactId) {
        try {
          const by = req._session?.name || 'Portal';
          await ghlPost(`/contacts/${task.sourceContactId}/notes`, { body: `[Portal] Task completed: ${TASK_STAGES[task.stage]?.label || task.stage}${note ? ' -- ' + note : ''} (by ${by})` });
        } catch (e) {
          console.error(`[task-complete] Failed to add GHL note for contact ${task.sourceContactId}:`, e.message);
        }
      }
      const needsPayment = nextNeedsPayment && !task.paidAt;
      return sendJson(res, { ok: true, nextTask, needsPayment, nextStage: needsPayment ? nextStage : undefined, eventsCancelled });
    }

    // Mark a task as paid and advance to the first post-payment stage.
    // Requires the current task to be at follow_up_estimate (or follow_up_lead/send_estimate).
    if (req.method === 'POST' && p === '/api/tasks/mark-paid') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, invoiceRef } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');

      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');

      const task = all[idx];
      const paidAt = new Date().toISOString();
      all[idx] = { ...task, paidAt, invoiceRef: invoiceRef || null, completedAt: paidAt, completionNote: `Payment confirmed${invoiceRef ? ' -- ' + invoiceRef : ''}` };

      // Determine the first post-payment stage for this job type.
      const pipeline = task.jobType === 'event' ? EVENT_PIPELINE : ORDER_PIPELINE;
      const payGateIdx = pipeline.indexOf('follow_up_estimate');
      const firstPostPayment = payGateIdx >= 0 ? pipeline[payGateIdx + 1] : null;

      let nextTask = null;
      if (firstPostPayment) {
        nextTask = {
          id: `t_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          jobId: task.jobId, stage: firstPostPayment, jobType: task.jobType,
          contactName: task.contactName, jobName: task.jobName,
          amount: task.amount, dueDate: task.dueDate, paidAt,
          waitingSince: paidAt, createdAt: paidAt,
          assignee: null, completedAt: null, notes: task.notes || null, links: task.links || [],
        };
        all.push(nextTask);
      }

      writeJsonl(FILES.tasksFile, all);
      return sendJson(res, { ok: true, paidAt, nextTask });
    }

    if (req.method === 'POST' && p === '/api/tasks/create') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { stage, jobType, contactName, jobName, amount, dueDate, notes } = payload;
      if (!stage || !contactName) return bad(res, 400, 'Missing stage/contactName');
      if (!TASK_STAGES[stage]) return bad(res, 400, `Invalid stage: ${stage}`);
      if (contactName.trim().length < 2) return bad(res, 400, 'Contact name too short');

      // Duplicate prevention: check for an active task with same contact + stage
      const existing = readJsonl(FILES.tasksFile);
      const duplicate = existing.find(t =>
        !t.completedAt &&
        t.stage === stage &&
        t.contactName.toLowerCase() === contactName.trim().toLowerCase() &&
        (t.leadStatus || 'active') === 'active'
      );
      if (duplicate) {
        return bad(res, 409, `Duplicate: ${contactName} already has an active "${TASK_STAGES[stage]?.label || stage}" task`, { existingTaskId: duplicate.id });
      }

      // Validate dueDate format if provided
      if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        return bad(res, 400, 'Invalid dueDate format (expected YYYY-MM-DD)');
      }

      const task = {
        id: `t_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        jobId: `j_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        stage, jobType: jobType || 'order', contactName: contactName.trim(),
        jobName: (jobName || contactName).trim(), amount: amount || null, dueDate: dueDate || null,
        waitingSince: new Date().toISOString(), createdAt: new Date().toISOString(),
        assignee: null, completedAt: null, notes: notes || null, links: [],
      };
      appendJsonl(FILES.tasksFile, task);
      return sendJson(res, { ok: true, task });
    }

    // -- VA Inbox: list drafts --------------------------------------------
    if (req.method === 'GET' && p === '/api/va/drafts') {
      try {
        const draftsDir = FILES.draftsDir;
        fs.mkdirSync(draftsDir, { recursive: true });
        const files = fs.readdirSync(draftsDir).filter(f => f.endsWith('.md'));
        const drafts = [];
        for (const filename of files) {
          const filePath = path.join(draftsDir, filename);
          let stat;
          try { stat = fs.statSync(filePath); } catch { continue; }
          const text = readText(filePath, '');
          const lines = text.split(/\r?\n/);

          // Determine type from filename
          const type = filename.startsWith('estimate-') ? 'estimate' : filename.startsWith('reply-') ? 'reply' : 'reply';

          // Parse title line: # Estimate Draft -- NAME  or  # Reply Draft -- NAME
          let clientName = filename;
          const titleLine = lines.find(l => l.startsWith('#'));
          if (titleLine) {
            const m = titleLine.match(/^#\s+.+?--\s*(.+)$/);
            if (m) clientName = m[1].trim();
          }

          // Parse **Type:** line
          let estimateType = null;
          const typeLine = lines.find(l => /^\*\*Type:\*\*/.test(l));
          if (typeLine) {
            const m = typeLine.match(/^\*\*Type:\*\*\s*(.+)$/);
            if (m) estimateType = m[1].trim();
          }

          // Parse **Date:** line
          let date = null;
          const dateLine = lines.find(l => /^\*\*Date:\*\*/.test(l));
          if (dateLine) {
            const m = dateLine.match(/^\*\*Date:\*\*\s*(.+)$/);
            if (m) date = m[1].trim();
          }

          // Parse **Total: $X,XXX.XX** line
          let total = null;
          const totalLine = lines.find(l => /\*\*Total:/.test(l));
          if (totalLine) {
            const m = totalLine.match(/\*\*Total:\s*\$([0-9,]+(?:\.[0-9]{1,2})?)\*\*/);
            if (m) total = parseFloat(m[1].replace(/,/g, ''));
          }

          // Parse **Contact:** line
          let contact = null;
          const contactLine = lines.find(l => /^\*\*Contact:\*\*/.test(l));
          if (contactLine) {
            const m = contactLine.match(/^\*\*Contact:\*\*\s*(.+)$/);
            if (m) contact = m[1].trim();
          }

          // Collect flags: lines starting with - ⚠️ or > ⚠️
          const flags = lines
            .filter(l => /^[->`*]\s*⚠/.test(l))
            .map(l => l.replace(/^[->`*]\s*⚠️?\s*/, '').trim())
            .filter(Boolean);

          // Urgent if date is within 14 days or any flag mentions urgency
          const dateStr = date || '';
          const urgentByDate = (() => {
            const m = dateStr.match(/([A-Z][a-z]+ \d{1,2},?\s*\d{4})/);
            if (!m) return false;
            const d = new Date(m[1]);
            return !isNaN(d) && (d - Date.now()) < 14 * 24 * 60 * 60 * 1000;
          })();
          const urgent = urgentByDate || flags.some(f => /urgent/i.test(f));

          drafts.push({
            id: filename,
            filename,
            type,
            clientName,
            estimateType,
            date,
            total,
            contact,
            flags,
            urgent,
            createdAt: stat.mtime.toISOString(),
          });
        }

        // Sort: urgent first, then by createdAt desc
        drafts.sort((a, b) => {
          if (a.urgent && !b.urgent) return -1;
          if (!a.urgent && b.urgent) return 1;
          return new Date(b.createdAt) - new Date(a.createdAt);
        });

        return sendJson(res, { drafts });
      } catch (e) {
        return bad(res, 500, 'Failed to load drafts', { message: e.message });
      }
    }

    // -- VA Inbox: complete / move draft ---------------------------------
    if (req.method === 'POST' && p === '/api/va/drafts/complete') {
      const body = await collectBody(req);
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return bad(res, 400, 'Invalid JSON'); }
      const filename = String(payload.filename || '').trim();
      if (!filename) return bad(res, 400, 'Missing filename');
      // Prevent path traversal
      if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return bad(res, 400, 'Invalid filename');
      }
      const src = path.join(FILES.draftsDir, filename);
      if (!fs.existsSync(src)) return bad(res, 404, 'Draft not found');
      const sentDir = path.join(FILES.draftsDir, 'sent');
      fs.mkdirSync(sentDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const dest = path.join(sentDir, ts + '-' + filename);
      fs.renameSync(src, dest);
      return sendJson(res, { ok: true });
    }

    // --- Portal state ---
    if (req.method === 'GET' && p === '/api/portal-state') {
      return sendJson(res, readJson(FILES.portalState, { lastGhlSync: null }));
    }

    // --- Flag task for Cole → save + Slack ---
    if (req.method === 'POST' && p === '/api/tasks/flag') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, note } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');
      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');
      const task = all[idx];
      const flaggedBy = req._session?.name || 'Portal';
      all[idx] = { ...task, flaggedAt: new Date().toISOString(), flaggedBy, flagNote: note || null };
      writeJsonl(FILES.tasksFile, all);

      // Send Slack message to merch-troop-ops
      const contact = task.contactName || 'Unknown';
      const stage   = task.taskLabel || task.stage;
      const rev     = task.amount ? ` · $${Number(task.amount).toLocaleString()}` : '';
      const sla     = task.slaText ? ` · ${task.slaText}` : '';
      const noteStr = note ? `\n> ${note}` : '';
      const slackText = `:rotating_light: *${flaggedBy} flagged a task for Cole*\n*${contact}* -- ${stage}${rev}${sla}${noteStr}`;
      await slackPost(SLACK_OPS_CHANNEL, slackText);

      const task2 = all.find(t => t.id === taskId);
      if (task2?.sourceContactId) {
        try {
          await ghlPost(`/contacts/${task2.sourceContactId}/notes`, { body: `[Portal] Flagged for Cole by ${flaggedBy}${note ? ': ' + note : ''}` });
        } catch (e) {
          console.error(`[task-flag] Failed to add GHL note for contact ${task2.sourceContactId}:`, e.message);
        }
      }

      return sendJson(res, { ok: true });
    }

    // --- Set lead status (active / cold / archived) ---
    if (req.method === 'POST' && p === '/api/tasks/set-status') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, status } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');
      if (!['active', 'cold', 'archived'].includes(status)) return bad(res, 400, 'status must be active|cold|archived');
      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');
      all[idx] = { ...all[idx], leadStatus: status, leadStatusAt: new Date().toISOString(), leadStatusBy: req._session?.name || null };
      writeJsonl(FILES.tasksFile, all);

      // Cascade: cold or archived tasks should cancel linked events
      let eventsCancelled = 0;
      if (status === 'cold' || status === 'archived') {
        eventsCancelled = cascadeTaskToEvents(all[idx], status);
      }

      return sendJson(res, { ok: true, status, eventsCancelled });
    }

    // --- Manual auto-scrub trigger ---
    if (req.method === 'POST' && p === '/api/tasks/scrub') {
      try {
        const result = await runAutoScrub();
        return sendJson(res, { ok: true, ...result });
      } catch (e) {
        return bad(res, 500, 'Auto-scrub failed', { message: e.message });
      }
    }

    // --- Scrub history log ---
    if (req.method === 'GET' && p === '/api/tasks/scrub-log') {
      const limit = Math.min(50, Math.max(1, Number(u.searchParams.get('limit') || 20)));
      const log = readJsonl(FILES.scrubLogFile);
      const recent = log.slice(-limit).reverse();
      return sendJson(res, { ok: true, entries: recent, total: log.length });
    }

    // --- Task edit (notes, dueDate, amount) ---
    if (req.method === 'POST' && p === '/api/tasks/edit') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');
      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');
      const updates = { updatedAt: new Date().toISOString() };
      if ('notes'   in payload) updates.notes   = payload.notes || null;
      if ('dueDate' in payload) updates.dueDate = payload.dueDate || null;
      if ('amount'  in payload) updates.amount  = payload.amount != null ? (Number(payload.amount) || null) : null;
      all[idx] = { ...all[idx], ...updates };
      writeJsonl(FILES.tasksFile, all);
      return sendJson(res, { ok: true, task: all[idx] });
    }

    // AI: Draft email for a task
    if (req.method === 'POST' && p === '/api/ai/draft-email') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, followUpDay, intent } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');

      const all = readJsonl(FILES.tasksFile);
      const task = all.find(t => t.id === taskId);
      if (!task) return bad(res, 404, 'Task not found');

      const stage = TASK_STAGES[task.stage] || {};
      const contact = task.contactName || 'Customer';
      const jobName = task.jobName || task.contactName;
      const amount = task.amount ? `$${Number(task.amount).toLocaleString()}` : null;
      const dueDate = task.dueDate ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : null;

      // Build contextual draft based on stage
      let smsText = '';
      let emailSubject = '';
      let emailBody = '';

      if (task.stage === 'follow_up_lead') {
        smsText = `Hi ${contact.split(' ')[0]}! This is Cole from Merch Troop. I saw your inquiry about custom apparel -- happy to help! What quantities and styles are you thinking? I can have a quote to you same day.`;
        emailSubject = `Quick follow-up -- Merch Troop custom apparel`;
        emailBody = `Hi ${contact.split(' ')[0]},\n\nI wanted to reach out about your interest in custom apparel with Merch Troop. We specialize in screen printing, DTF, embroidery, and live event printing.\n\nTo get you a same-day quote, I just need:\n• Quantity (approximate is fine)\n• Item type (tees, hoodies, hats, etc.)\n• Decoration type if known\n• Any deadline or event date\n\nLooking forward to working with you!\n\nCole\nMerch Troop`;
      } else if (task.stage === 'follow_up_estimate') {
        const day = followUpDay || 1;
        if (day <= 1) {
          smsText = `Hi ${contact.split(' ')[0]}, just wanted to make sure you received the estimate from Merch Troop${amount ? ' for ' + amount : ''}. Happy to walk through it or make any changes!`;
          emailSubject = `Your Merch Troop estimate${amount ? ' -- ' + amount : ''}`;
          emailBody = `Hi ${contact.split(' ')[0]},\n\nJust checking in to make sure the estimate came through okay${amount ? ' (' + amount + ')' : ''}. I'm happy to hop on a quick call to walk through it or adjust anything.\n\nLet me know if you have any questions!\n\nCole\nMerch Troop`;
        } else if (day <= 3) {
          smsText = `Hey ${contact.split(' ')[0]}, following up on the Merch Troop estimate. Any questions or changes needed? I want to make sure we can lock in your timeline.`;
          emailSubject = `Following up on your Merch Troop estimate`;
          emailBody = `Hi ${contact.split(' ')[0]},\n\nJust following up on the estimate I sent over. If you have any questions, need revisions, or want to discuss options, just say the word -- I'm easy to reach.\n\n${dueDate ? 'With your date of ' + dueDate + ' in mind, ' : ''}I want to make sure we can lock in production time for you.\n\nCole\nMerch Troop`;
        } else {
          smsText = `Hi ${contact.split(' ')[0]}, last follow-up on the Merch Troop estimate. If timing has changed or you want to revisit, I'm here. Otherwise I'll archive this one -- just reply if you'd like to move forward!`;
          emailSubject = `Last follow-up -- Merch Troop estimate`;
          emailBody = `Hi ${contact.split(' ')[0]},\n\nThis is my last follow-up on the estimate I sent over. If the timing has changed or this project is on hold, no worries at all -- just let me know and I'll archive it.\n\nIf you'd like to move forward or revisit, just reply and I'll pick it right back up.\n\nCole\nMerch Troop`;
        }
      } else if (task.stage === 'confirm_art') {
        smsText = `Hi ${contact.split(' ')[0]}! Just checking in on the art approval for your Merch Troop order${jobName !== contact ? ' (' + jobName + ')' : ''}. As soon as you give the thumbs up, we can get into production!`;
        emailSubject = `Art approval needed -- ${jobName}`;
        emailBody = `Hi ${contact.split(' ')[0]},\n\nJust a quick note -- we're ready to go into production on your order${amount ? ' (' + amount + ')' : ''} as soon as we get art approval from you.\n\nPlease reply with:\n• ✓ Approved as-is, OR\n• Any changes needed\n\nThe sooner we get approval, the sooner we can lock in your production date!\n\nCole\nMerch Troop`;
      } else if (task.stage === 'confirm_event') {
        smsText = `Hi ${contact.split(' ')[0]}, this is Cole from Merch Troop. Getting close to your event${dueDate ? ' on ' + dueDate : ''} -- can we confirm the venue address, arrival time, and final garment list?`;
        emailSubject = `Event confirmation needed -- ${task.jobName || 'your event'}`;
        emailBody = `Hi ${contact.split(' ')[0]},\n\nWe're getting everything lined up for your event${dueDate ? ' on ' + dueDate : ''}. To finalize our setup, I need to confirm a few things:\n\n• Venue address (for navigation + calendar invite)\n• Arrival/setup time\n• Final garment/item list with quantities\n• Number of stations confirmed\n• Any last-minute art updates\n\nLet me know and I'll get everything locked in!\n\nCole\nMerch Troop`;
      } else {
        // Generic follow-up
        smsText = `Hi ${contact.split(' ')[0]}, Cole from Merch Troop here. Just checking in on ${jobName !== contact ? jobName : 'your order'}${dueDate ? ' -- coming up on ' + dueDate : ''}. Any questions or updates?`;
        emailSubject = `Following up -- ${jobName}`;
        emailBody = `Hi ${contact.split(' ')[0]},\n\nJust a quick check-in on ${jobName !== contact ? jobName : 'your project'}. Let me know if you need anything or if there have been any changes.\n\nCole\nMerch Troop`;
      }

      const draft = {
        id: `d_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        taskId,
        contactName: contact,
        stage: task.stage,
        smsText,
        emailSubject,
        emailBody,
        createdAt: new Date().toISOString(),
        createdBy: req._session?.name || null,
      };

      // Save draft to a drafts JSONL for history
      const draftPath = path.join(MEMORY_DIR, 'portal-email-drafts.jsonl');
      appendJsonl(draftPath, draft);

      return sendJson(res, { ok: true, draft });
    }

    // -- Message templates for task communication --------------------------
    if (req.method === 'POST' && p === '/api/ai/template') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, template } = payload;
      if (!taskId || !template) return bad(res, 400, 'Missing taskId or template');
      if (typeof taskId !== 'string' || taskId.length > 200) return bad(res, 400, 'Invalid taskId');
      if (typeof template !== 'string' || template.length > 100) return bad(res, 400, 'Invalid template');
      const VALID_TEMPLATES = ['follow_up_estimate', 'art_approval', 'order_shipped', 'event_reminder'];
      if (!VALID_TEMPLATES.includes(template)) return bad(res, 400, 'Unknown template. Valid: ' + VALID_TEMPLATES.join(', '));

      const all = readJsonl(FILES.tasksFile);
      const task = all.find(t => t.id === taskId);
      if (!task) return bad(res, 404, 'Task not found');

      const contact = task.contactName || 'Customer';
      const firstName = contact.split(' ')[0];
      const jobName = task.jobName || contact;
      const amount = task.amount ? '$' + Number(task.amount).toLocaleString() : null;
      const dueDate = task.dueDate ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : null;

      // Also try to find linked event info
      const evStore = readEvents();
      const linkedEvent = evStore.events.find(e => !e.cancelled && task.contactName && e.contactName?.toLowerCase() === task.contactName?.toLowerCase());
      const eventDate = linkedEvent?.date ? new Date(linkedEvent.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : dueDate;
      const eventLocation = linkedEvent?.address || linkedEvent?.location || '';
      const eventTime = linkedEvent?.startTime || '';

      let smsText = '';
      let emailSubject = '';
      let emailBody = '';

      if (template === 'follow_up_estimate') {
        smsText = `Hi ${firstName}, just circling back on the Merch Troop estimate${amount ? ' (' + amount + ')' : ''}. Any questions? Happy to make adjustments or hop on a quick call.`;
        emailSubject = `Following up on your Merch Troop estimate`;
        emailBody = `Hi ${firstName},\n\nJust checking in on the estimate I sent over${amount ? ' for ' + amount : ''}. I want to make sure everything looks good and answer any questions.\n\nIf you'd like to move forward, just reply and I'll get everything lined up. If anything needs adjusting, I'm happy to revise.\n\nCole\nMerch Troop`;
      } else if (template === 'art_approval') {
        smsText = `Hi ${firstName}, quick heads up -- we need art approval for ${jobName !== contact ? jobName : 'your order'} before we can start production. Can you review and confirm?`;
        emailSubject = `Art approval needed -- ${jobName}`;
        emailBody = `Hi ${firstName},\n\nWe're ready to move into production on ${jobName !== contact ? jobName : 'your order'}${amount ? ' (' + amount + ')' : ''}, but we need your art approval first.\n\nPlease review the mockup and reply with:\n- Approved as-is, OR\n- Any changes you'd like\n\nOnce approved, we'll lock in your production date right away.\n\nCole\nMerch Troop`;
      } else if (template === 'order_shipped') {
        smsText = `Hi ${firstName}! Great news -- your Merch Troop order${jobName !== contact ? ' (' + jobName + ')' : ''} has shipped! You should receive it within 3-5 business days. Let me know when it arrives!`;
        emailSubject = `Your Merch Troop order has shipped!`;
        emailBody = `Hi ${firstName},\n\nYour order${jobName !== contact ? ' for ' + jobName : ''} has been shipped and is on its way!\n\nExpected delivery: 3-5 business days\n\nWhen it arrives, give everything a look and let me know if you have any questions. We love seeing photos of your merch in action!\n\nCole\nMerch Troop`;
      } else if (template === 'event_reminder') {
        const fmt12t = t => { if (!t) return ''; const [h, m] = t.split(':').map(Number); return (h % 12 || 12) + (m ? ':' + String(m).padStart(2, '0') : '') + (h < 12 ? ' AM' : ' PM'); };
        smsText = `Hi ${firstName}! Quick reminder -- your Merch Troop event${eventDate ? ' is coming up ' + eventDate : ' is coming up soon'}${eventLocation ? ' at ' + eventLocation : ''}. We're all set on our end. See you there!`;
        emailSubject = `Event reminder -- ${linkedEvent?.eventName || jobName}`;
        emailBody = `Hi ${firstName},\n\nJust a friendly reminder that your Merch Troop event is coming up!\n\n${eventDate ? 'Date: ' + eventDate + '\n' : ''}${eventTime ? 'Time: ' + fmt12t(eventTime) + '\n' : ''}${eventLocation ? 'Location: ' + eventLocation + '\n' : ''}\nOur crew will arrive 1 hour before the event start for setup. If there are any last-minute changes to the plan, just let us know.\n\nLooking forward to it!\n\nCole\nMerch Troop`;
      } else {
        return bad(res, 400, 'Unknown template. Valid: follow_up_estimate, art_approval, order_shipped, event_reminder');
      }

      return sendJson(res, {
        ok: true,
        template,
        draft: { smsText, emailSubject, emailBody, contactName: contact, taskId },
      });
    }

    // AI: Draft estimate for a task
    if (req.method === 'POST' && p === '/api/ai/draft-estimate') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');

      const all = readJsonl(FILES.tasksFile);
      const task = all.find(t => t.id === taskId);
      if (!task) return bad(res, 404, 'Task not found');

      // Try to load pricing context
      let pricing = null;
      const pricingPath = path.join(WORKSPACE, 'context', 'pricing.json');
      try { if (fs.existsSync(pricingPath)) pricing = readJson(pricingPath, null); } catch {}

      const notes = (task.notes || '').toLowerCase();
      const jobName = task.jobName || task.contactName;

      // Parse quantity from notes
      const qtyMatch = notes.match(/(\d+)\s*(?:pcs?|pieces?|shirts?|tees?|hoodies?|items?|units?|garments?)?/i);
      const qty = qtyMatch ? parseInt(qtyMatch[1]) : 50;

      // Detect decoration type
      const isScreenPrint = /screen\s*print|1[\s-]?color|2[\s-]?color|spot/i.test(notes);
      const isDtf = /dtf|direct.to.film/i.test(notes);
      const isEmbroidery = /embroid/i.test(notes);
      const isEvent = task.jobType === 'event' || /live\s*event|live\s*print|activation/i.test(notes);

      // Build line items
      const lineItems = [];

      if (isEvent) {
        const stations = parseInt((notes.match(/(\d+)\s*station/i) || [])[1] || '2');
        const hours = 6;
        lineItems.push({ description: `Live print activation -- ${stations} station${stations > 1 ? 's' : ''}`, quantity: stations, unitPrice: 750, subtotal: stations * 750 });
        lineItems.push({ description: `Event labor (${hours} hours per station)`, quantity: stations * hours, unitPrice: 85, subtotal: stations * hours * 85 });
        if (task.dueDate) {
          lineItems.push({ description: 'Travel & logistics', quantity: 1, unitPrice: 300, subtotal: 300 });
        }
      } else {
        const unitPrice = qty >= 144 ? 8 : qty >= 72 ? 10 : qty >= 48 ? 12 : qty >= 24 ? 15 : 18;
        const decorType = isEmbroidery ? 'embroidery' : isDtf ? 'DTF transfer' : 'screen print';
        lineItems.push({ description: `Custom ${decorType} -- ${qty} garments`, quantity: qty, unitPrice, subtotal: qty * unitPrice });

        if (isScreenPrint) {
          lineItems.push({ description: 'Screen setup fee', quantity: 1, unitPrice: 25, subtotal: 25 });
        }
        if (isDtf) {
          lineItems.push({ description: 'DTF gang sheet setup', quantity: 1, unitPrice: 0, subtotal: 0 });
        }
      }

      const subtotal = lineItems.reduce((s, i) => s + i.subtotal, 0);
      const suggestedTotal = task.amount || subtotal;

      const draft = {
        id: `est_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        taskId,
        contactName: task.contactName,
        jobName,
        lineItems,
        subtotal,
        suggestedTotal,
        notes: `Based on: ${task.notes || 'job details'}`,
        createdAt: new Date().toISOString(),
        createdBy: req._session?.name || null,
        readyToCreateInGhl: false,
      };

      return sendJson(res, { ok: true, draft });
    }

    // Daily digest / proactive alerts
    if (req.method === 'GET' && p === '/api/overview/alerts') {
      const now = Date.now();
      const todayStr = new Date().toISOString().slice(0, 10);
      const all = readJsonl(FILES.tasksFile);
      const active = all.filter(t => !t.completedAt && (!t.snoozedUntil || new Date(t.snoozedUntil).getTime() <= now));
      const alerts = [];

      for (const task of active) {
        const sla = computeSla(task);
        const waitDays = task.waitingSince ? (now - new Date(task.waitingSince).getTime()) / 86400000 : 0;

        // Overdue with no assignee
        if (sla.status === 'overdue' && !task.assignee) {
          alerts.push({ level: 'urgent', taskId: task.id, contactName: task.contactName, message: `${task.contactName} -- ${TASK_STAGES[task.stage]?.label || task.stage} is overdue and unassigned`, action: 'assign' });
        }

        // Estimate follow-up hitting day thresholds
        if (task.stage === 'follow_up_estimate') {
          const day = Math.floor(waitDays);
          if (day === 1 || day === 3 || day === 7) {
            alerts.push({ level: 'attention', taskId: task.id, contactName: task.contactName, message: `${task.contactName} -- Day ${day} follow-up on estimate${task.amount ? ' ($' + Number(task.amount).toLocaleString() + ')' : ''}`, action: 'draft_email' });
          }
        }

        // High-value job sitting idle
        if (Number(task.amount) >= 2000 && waitDays > 2 && !task.assignee) {
          alerts.push({ level: 'attention', taskId: task.id, contactName: task.contactName, message: `High-value job (${task.contactName} -- $${Number(task.amount).toLocaleString()}) has been idle for ${Math.floor(waitDays)} days`, action: 'review' });
        }

        // Event approaching with unclaimed spots
        if (task.dueDate) {
          const daysUntilDue = (new Date(task.dueDate + 'T23:59:59').getTime() - now) / 86400000;
          if (daysUntilDue <= 3 && daysUntilDue > 0) {
            alerts.push({ level: 'urgent', taskId: task.id, contactName: task.contactName, message: `${task.contactName} -- ${TASK_STAGES[task.stage]?.label || task.stage} due in ${Math.ceil(daysUntilDue)} day${daysUntilDue < 1.5 ? '' : 's'}`, action: 'review' });
          }
        }
      }

      // Response time alerts for follow_up_lead tasks
      for (const t of active) {
        if (t.stage !== 'follow_up_lead') continue;
        if (t.completedAt || t.assignee) continue;
        const hoursOld = (Date.now() - new Date(t.createdAt).getTime()) / 3600000;
        if (hoursOld >= 24) {
          alerts.push({ level: 'urgent', taskId: t.id, contactName: t.contactName, message: `${t.contactName} -- New lead with no contact for ${Math.round(hoursOld)}h (goal: reply within 1h)`, action: 'draft_email' });
        } else if (hoursOld >= 1) {
          alerts.push({ level: 'attention', taskId: t.id, contactName: t.contactName, message: `${t.contactName} -- New lead, ${Math.round(hoursOld)}h since inquiry -- reply soon`, action: 'draft_email' });
        }
      }

      // Deduplicate by taskId + action
      const seen = new Set();
      const unique = alerts.filter(a => {
        const k = a.taskId + a.action;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });

      // Sort: urgent first
      unique.sort((a, b) => (a.level === 'urgent' ? 0 : 1) - (b.level === 'urgent' ? 0 : 1));

      return sendJson(res, { ok: true, alerts: unique, count: unique.length, capturedAt: new Date().toISOString() });
    }

    // -- Daily brief (manual trigger) --------------------------------------
    if (req.method === 'POST' && p === '/api/slack/daily-brief') {
      await sendDailyBrief();
      return sendJson(res, { ok: true });
    }

    // -- Briefing data (GET -- returns brief as JSON, does NOT send to Slack) --
    if (req.method === 'GET' && p === '/api/briefing') {
      const all = readJsonl(FILES.tasksFile);
      const now = Date.now();
      const active = all.filter(t => !t.completedAt && (t.leadStatus || 'active') === 'active');
      const evStore = readJson(FILES.eventsFile, { events: [] });
      const todayStr = new Date().toISOString().slice(0, 10);
      const tomorrowStr = new Date(now + 86400000).toISOString().slice(0, 10);
      const todayEvents = evStore.events.filter(e => !e.cancelled && (e.date === todayStr || e.date === tomorrowStr));

      const pipelineRevenue = active.reduce((s, t) => s + (Number(t.amount) || 0), 0);
      const overdueTasks = active.filter(t => computeSla(t).status === 'overdue');
      const followUpsDue = active.filter(t => ['follow_up_estimate', 'follow_up_lead'].includes(t.stage) && (computeSla(t).status === 'overdue' || computeSla(t).status === 'dueSoon'));

      const urgentTasks = overdueTasks
        .map(t => {
          const sla = computeSla(t);
          const priority = computePriority(t);
          const score = computePriorityScore(t, priority, sla);
          return { ...t, _sla: sla, _score: score, taskLabel: TASK_STAGES[t.stage]?.label || t.stage, slaText: sla.text };
        })
        .sort((a, b) => b._score - a._score)
        .slice(0, 3);

      const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

      return sendJson(res, {
        ok: true,
        date: dateLabel,
        pipelineRevenue,
        overdueCount: overdueTasks.length,
        followUpsDue: followUpsDue.length,
        urgentTasks: urgentTasks.map(t => ({ contactName: t.contactName, taskLabel: t.taskLabel, amount: t.amount || null, slaText: t.slaText || null })),
        todayEvents: todayEvents.map(e => ({ id: e.id, eventName: e.eventName || e.contactName, date: e.date })),
        capturedAt: new Date().toISOString(),
      });
    }

    // -- GHL: List recent conversations -----------------------------------
    if (req.method === 'GET' && p === '/api/ghl/conversations') {
      const t = ghlToken();
      if (!t?.access_token) return sendJson(res, { ok: false, error: 'ghl_not_configured', items: [] });
      const env = parseDotEnv(FILES.ghlEnv);
      const locationId = u.searchParams.get('locationId') || env.GHL_DEFAULT_LOCATION_ID || t.locationId || 'lozEpTY3hc99inDzrH6C';
      const limit = Math.min(50, Math.max(1, Number(u.searchParams.get('limit') || 20)));
      const status = u.searchParams.get('status') || 'all'; // all, read, unread
      try {
        const qp = `locationId=${encodeURIComponent(locationId)}&limit=${limit}${status !== 'all' ? '&status=' + status : ''}`;
        const data = await ghlFetch(`/conversations/search/?${qp}`);
        const items = (data?.conversations || []).map(c => ({
          id: c.id,
          contactId: c.contactId,
          contactName: c.contactName || c.fullName || null,
          email: c.email || null,
          phone: c.phone || null,
          lastMessageBody: c.lastMessageBody || null,
          lastMessageDate: c.lastMessageDate || null,
          lastMessageDirection: c.lastMessageDirection || null,
          unreadCount: c.unreadCount || 0,
        }));
        return sendJson(res, { ok: true, items, capturedAt: new Date().toISOString() });
      } catch (e) {
        return sendJson(res, { ok: false, error: e.message, items: [] });
      }
    }

    // -- GHL: Get conversation messages ------------------------------------
    if (req.method === 'GET' && p.startsWith('/api/ghl/conversations/') && p.endsWith('/messages')) {
      const t = ghlToken();
      if (!t?.access_token) return sendJson(res, { ok: false, error: 'ghl_not_configured', messages: [] });
      const convId = p.split('/')[4];
      if (!convId) return bad(res, 400, 'Missing conversation ID');
      const limit = Math.min(30, Math.max(1, Number(u.searchParams.get('limit') || 15)));
      try {
        const data = await ghlFetch(`/conversations/${convId}/messages/?limit=${limit}`);
        const container = data?.messages || {};
        const msgs = (typeof container === 'object' && !Array.isArray(container))
          ? (container.messages || [])
          : (Array.isArray(container) ? container : []);
        const messages = msgs.map(m => ({
          id: m.id,
          direction: m.direction || null,
          body: m.body || null,
          type: m.type,
          dateAdded: m.dateAdded,
          status: m.status || null,
          contentType: m.contentType || null,
        }));
        return sendJson(res, { ok: true, messages, capturedAt: new Date().toISOString() });
      } catch (e) {
        return sendJson(res, { ok: false, error: e.message, messages: [] });
      }
    }

    // -- GHL: Search contacts ----------------------------------------------
    if (req.method === 'GET' && p === '/api/ghl/contacts/search') {
      const t = ghlToken();
      if (!t?.access_token) return sendJson(res, { ok: false, error: 'ghl_not_configured', items: [] });
      const env = parseDotEnv(FILES.ghlEnv);
      const locationId = env.GHL_DEFAULT_LOCATION_ID || t.locationId || 'lozEpTY3hc99inDzrH6C';
      const query = u.searchParams.get('q') || '';
      if (!query) return bad(res, 400, 'Missing q param');
      try {
        const data = await ghlFetch(`/contacts/?locationId=${encodeURIComponent(locationId)}&limit=10&query=${encodeURIComponent(query)}`);
        const items = (data?.contacts || []).map(c => ({
          id: c.id, name: c.contactName, email: c.email, phone: c.phone,
        }));
        return sendJson(res, { ok: true, items });
      } catch (e) {
        return sendJson(res, { ok: false, error: e.message, items: [] });
      }
    }

    // -- GHL: Send SMS ------------------------------------------------------
    if (req.method === 'POST' && p === '/api/ghl/send-sms') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { contactId, phone, message, taskId } = payload;
      if (!message || typeof message !== 'string' || !message.trim()) return bad(res, 400, 'Missing message');
      if (message.length > 1600) return bad(res, 400, 'Message too long (max 1600 chars)');
      if (!contactId && !phone) return bad(res, 400, 'Missing contactId or phone');
      const t = ghlToken();
      if (!t?.access_token) return sendJson(res, { ok: false, error: 'ghl_not_configured' });
      const locationId = t.locationId;
      try {
        let conversationId = null;
        if (contactId) {
          const convData = await ghlPost('/conversations', { contactId, locationId });
          conversationId = convData?.id || convData?.conversation?.id || null;
          if (conversationId) {
            const msgData = await ghlPost('/conversations/messages', { type: 'SMS', message, conversationId });
            const messageId = msgData?.id || msgData?.messageId || null;
            // Optionally write GHL contact note
            if (taskId) {
              try { await ghlPost(`/contacts/${contactId}/notes`, { body: `[Portal] SMS sent via portal${message ? ': ' + message.slice(0, 120) : ''}` }); } catch (e) { console.error(`[ghl-sms] Failed to add note for contact ${contactId}:`, e.message); }
            }
            return sendJson(res, { ok: true, sent: true, conversationId, messageId });
          }
        }
        // fallback: direct phone
        if (phone) {
          const msgData = await ghlPost('/conversations/messages', { type: 'SMS', message, phone, locationId });
          const messageId = msgData?.id || msgData?.messageId || null;
          return sendJson(res, { ok: true, sent: true, conversationId: null, messageId });
        }
        return bad(res, 400, 'Missing contactId or phone');
      } catch (e) {
        return sendJson(res, { ok: false, error: e.message });
      }
    }

    // -- GHL: Contact note --------------------------------------------------
    if (req.method === 'POST' && p === '/api/ghl/contact/note') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { contactId, note } = payload;
      if (!contactId || !note) return bad(res, 400, 'Missing contactId/note');
      try {
        const result = await ghlPost(`/contacts/${contactId}/notes`, { body: note, userId: ghlToken()?.userId || null });
        return sendJson(res, { ok: true, noteId: result?.id || null });
      } catch (e) {
        return bad(res, 500, 'Failed to add GHL note', { message: e.message });
      }
    }

    // -- Analytics: Revenue funnel ------------------------------------------
    if (req.method === 'GET' && p === '/api/analytics/funnel') {
      const all = readJsonl(FILES.tasksFile);
      const active = all.filter(t => !t.completedAt && (t.leadStatus || 'active') === 'active');
      const cold = all.filter(t => !t.completedAt && t.leadStatus === 'cold');
      const completed = all.filter(t => t.completedAt);

      const stageOrder = ['follow_up_lead','send_estimate','follow_up_estimate','order_blanks','confirm_art','schedule_production','qc_pack','ship_deliver','confirm_event','order_event_supplies','event_production','pack_event_kit'];

      const byStage = {};
      for (const stage of stageOrder) {
        const stageTasks = active.filter(t => t.stage === stage);
        byStage[stage] = {
          stage,
          label: TASK_STAGES[stage]?.label || stage,
          count: stageTasks.length,
          revenue: stageTasks.reduce((s, t) => s + (Number(t.amount) || 0), 0),
        };
      }

      const totalRevenue = active.reduce((s, t) => s + (Number(t.amount) || 0), 0);
      const avgDealSize = active.length ? Math.round(totalRevenue / (active.filter(t => t.amount).length || 1)) : 0;
      const coldRevenue = cold.reduce((s, t) => s + (Number(t.amount) || 0), 0);

      const totalLeads = all.filter(t => t.stage === 'follow_up_lead' || t.source === 'ghl_opportunity').length;
      const wonDeals = completed.filter(t => ['ship_deliver','pack_event_kit'].includes(t.stage)).length;

      return sendJson(res, { ok: true, byStage, totalRevenue, avgDealSize, coldRevenue, coldCount: cold.length, wonDeals, totalLeads, capturedAt: new Date().toISOString() });
    }

    // -- Tasks: Checklist --------------------------------------------------
    if (req.method === 'POST' && p === '/api/tasks/checklist') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, item, checked, generate } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');
      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');

      if (generate) {
        all[idx].checklist = generatePackingChecklist(all[idx]);
      } else if (item) {
        const list = all[idx].checklist || [];
        const itemIdx = list.findIndex(i => i.id === item);
        if (itemIdx >= 0) list[itemIdx].checked = !!checked;
        all[idx].checklist = list;
      }
      writeJsonl(FILES.tasksFile, all);
      return sendJson(res, { ok: true, checklist: all[idx].checklist });
    }

    // -- Tasks: Supply order ------------------------------------------------
    if (req.method === 'POST' && p === '/api/tasks/supply-order') {
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { taskId, orderRef, supplier, status } = payload;
      if (!taskId) return bad(res, 400, 'Missing taskId');
      const all = readJsonl(FILES.tasksFile);
      const idx = all.findIndex(t => t.id === taskId);
      if (idx < 0) return bad(res, 404, 'Task not found');
      const updates = { updatedAt: new Date().toISOString() };
      if (orderRef !== undefined) updates.supplyOrderRef = orderRef || null;
      if (supplier !== undefined) updates.supplySupplier = supplier || null;
      if (status !== undefined) updates.supplyStatus = status || null;
      all[idx] = { ...all[idx], ...updates };
      writeJsonl(FILES.tasksFile, all);
      return sendJson(res, { ok: true });
    }

    // -- Access request queue (admin only) ---------------------------------
    if (req.method === 'GET' && p === '/api/auth/access-requests') {
      if (req._session?.role !== 'admin') return bad(res, 403, 'Admin only');
      const store = readJson(FILES.accessRequestsFile, { requests: [] });
      return sendJson(res, { ok: true, requests: (store.requests || []).filter(r => r.status === 'pending') });
    }

    if (req.method === 'POST' && p === '/api/auth/access-requests/approve') {
      if (req._session?.role !== 'admin') return bad(res, 403, 'Admin only');
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { requestId, role: grantRole } = payload;
      const store = readJson(FILES.accessRequestsFile, { requests: [] });
      const req2 = (store.requests || []).find(r => r.id === requestId);
      if (!req2) return bad(res, 404, 'Request not found');
      req2.status = 'approved';
      req2.approvedAt = new Date().toISOString();
      writeJson(FILES.accessRequestsFile, store);
      const tempPassword = 'welcome' + Math.floor(1000 + Math.random() * 9000);
      const users = readJson(FILES.usersFile, { users: [] });
      users.users = users.users || [];
      const existingUser = users.users.find(u => u.name.toLowerCase() === req2.name.toLowerCase());
      if (!existingUser) {
        users.users.push({ id: `u_${Date.now()}`, name: req2.name, role: grantRole || 'onsite', passwordHash: sha256(tempPassword), createdAt: new Date().toISOString() });
        writeJson(FILES.usersFile, users);
      }
      return sendJson(res, { ok: true, name: req2.name, tempPassword: existingUser ? null : tempPassword });
    }

    if (req.method === 'POST' && p === '/api/auth/access-requests/deny') {
      if (req._session?.role !== 'admin') return bad(res, 403, 'Admin only');
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { requestId } = payload;
      const store = readJson(FILES.accessRequestsFile, { requests: [] });
      const req2 = (store.requests || []).find(r => r.id === requestId);
      if (req2) { req2.status = 'denied'; req2.deniedAt = new Date().toISOString(); writeJson(FILES.accessRequestsFile, store); }
      return sendJson(res, { ok: true });
    }

    // -- Payroll ------------------------------------------------------------
    if (req.method === 'GET' && p === '/api/payroll') {
      if (!['admin', 'va'].includes(req._session?.role)) return bad(res, 403, 'Admin or VA only');
      const store = readJson(FILES.eventsFile, { events: [] });
      const events = (store.events || []).filter(e => !e.cancelled && Array.isArray(e.claims) && e.claims.length > 0);
      const rows = [];
      for (const ev of events) {
        for (const claim of ev.claims) {
          rows.push({
            eventId: ev.id,
            eventName: ev.eventName || ev.contactName,
            eventDate: ev.date,
            staffName: claim.name,
            staffEmail: claim.email,
            rsvpStatus: claim.rsvpStatus || 'pending',
            hourlyRate: claim.hourlyRate || null,
            hoursWorked: claim.hoursWorked || null,
            totalPay: (claim.hourlyRate && claim.hoursWorked) ? Number(claim.hourlyRate) * Number(claim.hoursWorked) : null,
          });
        }
      }
      const totalPay = rows.reduce((s, r) => s + (r.totalPay || 0), 0);
      return sendJson(res, { ok: true, rows, totalPay });
    }

    if (req.method === 'POST' && p === '/api/payroll/update') {
      if (!['admin', 'va'].includes(req._session?.role)) return bad(res, 403, 'Admin or VA only');
      const body = await collectBody(req);
      let payload; try { payload = JSON.parse(body); } catch { return bad(res, 400, 'Invalid JSON'); }
      const { eventId, staffEmail, hourlyRate, hoursWorked } = payload;
      if (!eventId || !staffEmail) return bad(res, 400, 'Missing eventId/staffEmail');
      const store = readJson(FILES.eventsFile, { events: [] });
      const ev = (store.events || []).find(e => e.id === eventId);
      if (!ev) return bad(res, 404, 'Event not found');
      const claim = ev.claims.find(c => c.email.toLowerCase() === staffEmail.toLowerCase());
      if (!claim) return bad(res, 404, 'Claim not found');
      if (hourlyRate !== undefined) claim.hourlyRate = hourlyRate ? Number(hourlyRate) : null;
      if (hoursWorked !== undefined) claim.hoursWorked = hoursWorked ? Number(hoursWorked) : null;
      writeEvents(store);
      return sendJson(res, { ok: true });
    }

    // Static
    if (req.method === 'GET' || req.method === 'HEAD') {
      return serveStatic(p, res);
    }

    return bad(res, 405, 'Method not allowed');
  } catch (e) {
    return bad(res, 500, e?.message || 'Server error');
  }
});

// -- Auto-Scrub Rules Engine ----------------------------------------------
// Detects tasks that should be closed/flagged based on signals:
// a) GHL estimate declined → auto-complete with "LOST - Estimate declined"
// b) Contact keywords ("cancelled", "not moving forward", etc.) → flag for review
// c) Stale follow-up tasks (21+ days untouched) → mark as stale
const SCRUB_CANCEL_KEYWORDS = [
  'cancelled', 'canceled', 'not moving forward', 'went another direction',
  'decided to go elsewhere', 'no longer interested', 'pivoted',
  'changed direction', 'found someone else', 'going with another vendor',
  'not interested', 'pass on this', 'going to pass',
];

async function runAutoScrub() {
  const now = new Date();
  const nowIso = now.toISOString();
  const all = readJsonl(FILES.tasksFile);
  let completedCount = 0;
  let flaggedCount = 0;
  let staleCount = 0;
  let eventsCancelledCount = 0;
  const actions = []; // detailed log of what was changed
  const errors = [];

  // -- Rule A: Declined estimates → auto-complete ------------------------
  // Check GHL estimates for declined status and close matching tasks
  try {
    const token = ghlToken();
    if (token?.access_token && token?.locationId) {
      const locationId = token.locationId;
      const estData = await ghlFetch(`/invoices/estimate/list?altType=location&altId=${encodeURIComponent(locationId)}&offset=0&limit=100`);
      const estimates = estData?.estimates || estData?.invoices || estData?.items || [];

      for (const est of estimates) {
        const estStatus = (est.status || '').toLowerCase();
        if (estStatus !== 'declined' && estStatus !== 'void' && estStatus !== 'rejected') continue;

        const contactId = est?.contactDetails?.id || est?.contactDetails?._id || est.contactId;
        const contactName = est?.contactDetails?.name || est.contactName;
        if (!contactId && !contactName) continue;

        // Find open follow_up_estimate or send_estimate tasks for this contact
        for (const task of all) {
          if (task.completedAt) continue;
          if (!['follow_up_estimate', 'send_estimate', 'follow_up_lead'].includes(task.stage)) continue;

          const matchById = contactId && task.sourceContactId === contactId;
          const matchByName = contactName && task.contactName &&
            task.contactName.toLowerCase() === contactName.toLowerCase();

          if (matchById || matchByName) {
            task.completedAt = nowIso;
            task.completionNote = `LOST - Estimate declined (auto-scrub)`;
            task.completedBy = 'auto-scrub';
            completedCount++;
            actions.push({ rule: 'estimate-declined', taskId: task.id, contact: task.contactName, stage: task.stage, action: 'completed-lost' });
            // Cascade: cancel linked events for LOST tasks
            const ec = cascadeTaskToEvents(task, 'lost');
            eventsCancelledCount += ec;
            if (ec > 0) actions.push({ rule: 'cascade', taskId: task.id, contact: task.contactName, action: `cancelled ${ec} event(s)` });
          }
        }
      }
    }
  } catch (e) {
    console.error('[auto-scrub] Estimate check error:', e.message);
    errors.push({ rule: 'estimate-declined', error: e.message });
  }

  // -- Rule B: Keyword detection in task notes → flag for review ---------
  for (const task of all) {
    if (task.completedAt) continue;
    if (task.autoScrubFlagged) continue; // already flagged by scrub, skip

    const searchText = [task.notes, task.completionNote, task.flagNote].filter(Boolean).join(' ').toLowerCase();
    const found = SCRUB_CANCEL_KEYWORDS.some(kw => searchText.includes(kw));

    if (found) {
      task.autoScrubFlagged = true;
      task.autoScrubFlaggedAt = nowIso;
      task.autoScrubReason = 'cancel-keyword';
      if (!task.flaggedAt) {
        task.flaggedAt = nowIso;
        task.flaggedBy = 'auto-scrub';
        task.flagNote = 'Auto-flagged: contact language suggests cancellation';
      }
      flaggedCount++;
      actions.push({ rule: 'cancel-keyword', taskId: task.id, contact: task.contactName, stage: task.stage, action: 'flagged' });
    }
  }

  // -- Rule C: Stale follow-up tasks (21+ days untouched) ----------------
  const STALE_THRESHOLD_MS = 21 * 24 * 60 * 60 * 1000; // 21 days
  for (const task of all) {
    if (task.completedAt) continue;
    if (!['follow_up_lead', 'follow_up_estimate'].includes(task.stage)) continue;
    if (task.staleAt) continue; // already marked stale

    const lastTouch = task.updatedAt || task.acceptedAt || task.waitingSince || task.createdAt;
    if (!lastTouch) continue;

    const elapsed = now.getTime() - new Date(lastTouch).getTime();
    if (elapsed >= STALE_THRESHOLD_MS) {
      task.staleAt = nowIso;
      task.autoScrubFlagged = true;
      task.autoScrubFlaggedAt = nowIso;
      task.autoScrubReason = 'stale-21d';
      staleCount++;
      const staleDays = Math.round(elapsed / 86400000);
      actions.push({ rule: 'stale-21d', taskId: task.id, contact: task.contactName, stage: task.stage, action: `marked-stale (${staleDays}d)` });
    }
  }

  writeJsonl(FILES.tasksFile, all);

  const summary = { completedCount, flaggedCount, staleCount, eventsCancelledCount, scrubbedAt: nowIso, actions, errors: errors.length ? errors : undefined };
  console.log(`[auto-scrub] Completed: ${completedCount}, Flagged: ${flaggedCount}, Stale: ${staleCount}, Events cancelled: ${eventsCancelledCount}`);

  // Persist to scrub log
  try {
    appendJsonl(FILES.scrubLogFile, summary);
  } catch (e) {
    console.error('[auto-scrub] Failed to write scrub log:', e.message);
  }

  return summary;
}

// Run auto-scrub on startup
setTimeout(() => runAutoScrub().catch(e => console.error('[auto-scrub] startup error:', e.message)), 5000);
// Run auto-scrub every 6 hours
setInterval(() => runAutoScrub().catch(e => console.error('[auto-scrub] interval error:', e.message)), 6 * 60 * 60 * 1000);

// -- Session Cleanup -----------------------------------------------------
// Periodically purge expired sessions from the sessions file.
function cleanupExpiredSessions() {
  try {
    const store = readJson(FILES.sessionsFile, { sessions: [] });
    const before = (store.sessions || []).length;
    store.sessions = (store.sessions || []).filter(s => {
      if (!s.expiresAt) return true; // no expiry = keep
      return new Date(s.expiresAt).getTime() > Date.now();
    });
    const purged = before - store.sessions.length;
    if (purged > 0) {
      writeJson(FILES.sessionsFile, store);
      console.log(`[session-cleanup] Purged ${purged} expired session(s)`);
    }
  } catch (e) {
    console.error('[session-cleanup] Error:', e.message);
  }
}

// Run session cleanup on startup and every 6 hours
cleanupExpiredSessions();
setInterval(cleanupExpiredSessions, 6 * 60 * 60 * 1000);

server.listen(PORT, HOST, () => {
  console.log(`Rosie Portal listening on http://${HOST}:${PORT}`);
  console.log(`Workspace: ${WORKSPACE}`);
});

// -- Daily Slack Briefing -------------------------------------------------
async function sendDailyBrief() {
  try {
    const all = readJsonl(FILES.tasksFile);
    const now = Date.now();
    const active = all.filter(t => !t.completedAt && (t.leadStatus || 'active') === 'active');
    const evStore = readJson(FILES.eventsFile, { events: [] });
    const todayStr = new Date().toISOString().slice(0, 10);
    const tomorrowStr = new Date(now + 86400000).toISOString().slice(0, 10);
    const todayEvents = evStore.events.filter(e => !e.cancelled && (e.date === todayStr || e.date === tomorrowStr));

    const pipelineRevenue = active.reduce((s, t) => s + (Number(t.amount) || 0), 0);
    const overdueTasks = active.filter(t => computeSla(t).status === 'overdue');
    const followUpsDue = active.filter(t => ['follow_up_estimate', 'follow_up_lead'].includes(t.stage) && (computeSla(t).status === 'overdue' || computeSla(t).status === 'dueSoon'));

    // Sort by priority score for urgent top-3
    const urgent = overdueTasks
      .map(t => {
        const sla = computeSla(t);
        const priority = computePriority(t);
        const score = computePriorityScore(t, priority, sla);
        return { ...t, _sla: sla, _score: score };
      })
      .sort((a, b) => b._score - a._score)
      .slice(0, 3);

    const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

    const urgentLines = urgent.map(t => {
      const rev = t.amount ? ` · $${Number(t.amount).toLocaleString()}` : '';
      const slaText = t._sla.text ? ` · ${t._sla.text}` : '';
      return `• ${t.contactName} -- ${TASK_STAGES[t.stage]?.label || t.stage}${rev}${slaText}`;
    }).join('\n') || '• None';

    const eventLines = todayEvents.map(e => {
      const stationsMatch = (e.notes || '').match(/(\d+)\s*station/i);
      const stationsText = stationsMatch ? ` · ${stationsMatch[1]} stations` : '';
      return `• ${e.date === todayStr ? new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : new Date(e.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} -- ${e.eventName || e.contactName}${e.contactName ? ' · ' + e.contactName : ''}${stationsText}`;
    }).join('\n') || '• None today or tomorrow';

    const text = `:sunrise: *Good morning -- Merch Troop Daily Brief*\n*Date:* ${dateLabel}\n\n*Today's Events:* ${todayEvents.length} event${todayEvents.length === 1 ? '' : 's'} on the calendar\n*Pipeline Revenue:* $${pipelineRevenue.toLocaleString()}\n*Overdue Tasks:* ${overdueTasks.length}  |  *Follow-ups Due:* ${followUpsDue.length}\n\n:rotating_light: *Urgent (top 3):*\n${urgentLines}\n\n:calendar: *Events Today/Tomorrow:*\n${eventLines}\n\nHave a great day!`;

    await slackPost(SLACK_OPS_CHANNEL, text);
    const ps = readJson(FILES.portalState, {});
    ps.lastBriefDate = todayStr;
    writeJson(FILES.portalState, ps);
    console.log(`[brief] Daily brief sent for ${todayStr}`);
  } catch (e) {
    console.error('[brief] Error sending daily brief:', e.message);
  }
}

setInterval(() => {
  const now = new Date();
  const h = now.getHours();
  const m = now.getMinutes();
  if (h === 8 && m < 5) {
    const todayStr = now.toISOString().slice(0, 10);
    const ps = readJson(FILES.portalState, {});
    if (ps.lastBriefDate !== todayStr) {
      sendDailyBrief();
    }
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// TASK BOARD API
// (Rogue task handler removed -- was hijacking /api/tasks and returning empty data from wrong file)
