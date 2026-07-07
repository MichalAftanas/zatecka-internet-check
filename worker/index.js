/**
 * zatecka-check-now — Cloudflare Worker
 *
 * Polls Gmail for FortiGate SD-WAN events, commits new data to GitHub,
 * and triggers a Cloudflare Pages redeploy.
 *
 * Handles:
 *   Cron (every 6 hours)   — automatic poll
 *   POST /              — manual poll ("Check now" button in dashboard)
 *   GET  /              — return { lastPolledAt } for dashboard "Last checked"
 *
 * Required secrets (wrangler secret put <NAME>):
 *   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
 *   GITHUB_TOKEN        PAT with Contents: read+write
 *
 * Required KV namespace (see wrangler.toml [[kv_namespaces]]):
 *   binding = "KV"
 */

const REPO_OWNER     = 'aftanasmichal';
const REPO_NAME      = 'zatecka-internet-check';
const BRANCH         = 'main';
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB rotation threshold

// Cloudflare's free plan allows 50 subrequests per Worker invocation. Each email
// body is one subrequest, plus ~4 for token/list/GitHub reads and 1 for the commit.
// Cap the bodies fetched per poll well under that ceiling; any backlog drains across
// successive polls. (A June 2026 flapping storm produced >50 emails in the
// query window, which blew past the limit and deadlocked the poller for two weeks.)
const FETCH_CAP = 30;

// ─────────────────────────────────────────────────────────────────────────────

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runPoll(env));
  },

  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': 'https://itrinity.pages.dev',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === 'GET') {
      const lastPolledAt = (await env.KV?.get('lastPolledAt')) ?? null;
      return Response.json({ lastPolledAt }, { headers: cors });
    }

    if (request.method === 'POST') {
      try {
        const result = await runPoll(env);
        return Response.json({ ok: true, ...result }, { headers: cors });
      } catch (err) {
        console.error('Manual poll failed:', err.message);
        return Response.json({ ok: false, error: 'Poll failed' }, { status: 500, headers: cors });
      }
    }

    return new Response('Method Not Allowed', { status: 405 });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Core poll logic
// ─────────────────────────────────────────────────────────────────────────────

async function runPoll(env) {
  const gmailToken = await getGmailToken(env);

  // Second-resolution cursor: fetch only emails received after it. Replaces the old
  // coarse `lastEventDate` (YYYY-MM-DD) cursor, which could deadlock: a single heavy
  // flapping day produced more emails than the 50-subrequest budget could fetch, and a
  // date cursor can't advance within a day, so every poll re-read the same oversized
  // window and threw before committing.
  const sinceEpoch = await getCursorEpoch(env);
  const messages = await listGmailMessages(gmailToken, sinceEpoch);

  if (messages.length === 0) {
    console.log('No FortiGate emails found');
    await env.KV?.put('lastPolledAt', new Date().toISOString()).catch(console.error);
    return { new_events: 0 };
  }

  // Gmail lists newest-first; take the OLDEST batch so the cursor moves forward and any
  // backlog drains in chronological order across successive polls.
  const batch = messages.slice(-FETCH_CAP);
  const backlog = messages.length - batch.length;
  console.log(`Fetching ${batch.length} of ${messages.length} candidate emails (oldest first, backlog ${backlog})`);

  const { index, indexSha, data, dataSha, dataPath } = await loadRepoData(env);
  const seenEids = new Set(data.events.map(e => e.eid));

  const newEvents = [];
  let cursorMs = 0; // max internalDate (ms) of successfully fetched messages this poll
  for (const { id } of batch) {
    const msg = await fetchMessage(gmailToken, id);
    if (!msg) continue; // transient fetch failure, leave cursor, retry next poll
    if (msg.internalMs > cursorMs) cursorMs = msg.internalMs;
    if (!msg.html) continue;
    let event;
    try { event = parseFortiGateEmail(msg.html); } catch { continue; }
    if (seenEids.has(event.eid)) continue;
    newEvents.push(event);
    seenEids.add(event.eid);
    console.log(`+event  ${event.ts}  ${event.iface}  ${event.from}→${event.to}`);
  }

  // Advance the cursor to this batch's newest message. Subtract 1s so same-second
  // boundary messages aren't skipped; the eid set dedups the small re-read overlap.
  // Only PERSIST the cursor after a successful commit, so a failed commit (e.g. a
  // GitHub write race) retries the same batch next poll instead of skipping it.
  const advanceCursor = () =>
    cursorMs > 0
      ? env.KV?.put('lastPollEpoch', String(Math.floor(cursorMs / 1000) - 1)).catch(console.error)
      : Promise.resolve();

  if (newEvents.length === 0) {
    console.log('No new events in this batch');
    await advanceCursor(); // no commit needed; safe to step past an all-duplicate batch
    await env.KV?.put('lastPolledAt', new Date().toISOString()).catch(console.error);
    return { new_events: 0, backlog };
  }

  data.events.push(...newEvents);
  data.events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  await commitFile(
    env, dataPath, data, dataSha,
    `data: ingest ${newEvents.length} FortiGate event(s) [skip ci]`,
  );
  console.log(`Committed ${newEvents.length} new event(s)`);

  await advanceCursor(); // commit succeeded, now it's safe to advance
  await env.KV?.put('lastPolledAt', new Date().toISOString()).catch(console.error);

  if (JSON.stringify(data).length > MAX_FILE_BYTES) {
    await rotateDataFile(env, index, indexSha);
  }

  return { new_events: newEvents.length, backlog };
}

