'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

// ---------------------------------------------------------------------------
// Tiny .env loader
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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (e) { console.warn('[env] could not read .env:', e.message); }
})();

const PORT = parseInt(process.env.PORT || '4000', 10);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PAYMENT_HOST = (process.env.PAYMENT_HOST || 'monkeygod.cloud').toLowerCase();
const PAYMENT_SITE_URL = (process.env.PAYMENT_SITE_URL || 'https://monkeygod.cloud').replace(/\/$/, '');
const MAIN_SITE_URL = (process.env.MAIN_SITE_URL || 'https://monkeygod.fun').replace(/\/$/, '');
const PREVIEW_BASE_URL = (process.env.PREVIEW_BASE_URL || '').replace(/\/$/, '');

// ---------------------------------------------------------------------------
// Product catalog — server is source of truth for prices (cents USD).
// ---------------------------------------------------------------------------
const PRODUCTS = {
  basic:     { id: 'basic',     name: 'MONKEYGOD — BASIC',     amount: 2900 },
  premium:   { id: 'premium',   name: 'MONKEYGOD — PREMIUM',   amount: 4900 },
  exclusive: { id: 'exclusive', name: 'MONKEYGOD — EXCLUSIVE', amount: 7900 },
};

// ---------------------------------------------------------------------------
// Discount codes — add more here as needed.
// ---------------------------------------------------------------------------
const DISCOUNT_CODES = {
  FUN: { pct: 10, description: '10% off' },
};

// Track which fingerprints have used each code (in-memory; resets on redeploy).
// fingerprint = first 16 chars of SHA-256(ip|ua)
const usedCodeFingerprints = new Map(); // Map<code, Set<fingerprint>>

function clientFingerprint(req) {
  const ip = req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
  const ua = (req.headers && req.headers['user-agent']) || '';
  return crypto.createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 16);
}

function hasUsedCode(code, fp) {
  const s = usedCodeFingerprints.get(code);
  return s ? s.has(fp) : false;
}

function markCodeUsed(code, fp) {
  if (!usedCodeFingerprints.has(code)) usedCodeFingerprints.set(code, new Set());
  usedCodeFingerprints.get(code).add(fp);
}

function applyDiscountCents(amountCents, code) {
  const d = DISCOUNT_CODES[code && code.toUpperCase()];
  if (!d) return amountCents;
  return Math.round(amountCents * (1 - d.pct / 100));
}

// ---------------------------------------------------------------------------
// Cloudflare R2 (S3 API)
// ---------------------------------------------------------------------------
const R2_ACCOUNT_ID      = process.env.R2_ACCOUNT_ID || '';
const R2_BUCKET          = process.env.R2_BUCKET || 'monkeygod';
const R2_CONFIG_KEY      = process.env.R2_CONFIG_KEY || 'data/config.json';
const R2_OVERRIDE_KEY    = process.env.R2_OVERRIDE_KEY || 'data/override.html';
const R2_ACCESS_KEY_ID   = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_READY = Boolean(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY);
const CONFIG_TTL_MS = parseInt(process.env.CONFIG_TTL_MS || '30000', 10);

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();

async function r2GetObject(key) {
  if (!R2_READY) return null;
  const host = `${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const canonicalUri = '/' + R2_BUCKET + '/' + key.split('/').map(encodeURIComponent).join('/');
  const region = 'auto', service = 's3';
  const amzdate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const datestamp = amzdate.slice(0, 8);
  const payloadHash = sha256hex('');
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzdate}\n`;
  const signedHeadersStr = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = ['GET', canonicalUri, '', canonicalHeaders, signedHeadersStr, payloadHash].join('\n');
  const scope = `${datestamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzdate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + R2_SECRET_ACCESS_KEY, datestamp);
  k = hmac(k, region); k = hmac(k, service); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${R2_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeadersStr}, Signature=${signature}`;
  const res = await fetch(`https://${host}${canonicalUri}`, {
    headers: { Authorization: authorization, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzdate, host },
  });
  if (res.status === 404) return null;
  if (!res.ok) { console.warn('[r2] get failed', key, res.status); return null; }
  return res.text();
}

async function r2GetConfig() {
  const txt = await r2GetObject(R2_CONFIG_KEY);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (e) { console.warn('[r2] config.json is not valid JSON'); return null; }
}

