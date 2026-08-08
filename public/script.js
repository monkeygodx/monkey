'use strict';

/* Display data per product (server stays the source of truth for prices). */
const TIER_DATA = {
  basic: {
    name: 'Basic',
    tag: '',
    features: [
      { t: 'Access 1000+ Videos', in: true },
      { t: 'Fresh Content', in: true },
      { t: 'High Quality Videos', in: true },
      { t: 'HD Audio (With Sound)', in: false },
    ],
  },
  premium: {
    name: 'Premium',
    tag: '',
    features: [
      { t: 'Access 5,000+ Videos', in: true },
      { t: 'Exclusive Content & Early Access', in: true },
      { t: 'Fresh Content & Updates', in: true },
      { t: 'High Quality Videos', in: true },
    ],
  },
  exclusive: {
    name: 'Exclusive',
    tag: '★ HIGHEST TIER',
    featured: true,
    features: [
      { t: 'Access 10,000+ Videos', in: true },
      { t: 'Extra Omegle Wins Channel', in: true },
      { t: 'High Quality Videos', in: true },
      { t: 'Lifetime Access', in: true },
    ],
  },
};
const TIER_ORDER = ['basic', 'premium', 'exclusive'];

let CONFIG = null;
const $ = (s) => document.querySelector(s);
const moneyShort = (cents) => {
  const d = cents / 100;
  return '$' + (Number.isInteger(d) ? d : d.toFixed(2));
};

function toast(msg, ms) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms || 3200);
}

async function boot() {
  try {
    CONFIG = await (await fetch('/api/config')).json();
  } catch (e) {
    console.error('config failed', e);
    return;
  }
  $('#btn-channel').href = CONFIG.links.channel;
  $('#btn-chatroom').href = CONFIG.links.chatroom;
  $('#btn-admin').href = CONFIG.links.admin;
  $('#cr-admin').href = CONFIG.links.admin;

  buildSlider(CONFIG.previews || []);
  renderTiers();
  wireCryptoModal();
  wireFaq();
  animateMembers();
  wireCtaBtn();
}

/* ---------------- preview slider (coverflow) ---------------- */
let slideEls = [];
let videos = [];
let slideIdx = 0;
let slideMuted = true;

function buildSlider(urls) {
  const slider = $('#preview-slider');
  const track = $('#ps-track');
  const dots = $('#ps-dots');
  slider.hidden = false;
  track.innerHTML = '';
  dots.innerHTML = '';

  /* No real videos yet — show 3 clean placeholder slides */
  if (!urls.length) {
    slider.classList.add('placeholder-mode');
    const PLACEHOLDERS = 3;
    for (let i = 0; i < PLACEHOLDERS; i++) {
      const slide = document.createElement('div');
      slide.className = 'ps-slide ps-placeholder' + (i === 1 ? ' active' : '');
      track.appendChild(slide);
      const dot = document.createElement('button');
      dot.className = 'ps-dot' + (i === 1 ? ' active' : '');
      dot.addEventListener('click', () => goSlide(i));
      dots.appendChild(dot);
    }
    slideEls = [...track.querySelectorAll('.ps-slide')];
    $('#ps-prev').addEventListener('click', () => goSlide(slideIdx - 1));
    $('#ps-next').addEventListener('click', () => goSlide(slideIdx + 1));
    slideIdx = 1;
    window.addEventListener('resize', centerActive);
    setTimeout(centerActive, 60);
    return;
  }

  urls.forEach((u, i) => {
    const slide = document.createElement('div');
    slide.className = 'ps-slide';
    const v = document.createElement('video');
    v.src = u;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = i === 0 ? 'auto' : 'metadata';
    slide.appendChild(v);
    track.appendChild(slide);
    slide.addEventListener('click', () => {
      ensureUnmute();
      if (i === slideIdx) v.play().catch(() => {});
      else goSlide(i);
    });

    const dot = document.createElement('button');
    dot.className = 'ps-dot' + (i === 0 ? ' active' : '');
    dot.addEventListener('click', () => { ensureUnmute(); goSlide(i); });
    dots.appendChild(dot);
  });

  slideEls = [...track.querySelectorAll('.ps-slide')];
  videos = [...track.querySelectorAll('video')];

  $('#ps-prev').addEventListener('click', () => { ensureUnmute(); goSlide(slideIdx - 1); });
  $('#ps-next').addEventListener('click', () => { ensureUnmute(); goSlide(slideIdx + 1); });
  $('#ps-mute').addEventListener('click', toggleMute);

  // swipe
  let sx = null;
  const vp = slider.querySelector('.ps-viewport');
  vp.addEventListener('touchstart', (e) => (sx = e.touches[0].clientX), { passive: true });
  vp.addEventListener('touchend', (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx;
    if (Math.abs(dx) > 40) { ensureUnmute(); goSlide(dx < 0 ? slideIdx + 1 : slideIdx - 1); }
    sx = null;
  });

  window.addEventListener('resize', centerActive);
  goSlide(0);
  if (videos[0]) videos[0].addEventListener('loadeddata', centerActive, { once: true });
  setTimeout(centerActive, 60);
}

