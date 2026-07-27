'use strict';

const $ = (s) => document.querySelector(s);
const moneyShort = (cents) => {
  const d = cents / 100;
  return '$' + (Number.isInteger(d) ? d : d.toFixed(2));
};
const TIER_ORDER = ['basic', 'premium', 'exclusive'];
const TIER_LABEL = { basic: 'Basic', premium: 'Premium', exclusive: 'Exclusive' };

let CONFIG = null;
let card = null;
let selectedTier = 'premium';
let paid = false;
let appliedCode = null;   // validated discount code string
let appliedPct  = 0;      // discount percentage (e.g. 10)

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms || 3200);
}

function showError(msg) {
  const e = $('#pay-error');
  if (!msg) { e.hidden = true; e.textContent = ''; return; }
  e.hidden = false;
  e.textContent = msg;
}

function tierFromUrl() {
  const seg = location.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (TIER_ORDER.includes(seg)) return seg;
  const t = new URLSearchParams(location.search).get('tier');
  return t && TIER_ORDER.includes(t) ? t : null;
}

function codeFromUrl() {
  const c = new URLSearchParams(location.search).get('code');
  return c ? c.toUpperCase().trim() : null;
}

function baseAmountCents() {
  const p = CONFIG && CONFIG.products[selectedTier];
  return p ? p.amount : 0;
}

function finalAmountCents() {
  const base = baseAmountCents();
  if (!appliedCode || !appliedPct) return base;
  return Math.round(base * (1 - appliedPct / 100));
}

function updatePriceDisplay() {
  const base  = baseAmountCents();
  const final = finalAmountCents();
  const amtEl = $('#order-amount');
  const btnEl = $('#pay-btn-text');

  if (appliedCode && final < base) {
    amtEl.innerHTML =
      `<span style="text-decoration:line-through;opacity:0.45;font-size:0.75em;">${moneyShort(base)}</span> ` +
      `<span style="color:var(--accent-bright)">${moneyShort(final)}</span>`;
  } else {
    amtEl.textContent = moneyShort(final);
  }
  if (btnEl) btnEl.textContent = `Pay ${moneyShort(final)}`;
}

// --- Discount code UI ---
async function applyCode(code) {
  const statusEl = $('#disc-status');
  const inputEl  = $('#disc-input');
  if (!code) return;

  statusEl.textContent = 'Checking…';
  statusEl.className = 'disc-status checking';

  try {
    const res  = await fetch('/api/validate-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.ok && data.valid) {
      appliedCode = code.toUpperCase();
      appliedPct  = data.pct;
      statusEl.textContent = `✓ ${data.description} applied`;
      statusEl.className = 'disc-status success';
      if (inputEl) { inputEl.value = appliedCode; inputEl.disabled = true; }
      const applyBtn = $('#disc-apply');
      if (applyBtn) { applyBtn.textContent = 'Applied'; applyBtn.disabled = true; }
      updatePriceDisplay();
    } else {
      appliedCode = null; appliedPct = 0;
      statusEl.textContent = data.message || 'Invalid code.';
      statusEl.className = 'disc-status error';
    }
  } catch (e) {
    statusEl.textContent = 'Could not check code. Try again.';
    statusEl.className = 'disc-status error';
  }
}

function initDiscountUI() {
  const applyBtn = $('#disc-apply');
  const inputEl  = $('#disc-input');
  if (!applyBtn || !inputEl) return;

  applyBtn.addEventListener('click', () => applyCode(inputEl.value.trim()));
  inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyCode(inputEl.value.trim()); });

  // Pre-fill from URL param and auto-apply
  const urlCode = codeFromUrl();
  if (urlCode) {
    inputEl.value = urlCode;
    setTimeout(() => applyCode(urlCode), 600); // slight delay so config loads first
  }
}

// --- Square SDK ---
function loadSquareSdk(env) {
  return new Promise((resolve, reject) => {
    const src = env === 'production'
      ? 'https://web.squarecdn.com/v1/square.js'
      : 'https://sandbox.web.squarecdn.com/v1/square.js';
    const s = document.createElement('script');
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error('payment SDK failed to load'));
    document.head.appendChild(s);
  });
}

function buildPaymentRequest(payments) {
  return payments.paymentRequest({
    countryCode: 'US',
    currencyCode: 'USD',
    total: { amount: (finalAmountCents() / 100).toFixed(2), label: 'Total' },
  });
}

async function charge(sourceId, verificationToken) {
  showError('');
  const res = await fetch('/api/charge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tier: selectedTier,
      sourceId,
      buyerVerificationToken: verificationToken,
      discountCode: appliedCode || undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.ok) { showSuccess(); return true; }
  showError(data.message || 'Payment could not be completed. Try another card.');
  return false;
}