let _ovHtml = null, _ovAt = 0;
async function loadOverride() {
  if (!R2_READY) return null;
  if (Date.now() - _ovAt < CONFIG_TTL_MS) return _ovHtml;
  try { const t = await r2GetObject(R2_OVERRIDE_KEY); _ovHtml = t && t.trim() ? t : null; } catch (e) {}
  _ovAt = Date.now();
  return _ovHtml;
}

function envDefaults() {
  return {
    square: {
      env: (process.env.SQUARE_ENV || 'sandbox').toLowerCase(),
      accessToken: process.env.SQUARE_ACCESS_TOKEN || '',
      locationId:  process.env.SQUARE_LOCATION_ID  || '',
      appId:       process.env.SQUARE_APP_ID        || '',
      version:     process.env.SQUARE_VERSION       || '',
    },
    crypto: [
      { coin: 'BTC',  label: 'Bitcoin',         address: process.env.CRYPTO_BTC         || '' },
      { coin: 'ETH',  label: 'Ethereum (ERC-20)',address: process.env.CRYPTO_ETH         || '' },
      { coin: 'USDT', label: 'USDT (TRC-20)',    address: process.env.CRYPTO_USDT_TRC20  || '' },
      { coin: 'LTC',  label: 'Litecoin',         address: process.env.CRYPTO_LTC         || '' },
      { coin: 'SOL',  label: 'Solana',           address: process.env.CRYPTO_SOL         || '' },
    ].filter((c) => c.address),
    links: {
      admin:    process.env.TELEGRAM_ADMIN    || 'https://t.me/youradmin',
      channel:  process.env.TELEGRAM_CHANNEL  || 'https://t.me/yourchannel',
      chatroom: process.env.TELEGRAM_CHATROOM || 'https://t.me/yourchatroom',
    },
    tierLinks: {
      basic:     process.env.TIER_LINK_BASIC     || '',
      premium:   process.env.TIER_LINK_PREMIUM   || '',
      exclusive: process.env.TIER_LINK_EXCLUSIVE || '',
    },
    discordWebhook: process.env.DISCORD_WEBHOOK || '',
  };
}

let _cfgCache = null, _cfgAt = 0;
async function loadConfig() {
  if (_cfgCache && Date.now() - _cfgAt < CONFIG_TTL_MS) return _cfgCache;
  const base = envDefaults();
  try {
    const remote = await r2GetConfig();
    if (remote && typeof remote === 'object') {
      const rs = remote.square || {};
      base.square = {
        env:         (rs.env || base.square.env).toLowerCase(),
        accessToken: rs.accessToken || base.square.accessToken,
        locationId:  rs.locationId  || base.square.locationId,
        appId:       rs.appId       || base.square.appId,
        version:     rs.version     || base.square.version,
      };
      if (Array.isArray(remote.crypto)) { const c = remote.crypto.filter((x) => x && x.address); if (c.length) base.crypto = c; }
      if (remote.links && typeof remote.links === 'object') for (const kk of Object.keys(remote.links)) if (remote.links[kk]) base.links[kk] = remote.links[kk];
      if (remote.tierLinks && typeof remote.tierLinks === 'object') for (const kk of Object.keys(remote.tierLinks)) if (remote.tierLinks[kk]) base.tierLinks[kk] = remote.tierLinks[kk];
      if (remote.discordWebhook) base.discordWebhook = remote.discordWebhook;
    }
  } catch (e) { console.warn('[config] using env fallback:', e.message); }
  _cfgCache = base; _cfgAt = Date.now();
  return base;
}

function squareCtx(cfg) {
  const sq = cfg.square || {};
  const apiBase = sq.env === 'production' ? 'https://connect.squareup.com' : 'https://connect.squareupsandbox.com';
  const ready = Boolean(sq.accessToken && sq.locationId);
  const embedReady = Boolean(ready && sq.appId);
  return { sq, apiBase, ready, embedReady };
}

