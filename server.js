'use strict';
/**
 * MONKEYGOD — landing + checkout server (hosted on Railway).
 *
 * Config/secrets live in a Cloudflare R2 bucket (default "monkeygod") at
 * data/config.json. THIS server reads that file at runtime (short cache) via the
 * R2 S3 API, so the crypto addresses / links can be changed in
 * the bucket without redeploying Railway. If no R2 creds are set, it falls back
 * to the matching environment variables (handy for local dev).
 *
 * Payment model (digital goods, manual fulfilment via Telegram):
 *   - Card  -> handled off-site by mycheckout.live. Buyers leave with a tier key
 *             (mg_basic / mg_premium / mg_exclusive); that host owns the Square
 *             credentials, the charge, and post-payment link delivery. No Square
 *             call exists in this file and no tier name ever reaches Square.
 *   - Crypto -> wallet addresses shown on-page; customer DMs admin the TXID.
 * There is NO PayPal path anywhere by design.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
// ---------------------------------------------------------------------------
// Tiny .env loader (avoids a dotenv dependency). Real env vars win over .env.
// ---------------------------------------------------------------------------
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) {
    console.warn('[env] could not read .env:', e.message);
  }
})();
const PORT = parseInt(process.env.PORT || '4000', 10);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
// Single-domain setup: monkeygod.fun. The old .cloud payment host is retired —
// card payments leave the site entirely for mycheckout.live.
const MAIN_SITE_URL = (process.env.MAIN_SITE_URL || 'https://monkeygod.fun').replace(/\/$/, '');
const PREVIEW_BASE_URL = (process.env.PREVIEW_BASE_URL || '').replace(/\/$/, '');
// ---------------------------------------------------------------------------
// Product catalog — SERVER is the source of truth for prices (never trust the
// client). Amounts are in cents (USD).
// ---------------------------------------------------------------------------
const PRODUCTS = {
  basic: { id: 'basic', name: 'MONKEYGOD — BASIC', amount: 1999 },
  premium: { id: 'premium', name: 'MONKEYGOD — PREMIUM', amount: 2999 },
  exclusive: { id: 'exclusive', name: 'MONKEYGOD — EXCLUSIVE', amount: 4999 },
  // Unlisted bundle — deliberately NOT in TIER_ORDER on the client, so it
  // never renders on the public tier grid. Only reachable by whoever has the
  // direct link to the hidden page. Every buyer gets the same invite link.
  tier2bundle: { id: 'tier2bundle', name: 'MONKEYGOD — TIER 2 BUNDLE', amount: 1000 },
};
// ── mycheckout.live ──────────────────────────────────────────────────────────
// All card payments are handled off-site by mycheckout.live. It owns the Square
// credentials, the real charge amount, and the post-payment link delivery, so
// nothing here ever talks to Square and no tier name can reach it from this box.
const CHECKOUT_URL = (process.env.CHECKOUT_URL || 'https://mycheckout.live').replace(/\/$/, '');
const CHECKOUT_RETURN = (process.env.CHECKOUT_RETURN || 'monkeygod.fun').replace(/^https?:\/\//, '').replace(/\/$/, '');
const CHECKOUT_TIERS = {
  basic:       'mg_basic',
  premium:     'mg_premium',
  exclusive:   'mg_exclusive',
  tier2bundle: 'mg_tier2bundle',
};

// Invite link every tier2bundle buyer gets immediately after paying.
// Override via BUNDLE_INVITE_URL env var if it ever needs to change.
// No invite link default here — a hardcoded fallback is how a private channel
// ends up in a public git history. Must come from env or the R2 config.
const BUNDLE_INVITE_URL = process.env.BUNDLE_INVITE_URL || '';

// ---------------------------------------------------------------------------
// Cloudflare R2 (S3 API) — where the live config/secrets live.
// ---------------------------------------------------------------------------
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_BUCKET = process.env.R2_BUCKET || 'monkeygod';
const R2_CONFIG_KEY = process.env.R2_CONFIG_KEY || 'data/config.json';
const R2_OVERRIDE_KEY = process.env.R2_OVERRIDE_KEY || 'data/override.html';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_READY = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
const CONFIG_TTL_MS = parseInt(process.env.CONFIG_TTL_MS || '30000', 10);
const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
// ---------------------------------------------------------------------------
// Claim tokens — signed proof-of-payment so tier links are never exposed in
// the public /api/config endpoint. A token is generated server-side after a
// successful charge and embedded in the redirect URL. /api/claim verifies the
// token and returns the link. Tokens are valid for 30 days.
// ---------------------------------------------------------------------------
const CLAIM_SECRET = process.env.CLAIM_SECRET || (() => {
  console.warn('[claim] CLAIM_SECRET env var not set — using a random secret. Set CLAIM_SECRET in Railway so tokens survive restarts.');
  return crypto.randomBytes(32).toString('hex');
})();
function generateClaimToken(tier, paymentId) {
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600; // 30 days
  const payload = `${tier}.${exp}.${paymentId || 'noid'}`;
  const sig = crypto.createHmac('sha256', CLAIM_SECRET).update(payload).digest('base64url');
  return Buffer.from(payload).toString('base64url') + '.' + sig;
}
function verifyClaimToken(token) {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const encodedPayload = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const payload = Buffer.from(encodedPayload, 'base64url').toString();
    const parts = payload.split('.');
    if (parts.length < 3) return null;
    const [tier, expStr] = parts;
    if (!PRODUCTS[tier]) return null;
    if (Math.floor(Date.now() / 1000) > parseInt(expStr, 10)) return null;
    const expectedSig = crypto.createHmac('sha256', CLAIM_SECRET).update(payload).digest('base64url');
    const a = Buffer.from(sig.padEnd(expectedSig.length));
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return tier;
  } catch (e) {
    return null;
  }
}
// Minimal AWS SigV4 GET of one object from the R2 S3 endpoint (region "auto").
// Returns the body text, or null if missing / not configured / on error.
async function r2GetObject(key) {
  if (!R2_READY) return null;
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const canonicalUri = '/' + R2_BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
  const region = 'auto';
  const service = 's3';
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const datestamp = amzdate.slice(0, 8);
  const payloadHash = sha256hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeadersStr = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['GET', canonicalUri, '', canonicalHeaders, signedHeadersStr, payloadHash].join('\n');
  const scope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + R2_SECRET_ACCESS_KEY, datestamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, ` +
    `SignedHeaders=${signedHeadersStr}, Signature=${signature}`;
  const res = await fetch(`https://${host}${canonicalUri}`, {
    headers: { Authorization: authorization, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzdate, host },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    console.warn('[r2] get failed', key, res.status);
    return null;
  }
  return res.text();
}
async function r2GetConfig() {
  const txt = await r2GetObject(R2_CONFIG_KEY);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (e) { console.warn('[r2] config.json is not valid JSON'); return null; }
}
// Emergency kill-switch: if data/override.html in the bucket is non-empty, that
// HTML replaces every page on the live site. Empty/missing = normal site.
let _ovHtml = null;
let _ovAt = 0;
async function loadOverride() {
  if (!R2_READY) return null;
  if (Date.now() - _ovAt < CONFIG_TTL_MS) return _ovHtml;
  try {
    const t = await r2GetObject(R2_OVERRIDE_KEY);
    _ovHtml = t && t.trim() ? t : null;
  } catch (e) { /* keep last known value */ }
  _ovAt = Date.now();
  return _ovHtml;
}
// Defaults pulled from env vars (used locally / as fallback when R2 isn't set).
function envDefaults() {
  return {
    crypto: [
      { coin: 'BTC', label: 'Bitcoin', address: process.env.CRYPTO_BTC || '' },
      { coin: 'ETH', label: 'Ethereum (ERC-20)', address: process.env.CRYPTO_ETH || '' },
      { coin: 'USDT', label: 'USDT (TRC-20)', address: process.env.CRYPTO_USDT_TRC20 || '' },
      { coin: 'LTC', label: 'Litecoin', address: process.env.CRYPTO_LTC || '' },
      { coin: 'SOL', label: 'Solana', address: process.env.CRYPTO_SOL || '' },
    ].filter((c) => c.address),
    links: {
      admin: process.env.TELEGRAM_ADMIN || 'https://t.me/youradmin',
      channel: process.env.TELEGRAM_CHANNEL || 'https://t.me/yourchannel',
      chatroom: process.env.TELEGRAM_CHATROOM || 'https://t.me/yourchatroom',
    },
    // Per-tier private invite links — kept server-side only, never sent to the
    // browser via /api/config. Exposed only through /api/claim with a valid token.
    tierLinks: {
      basic: process.env.TIER_LINK_BASIC || '',
      premium: process.env.TIER_LINK_PREMIUM || '',
      exclusive: process.env.TIER_LINK_EXCLUSIVE || '',
    },
    discordWebhook: process.env.DISCORD_WEBHOOK || '',
    googlePayEnabled: process.env.GOOGLE_PAY_ENABLED === 'true',
  };
}
// Merge the bucket config over the env defaults (bucket wins where it provides a
// value). Cached for CONFIG_TTL_MS so we don't hit R2 on every request.
let _cfgCache = null;
let _cfgAt = 0;
async function loadConfig() {
  if (_cfgCache && Date.now() - _cfgAt < CONFIG_TTL_MS) return _cfgCache;
  const base = envDefaults();
  try {
    const remote = await r2GetConfig();
    if (remote && typeof remote === 'object') {
      if (Array.isArray(remote.crypto)) {
        const c = remote.crypto.filter((x) => x && x.address);
        if (c.length) base.crypto = c;
      }
      if (remote.links && typeof remote.links === 'object') {
        for (const kk of Object.keys(remote.links)) if (remote.links[kk]) base.links[kk] = remote.links[kk];
      }
      if (remote.tierLinks && typeof remote.tierLinks === 'object') {
        for (const kk of Object.keys(remote.tierLinks)) if (remote.tierLinks[kk]) base.tierLinks[kk] = remote.tierLinks[kk];
      }
      if (remote.discordWebhook) base.discordWebhook = remote.discordWebhook;
      if (remote.googlePayEnabled === true) base.googlePayEnabled = true;
    }
  } catch (e) {
    console.warn('[config] using env fallback:', e.message);
  }
  _cfgCache = base;
  _cfgAt = Date.now();
  return base;
}
// Fire-and-forget Discord notification on a successful payment.
async function notifyDiscord(webhook, { product, amountCents, paymentId, status }) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'MONKEYGOD',
        embeds: [
          {
            title: '💸 Payment received',
            color: 0xa855f7,
            fields: [
              { name: 'Product', value: String(product || '—'), inline: true },
              { name: 'Amount', value: `$${(amountCents / 100).toFixed(2)}`, inline: true },
              { name: 'Status', value: String(status || 'COMPLETED'), inline: true },
              ...(paymentId ? [{ name: 'Payment ID', value: '`' + paymentId + '`', inline: false }] : []),
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch (e) {
    console.warn('[discord] notify failed', e.message);
  }
}
function listPreviews() {
  try {
    return fs
      .readdirSync(path.join(__dirname, 'public', 'previews'))
      .filter((f) => /\.(mp4|webm)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => (PREVIEW_BASE_URL ? `${PREVIEW_BASE_URL}/${f}` : `/previews/${f}`));
  } catch (e) {
    return [];
  }
}
const app = express();
app.use(express.json());
app.disable('x-powered-by');
// Emergency override: when data/override.html in the bucket is non-empty, serve
// it for every page route (APIs, assets and the Apple Pay file still work).
const isPageRoute = (p) => p === '/' || !/\.[a-z0-9]+$/i.test(p);
app.use(async (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/.well-known/')) return next();
  if (!isPageRoute(req.path)) return next();
  try {
    const ov = await loadOverride();
    if (ov) return res.set('cache-control', 'no-store').type('html').send(ov);
  } catch (e) { /* fall through to normal site */ }
  next();
});
// Public config the frontend needs to render (no secrets, no tier links).
// tierLinks are intentionally omitted — buyers get them via /api/claim with a
// valid signed token generated after a successful charge.
app.get('/api/config', async (req, res) => {
  const cfg = await loadConfig();
  res.json({
    products: PRODUCTS,
    previews: listPreviews(),
    crypto: cfg.crypto,
    links: cfg.links,
    checkoutUrl: CHECKOUT_URL,
    checkoutReturn: CHECKOUT_RETURN,
    checkoutTiers: CHECKOUT_TIERS,
    mainSiteUrl: MAIN_SITE_URL,
  });
});
// Claim a tier link using a signed token generated at charge time.
app.get('/api/claim', async (req, res) => {
  const token = (req.query.token || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing token.' });
  const tier = verifyClaimToken(token);
  if (!tier) return res.status(401).json({ error: 'Invalid or expired token. Contact the admin.' });
  const cfg = await loadConfig();

  // tier2bundle isn't in the R2/env tierLinks config — every buyer gets the
  // same fixed invite link, so it's handled here rather than in cfg.
  const link = tier === 'tier2bundle' ? BUNDLE_INVITE_URL : (cfg.tierLinks && cfg.tierLinks[tier]);
  if (!link) return res.status(404).json({ error: 'No link configured for this tier. Contact the admin.' });
  return res.json({ link, tier });
});
// Card payments live entirely at mycheckout.live — see CHECKOUT_TIERS above.
// The old /api/charge and /api/checkout routes were removed: both sent the
// product name to Square (note field, and line_items[].name), which is exactly
// what must never happen. There is no Square call left in this file.

// /pay and the monkeygod.cloud payment host are retired — pay.html hosted the
// on-site Square card form, which no longer has a backend. Anything still
// pointing at those paths is bounced to the tier grid.
app.get(['/pay', '/basic', '/premium', '/exclusive'], (req, res) => res.redirect(302, '/#tiers'));
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => {
  try {
    const filePath = path.join(__dirname, 'public', '.well-known', 'apple-developer-merchantid-domain-association');
    const raw = fs.readFileSync(filePath);
    // Strip any trailing whitespace/newline bytes that editors or git may have
    // silently appended — Apple Pay's verification requires byte-exact content.
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d || raw[end - 1] === 0x20)) end--;
    const clean = end < raw.length ? raw.slice(0, end) : raw;
    if (end < raw.length) {
      console.log(`[apple-pay] stripped ${raw.length - end} trailing byte(s) — serving ${end} bytes`);
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', clean.length);
    res.send(clean);
  } catch (e) {
    console.error('[apple-pay] domain association file missing:', e.message);
    res.status(404).send('Not found');
  }
});
// Success page — MUST be before express.static so this handler fires first.
// Verifies the signed claim token in ?t=, injects the tier into the HTML, then
// serves it. No valid token → redirect to home. Prevents free access via URL.
app.get('/success', (req, res) => {
  const token = (req.query.t || '').trim();
  const tier = token ? verifyClaimToken(token) : null;
  if (!tier) return res.redirect('/');
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'success.html'), 'utf8');
    const injected = html.replace(
      '</head>',
      `<script>window.__MG__={tier:${JSON.stringify(tier)}}</script></head>`
    );
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'text/html');
    res.send(injected);
  } catch (e) {
    console.error('[success] could not read success.html', e.message);
    res.redirect('/');
  }
});
// Unlisted bundle page — reachable ONLY by whoever has this exact URL. Not
// linked from index.html, pay.html, sitemap, or nav anywhere. Rename the
// slug (both here and the filename in /public) any time for a fresh link.
app.get('/vip-bundle-x7q2', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', 'vip-bundle-x7q2.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
// FIX: bind to 0.0.0.0 so Railway's proxy can reach the server on all interfaces.
app.listen(PORT, '0.0.0.0', async () => {
  const cfg = await loadConfig();
  console.log('');
  console.log('  MONKEYGOD running');
  console.log(`  Local:        ${PUBLIC_BASE_URL}  (landing: /  ·  payment: /pay)`);
  console.log(`  Main site:    ${MAIN_SITE_URL}`);
  console.log(`  Checkout:     ${CHECKOUT_URL}  (tiers: ${Object.values(CHECKOUT_TIERS).join(', ')})`);
  console.log(`  Config from:  ${R2_READY ? `R2 bucket "${R2_BUCKET}" (${R2_CONFIG_KEY})` : 'env vars (.env) — R2 not configured'}`);
  console.log(`  Crypto coins: ${cfg.crypto.length ? cfg.crypto.map((c) => c.coin).join(', ') : 'none set'}`);
  console.log(`  Claim tokens: ${CLAIM_SECRET.length > 10 ? 'CLAIM_SECRET set ✓' : 'WARNING — CLAIM_SECRET not set, tokens won\'t survive restarts'}`);
  console.log('');
});