function showSuccess(link) {
  paid = true;
  const resolvedLink = link || (CONFIG && CONFIG.tierLinks && CONFIG.tierLinks[selectedTier]) || '';
  const a = $('#join-link');
  if (resolvedLink) {
    a.href = resolvedLink;
  } else {
    a.textContent = 'Message the admin to get added';
    a.href = (CONFIG && CONFIG.links && CONFIG.links.admin) || 'https://t.me/cynski';
  }
  // Persist so reload still shows success
  try {
    localStorage.setItem('mg_access', JSON.stringify({
      tier: selectedTier,
      link: resolvedLink,
      ts: Date.now(),
    }));
  } catch (e) {}
  $('#checkout-card').hidden = true;
  $('#success-card').hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function tokenizeWallet(method, label) {
  let result;
  try { result = await method.tokenize(); } catch (err) {
    showError(`${label} couldn't start${err && err.message ? ' — ' + err.message : '.'}`);
    return;
  }
  if (result.status === 'OK') {
    await charge(result.token, result.details && result.details.verificationToken);
  } else if (result.status !== 'Cancel') {
    showError((result.errors && result.errors[0] && result.errors[0].message) || `${label} was not completed.`);
  }
}

async function initWallets(payments) {
  const container = $('#wallet-container');
  let any = false;
  try {
    const pr = buildPaymentRequest(payments);
    const googlePay = await payments.googlePay(pr);
    const el = document.createElement('div');
    el.id = 'gpay-btn'; el.className = 'wallet-btn';
    container.appendChild(el);
    await googlePay.attach('#gpay-btn', { buttonColor: 'white', buttonType: 'long', buttonSizeMode: 'fill' });
    el.addEventListener('click', async (e) => { e.preventDefault(); await tokenizeWallet(googlePay, 'Google Pay'); });
    any = true;
  } catch (e) { console.warn('[wallet] google pay unavailable', e && e.message); }

  try {
    const pr = buildPaymentRequest(payments);
    const applePay = await payments.applePay(pr);
    const btn = document.createElement('button');
    btn.id = 'applepay-btn'; btn.className = 'apple-pay-button';
    btn.setAttribute('aria-label', 'Pay with Apple Pay');
    container.appendChild(btn);
    btn.addEventListener('click', async (e) => { e.preventDefault(); await tokenizeWallet(applePay, 'Apple Pay'); });
    any = true;
  } catch (e) { console.warn('[wallet] apple pay unavailable', e && e.message); }

  if (any) $('#wallet-sep').hidden = false;
}

async function initCard(payments) {
  const style = {
    input: { color: '#ffffff', fontSize: '16px' },
    'input::placeholder': { color: '#6b7280' },
    '.input-container': { borderColor: 'rgba(255,255,255,0.14)', borderRadius: '12px' },
    '.input-container.is-focus': { borderColor: '#a855f7' },
    '.input-container.is-error': { borderColor: '#ef4444' },
    '.message-text.is-error': { color: '#fca5a5' },
  };
  try { card = await payments.card({ style }); } catch (e) { card = await payments.card(); }
  await card.attach('#card-container');
  $('#card-status').hidden = true;
  $('#pay-btn').disabled = false;
}

async function payWithCard() {
  if (!card || paid) return;
  const btn = $('#pay-btn');
  showError('');
  btn.disabled = true;
  const label = $('#pay-btn-text').textContent;
  $('#pay-btn-text').textContent = 'Processing…';
  try {
    const result = await card.tokenize();
    if (result.status !== 'OK') {
      showError((result.errors && result.errors[0] && result.errors[0].message) || 'Please check your card details.');
      return;
    }
    await charge(result.token);
  } catch (e) {
    console.error('[pay] error', e);
    showError('Network error — please try again.');
  } finally {
    if (!paid) { btn.disabled = false; $('#pay-btn-text').textContent = label; }
  }
}

async function initPayments() {
  if (!CONFIG.squareEmbedReady || !CONFIG.squareAppId || !CONFIG.squareLocationId) {
    $('#card-status').textContent = 'Checkout is being set up — please try again shortly.';
    $('#pay-btn').disabled = true;
    return;
  }
  try {
    await loadSquareSdk(CONFIG.squareEnv);
    if (!window.Square) throw new Error('SDK unavailable');
    const payments = window.Square.payments(CONFIG.squareAppId, CONFIG.squareLocationId);
    await initWallets(payments);
    await initCard(payments);
  } catch (err) {
    console.error('[checkout] init failed', err);
    $('#card-status').textContent = 'Checkout failed to load. Refresh the page or message the admin.';
    $('#pay-btn').disabled = true;
  }
}

async function boot() {
  // ── Restore success state from localStorage (survives reload) ──
  try {
    const saved = localStorage.getItem('mg_access');
    if (saved) {
      const { tier, link } = JSON.parse(saved);
      if (link) {
        selectedTier = tier || 'basic';
        showSuccess(link);
        return; // skip loading Square entirely
      }
    }
  } catch (e) {}

  try { CONFIG = await (await fetch('/api/config')).json(); } catch (e) { showError('Could not load checkout. Refresh the page.'); return; }

  selectedTier =
    tierFromUrl() ||
    (CONFIG.products.premium ? 'premium' : TIER_ORDER.find((k) => CONFIG.products[k])) ||
    'basic';

  const p = CONFIG.products[selectedTier];
  $('#order-tier').textContent = TIER_LABEL[selectedTier] || selectedTier;
  $('#order-amount').textContent = p ? moneyShort(p.amount) : '—';
  $('#pay-btn-text').textContent  = p ? `Pay ${moneyShort(p.amount)}` : 'Pay';
  $('#pay-btn').addEventListener('click', payWithCard);

  initDiscountUI();
  await initPayments();
}

boot();