// Resolve the poll cursor (epoch seconds). Prefers the precise `lastPollEpoch`, falls
// back to migrating the old coarse `lastEventDate` key, then to the last 3 days.
async function getCursorEpoch(env) {
  const stored = await env.KV?.get('lastPollEpoch');
  if (stored) return Number(stored);
  const oldDate = await env.KV?.get('lastEventDate');
  if (oldDate) {
    // Start one day before the stored date, matching the previous 1-day query buffer.
    return Math.floor(Date.parse(oldDate + 'T00:00:00Z') / 1000) - 86400;
  }
  return Math.floor(Date.now() / 1000) - 3 * 86400;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gmail
// ─────────────────────────────────────────────────────────────────────────────

async function getGmailToken(env) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status}`);
  const { access_token } = await res.json();
  return access_token;
}

async function listGmailMessages(token, sinceEpoch) {
  // Gmail search accepts a Unix timestamp (epoch seconds) for after:, giving
  // second-resolution filtering (unlike the YYYY/MM/DD form, which is day-only).
  const query = `from:fgt@palefire.com after:${sinceEpoch}`;
  console.log(`Gmail query: ${query}`);
  const q = encodeURIComponent(query);
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${q}&maxResults=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`Gmail list messages failed: ${res.status}`);
  const json = await res.json();
  return json.messages ?? [];
}

async function fetchMessage(token, id) {
  const res = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return null;
  const msg = await res.json();
  // internalDate is Gmail's receive time in epoch milliseconds (string).
  return { html: extractHtmlPart(msg.payload), internalMs: Number(msg.internalDate) || 0 };
}

function extractHtmlPart(payload) {
  if (!payload) return null;
  const single = payload.body?.data;
  if (single) return decodeBase64Url(single);
  for (const part of payload.parts ?? []) {
    if (part.mimeType === 'text/html' && part.body?.data) {
      return decodeBase64Url(part.body.data);
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// FortiGate email parser
// ─────────────────────────────────────────────────────────────────────────────

function parseFortiGateEmail(html) {
  const m = html.match(
    /date=(\S+)\s+time=(\S+)\s+devid="\S+"\s+devname="\S+"\s+eventtime=(\d+)\s+tz="([^"]+)"[\s\S]*?interface="([^"]+)"[\s\S]*?oldvalue="([^"]+)"[\s\S]*?newvalue="([^"]+)"/,
  );
  if (!m) throw new Error('No FortiGate log line found in email');
  const [, date, time, eid, tz, iface, from_, to_] = m;
  const tzNorm = tz.replace(/([+-])(\d{2})(\d{2})$/, '$1$2:$3');
  return { ts: `${date}T${time}${tzNorm}`, iface, from: from_, to: to_, eid };
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHub Contents API
// ─────────────────────────────────────────────────────────────────────────────

async function loadRepoData(env) {
  const indexFile = await githubGetFile(env, 'data/index.json');
  const index     = JSON.parse(fromBase64(indexFile.content));
  const dataPath  = `data/${index.current}`;
  const dataFile  = await githubGetFile(env, dataPath);
  const data      = JSON.parse(fromBase64(dataFile.content));
  return { index, indexSha: indexFile.sha, data, dataSha: dataFile.sha, dataPath };
}

async function githubGetFile(env, path) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}?ref=${BRANCH}`,
    { headers: githubHeaders(env) },
  );
  if (!res.ok) throw new Error(`GitHub GET ${path}: ${res.status}`);
  return res.json(); // { content: base64, sha, ... }
}

async function commitFile(env, path, content, sha, message) {
  const body = {
    message,
    content: toBase64(JSON.stringify(content)),
    branch: BRANCH,
  };
  if (sha != null) body.sha = sha; // omit sha when creating a new file

  const res = await fetch(
    `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${path}`,
    {
      method: 'PUT',
      headers: githubHeaders(env),
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub PUT ${path}: ${res.status} — ${text}`);
  }
  const json = await res.json();
  return json.content.sha;
}

function githubHeaders(env) {
  return {
    Authorization:  `Bearer ${env.GITHUB_TOKEN}`,
    Accept:         'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent':   'zatecka-poller/1.0',
  };
}

async function rotateDataFile(env, index, indexSha) {
  const cur = index.current;
  const m   = cur.match(/^(events-)(\d+)(\.json)$/);
  if (!m) { console.error('Unexpected data filename format:', cur); return; }

  const num     = Number(m[2]) + 1;
  const newName = `${m[1]}${String(num).padStart(3, '0')}${m[3]}`;
  const newData = {
    meta:   { created: new Date().toISOString().slice(0, 10), version: 1, file_index: num },
    events: [],
  };

  // Create new (empty) events file — no sha needed
  await commitFile(env, `data/${newName}`, newData, null,
    `data: rotate to ${newName} [skip ci]`);

  // Update index to point to the new file
  index.files.push(newName);
  index.current = newName;
  await commitFile(env, 'data/index.json', index, indexSha,
    `data: update index → ${newName} [skip ci]`);

  console.log(`Rotated data file → ${newName}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Base64 utilities (Unicode-safe, handles GitHub API base64 with embedded newlines)
// ─────────────────────────────────────────────────────────────────────────────

function toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function decodeBase64Url(b64url) {
  return fromBase64(b64url.replace(/-/g, '+').replace(/_/g, '/'));
}