function centerActive() {
  if (!slideEls.length) return;
  const vp = $('#preview-slider').querySelector('.ps-viewport');
  const el = slideEls[slideIdx];
  const x = el.offsetLeft + el.offsetWidth / 2;
  $('#ps-track').style.transform = `translateX(${Math.round(vp.clientWidth / 2 - x)}px)`;
}

function goSlide(n) {
  if (!slideEls.length) return;
  slideIdx = (n + slideEls.length) % slideEls.length;
  slideEls.forEach((el, i) => el.classList.toggle('active', i === slideIdx));
  $('#ps-dots').querySelectorAll('.ps-dot').forEach((d, i) => d.classList.toggle('active', i === slideIdx));
  videos.forEach((v, i) => {
    if (Math.abs(i - slideIdx) <= 1) v.preload = 'auto';
    if (i === slideIdx) { v.muted = slideMuted; v.play().catch(() => {}); }
    else v.pause();
  });
  centerActive();
}

function ensureUnmute() {
  if (!slideMuted) return;
  slideMuted = false;
  videos.forEach((v) => (v.muted = false));
  const m = $('#ps-mute');
  if (m) m.textContent = '🔊';
  if (videos[slideIdx]) videos[slideIdx].play().catch(() => {});
}

function toggleMute() {
  if (slideMuted) {
    ensureUnmute();
  } else {
    slideMuted = true;
    videos.forEach((v) => (v.muted = true));
    $('#ps-mute').textContent = '🔇';
  }
}

/* ---------------- tiers ---------------- */
function renderTiers() {
  const grid = $('#tier-grid');
  grid.innerHTML = '';
  for (const key of TIER_ORDER) {
    const p = CONFIG.products[key];
    const d = TIER_DATA[key];
    if (!p || !d) continue;
    const card = document.createElement('div');
    card.className = 'tier-card' + (d.featured ? ' featured' : '');
    const price = moneyShort(p.amount);
    const badge    = d.featured ? '<div class="tier-badge">Most Popular</div>' : '';
    const callout  = d.featured ? '<div class="tier-callout">★ The tier most members go with</div>' : '';
    const btnCls   = d.featured ? 'tier-btn tier-btn-featured' : 'tier-btn';
    const btnLabel = d.featured ? `Unlock Everything — ${price} →` : `Get ${d.name} Access →`;
    const footnote = d.featured ? 'Instant · no subscription · best value' : 'Instant · no subscription';
    card.innerHTML = `
      ${badge}
      <div class="tier-name">${d.name}</div>
      <div class="tier-price-row">
        <span class="tier-price">${price}</span>
        <span class="tier-onetime">one-time</span>
      </div>
      <div class="tier-divider"></div>
      ${callout}
      <ul class="tier-features">
        ${d.features.map((f) => `
          <li class="${f.in ? '' : 'no'}">
            <span class="check-icon">${f.in ? '✓' : '✕'}</span>${f.t}
          </li>`).join('')}
      </ul>
      <div class="tier-card-footer">
        <button class="${btnCls}" data-tier="${key}">${btnLabel}</button>
        <div class="tier-footnote">${footnote}</div>
        <button class="tier-crypto" data-crypto="${key}">or pay with crypto</button>
      </div>`;
    grid.appendChild(card);
  }
  grid.querySelectorAll('.tier-btn').forEach((b) => b.addEventListener('click', () => buy(b.dataset.tier, b)));
  grid.querySelectorAll('.tier-crypto').forEach((b) => b.addEventListener('click', () => openCrypto(b.dataset.crypto)));
}