async function notifyDiscord(webhook, { product, amountCents, paymentId, status, discountCode }) {
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'MONKEYGOD',
        embeds: [{
          title: '💸 Payment received',
          color: 0xa855f7,
          fields: [
            { name: 'Product', value: String(product || '—'), inline: true },
            { name: 'Amount',  value: `$${(amountCents / 100).toFixed(2)}`, inline: true },
            { name: 'Status',  value: String(status || 'COMPLETED'), inline: true },
            ...(discountCode ? [{ name: 'Discount', value: discountCode, inline: true }] : []),
            ...(paymentId ? [{ name: 'Payment ID', value: '`' + paymentId + '`', inline: false }] : []),
          ],
          timestamp: new Date().toISOString(),
        }],
      }),
    });
  } catch (e) { console.warn('[discord] notify failed', e.message); }
}

function listPreviews() {
  try {
    return fs.readdirSync(path.join(__dirname, 'public', 'previews'))
      .filter((f) => /\.(mp4|webm)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((f) => PREVIEW_BASE_URL ? `${PREVIEW_BASE_URL}/${f}` : `/previews/${f}`);
  } catch (e) { return []; }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // get real IP behind Railway / Cloudflare proxy
app.use(express.json());
app.disable('x-powered-by');

const isPageRoute = (p) => p === '/' || !/\.[a-z0-9]+$/i.test(p);
app.use(async (req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/.well-known/')) return next();
  if (!isPageRoute(req.path)) return next();
  try { const ov = await loadOverride(); if (ov) return res.set('cache-control', 'no-store').type('html').send(ov); } catch (e) {}
  next();
});

// Public config for the frontend.
app.get('/api/config', async (req, res) => {
  const cfg = await loadConfig();
  const { sq, ready, embedReady } = squareCtx(cfg);
  res.json({
    products: PRODUCTS,
    previews: listPreviews(),
    crypto: cfg.crypto,
    links: cfg.links,
    tierLinks: cfg.tierLinks,
    squareReady: ready,
    squareEmbedReady: embedReady,
    squareEnv: sq.env,
    squareAppId: sq.appId,
    squareLocationId: sq.locationId,
    paymentSiteUrl: PAYMENT_SITE_URL,
    mainSiteUrl: MAIN_SITE_URL,
    discountCodes: Object.fromEntries(
      Object.entries(DISCOUNT_CODES).map(([k, v]) => [k, { pct: v.pct, description: v.description }])
    ),
  });
});

// Validate a discount code (used by the checkout page before charging).
app.post('/api/validate-code', (req, res) => {
  const { code } = req.body || {};
  const codeUpper = (code || '').toUpperCase().trim();
  const disc = DISCOUNT_CODES[codeUpper];
  if (!disc) return res.status(400).json({ valid: false, message: 'Invalid code.' });
  const fp = clientFingerprint(req);
  if (hasUsedCode(codeUpper, fp)) return res.status(400).json({ valid: false, message: 'Code already used.' });
  return res.json({ valid: true, pct: disc.pct, description: disc.description });
});

// Embedded card charge.
app.post('/api/charge', async (req, res) => {
  try {
    const { tier, sourceId, buyerVerificationToken, discountCode } = req.body || {};
    const product = PRODUCTS[tier];
    if (!product) return res.status(400).json({ error: 'Unknown tier.' });
    if (!sourceId) return res.status(400).json({ error: 'Missing card token.' });

    const codeUpper = (discountCode || '').toUpperCase().trim();
    const fp = clientFingerprint(req);

    // Validate discount code if supplied.
    if (codeUpper) {
      const disc = DISCOUNT_CODES[codeUpper];
      if (!disc) return res.status(400).json({ error: 'invalid_code', message: 'Discount code is not valid.' });
      if (hasUsedCode(codeUpper, fp)) return res.status(400).json({ error: 'code_used', message: 'Discount code has already been used.' });
    }

    const finalAmount = codeUpper ? applyDiscountCents(product.amount, codeUpper) : product.amount;

    const cfg = await loadConfig();
    const { sq, apiBase, embedReady } = squareCtx(cfg);
    if (!embedReady) return res.status(503).json({ error: 'card_unconfigured', message: 'Card payments are not live yet. Pay with crypto or DM the admin.' });

    const body = {
      idempotency_key: crypto.randomUUID(),
      source_id: sourceId,
      location_id: sq.locationId,
      amount_money: { amount: finalAmount, currency: 'USD' },
      autocomplete: true,
      note: product.name + (codeUpper ? ` [${codeUpper}]` : ''),
    };
    if (buyerVerificationToken) body.verification_token = buyerVerificationToken;

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${sq.accessToken}` };
    if (sq.version) headers['Square-Version'] = sq.version;

    const sqRes = await fetch(`${apiBase}/v2/payments`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await sqRes.json().catch(() => ({}));

    if (!sqRes.ok) {
      console.error('[square] charge error', sqRes.status, JSON.stringify(data));
      const detail = data && data.errors && data.errors[0] ? data.errors[0].detail : 'Card was declined.';
      return res.status(402).json({ error: 'card_declined', message: detail });
    }

    // Mark code used only after confirmed successful charge.
    if (codeUpper && DISCOUNT_CODES[codeUpper]) markCodeUsed(codeUpper, fp);

    const payment = data && data.payment;
    notifyDiscord(cfg.discordWebhook, { product: product.name, amountCents: finalAmount, paymentId: payment && payment.id, status: payment && payment.status, discountCode: codeUpper || null });
    return res.json({ ok: true, paymentId: payment && payment.id, status: payment && payment.status, redirect: `/success?tier=${encodeURIComponent(tier)}` });
  } catch (err) {
    console.error('[charge] fatal', err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong taking the payment.' });
  }
});

// Hosted checkout link (fallback).
app.post('/api/checkout', async (req, res) => {
  try {
    const { tier } = req.body || {};
    const product = PRODUCTS[tier];
    if (!product) return res.status(400).json({ error: 'Unknown tier.' });
    const cfg = await loadConfig();
    const { sq, apiBase, ready } = squareCtx(cfg);
    if (!ready) return res.status(503).json({ error: 'card_unconfigured', message: 'Card checkout is not live yet. Pay with crypto or DM the admin.' });
    const body = {
      idempotency_key: crypto.randomUUID(),
      order: { location_id: sq.locationId, line_items: [{ name: product.name, quantity: '1', base_price_money: { amount: product.amount, currency: 'USD' } }] },
      checkout_options: { redirect_url: `${PUBLIC_BASE_URL}/success?tier=${encodeURIComponent(tier)}`, ask_for_shipping_address: false },
    };
    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${sq.accessToken}` };
    if (sq.version) headers['Square-Version'] = sq.version;
    const sqRes = await fetch(`${apiBase}/v2/online-checkout/payment-links`, { method: 'POST', headers, body: JSON.stringify(body) });
    const data = await sqRes.json().catch(() => ({}));
    if (!sqRes.ok) { const detail = data && data.errors && data.errors[0] ? data.errors[0].detail : 'Square rejected the request.'; return res.status(502).json({ error: 'square_error', message: detail }); }
    const url = data && data.payment_link && (data.payment_link.long_url || data.payment_link.url);
    if (!url) return res.status(502).json({ error: 'no_url', message: 'No checkout URL returned.' });
    return res.json({ url });
  } catch (err) {
    console.error('[checkout] fatal', err);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong creating the checkout.' });
  }
});

function isPaymentHost(req) {
  const host = (req.hostname || '').toLowerCase();
  return host === PAYMENT_HOST || host.endsWith('.cloud') || host.endsWith(PAYMENT_HOST);
}
app.get('/', (req, res, next) => { if (isPaymentHost(req)) return res.sendFile(path.join(__dirname, 'public', 'pay.html')); next(); });
app.get(['/pay', '/basic', '/premium', '/exclusive'], (req, res) => { res.sendFile(path.join(__dirname, 'public', 'pay.html')); });
app.get('/.well-known/apple-developer-merchantid-domain-association', (req, res) => { res.type('text/plain'); res.sendFile(path.join(__dirname, 'public', '.well-known', 'apple-developer-merchantid-domain-association')); });
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/success', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'success.html')); });

app.listen(PORT, async () => {
  const cfg = await loadConfig();
  const { sq, embedReady } = squareCtx(cfg);
  console.log('\n  MONKEYGOD running');
  console.log(`  Local:        ${PUBLIC_BASE_URL}`);
  console.log(`  Square card:  ${embedReady ? `EMBEDDED ready (${sq.env})` : 'NOT live'}`);
  console.log(`  Discount codes: ${Object.keys(DISCOUNT_CODES).join(', ')}\n`);
});