/* Wire the bottom CTA button to the exclusive tier. */
function wireCtaBtn() {
  const btn = $('#cta-exclusive-btn');
  if (!btn) return;
  btn.addEventListener('click', () => buy('exclusive', btn));
}

function buy(tier, btn) {
  if (!CONFIG.products[tier]) return;
  if (btn) { btn.disabled = true; btn.innerHTML = 'Loading…'; }
  const base = CONFIG.paymentSiteUrl;
  window.location.href = base
    ? `${base.replace(/\/$/, '')}/${encodeURIComponent(tier)}`
    : `/pay?tier=${encodeURIComponent(tier)}`;
}

/* ---------------- crypto modal ---------------- */
function openCrypto(tier) {
  const p = CONFIG.products[tier];
  if (!p) return;
  $('#cr-amount').textContent = moneyShort(p.amount);
  $('#cr-product').textContent = p.name;

  const list = $('#crypto-list');
  list.innerHTML = '';
  if (!CONFIG.crypto.length) {
    list.innerHTML =
      '<div class="crypto-empty">Wallet addresses aren\'t published yet.<br>Tap "DM Admin" below and they\'ll send you the current address.</div>';
  } else {
    for (const c of CONFIG.crypto) {
      const row = document.createElement('div');
      row.className = 'crypto-row';
      row.innerHTML = `
        <div class="crypto-row-top">
          <div class="crypto-coin">${c.coin}<small>${c.label}</small></div>
          <button class="crypto-copy" data-addr="${c.address}">Copy</button>
        </div>
        <div class="crypto-addr">${c.address}</div>`;
      list.appendChild(row);
    }
    list.querySelectorAll('.crypto-copy').forEach((b) =>
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.dataset.addr); toast('Address copied ✓'); }
        catch { toast('Copy failed — select manually'); }
      })
    );
  }
  show('#crypto-modal');
}

/* ---------------- modal plumbing ---------------- */
function show(sel) { $(sel).hidden = false; document.body.style.overflow = 'hidden'; }
function hide(sel) { $(sel).hidden = true; document.body.style.overflow = ''; }

function wireCryptoModal() {
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => hide('#crypto-modal')));
  const overlay = $('#crypto-modal');
  overlay.addEventListener('click', (e) => { if (e.target === overlay) hide('#crypto-modal'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide('#crypto-modal'); });
}

/* ---------------- faq ---------------- */
function wireFaq() {
  document.querySelectorAll('.faq-item').forEach((item) => {
    const q = item.querySelector('.faq-question');
    const a = item.querySelector('.faq-answer');
    q.addEventListener('click', () => {
      const open = item.classList.toggle('open');
      a.style.maxHeight = open ? a.scrollHeight + 'px' : '0';
    });
  });
}

/* ---------------- members counter (cosmetic) ---------------- */
function animateMembers() {
  const el = $('#members-count');
  let n = 1204;
  setInterval(() => {
    n += Math.floor(Math.random() * 5) - 2;
    if (n < 1180) n = 1180;
    el.textContent = n.toLocaleString() + ' members online';
  }, 4000);
}

boot();
