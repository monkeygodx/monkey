'use strict';

/* Display data per product (server stays the source of truth for prices). */
const TIER_DATA = {
  basic: {
    name: 'Basic',
    tag: null,
    desc: 'Entry-level access to get started.',
    features: [
      { t: 'Access 1,000+ Videos' },
      { t: 'Fresh Content' },
      { t: 'High Quality Videos' },
      { t: 'Lifetime Channel Access' },
    ],
  },
  premium: {
    name: 'Premium',
    tag: 'MOST POPULAR',
    popular: true,
    desc: 'The tier most members choose.',
    features: [
      { t: 'Access 5,000+ Videos' },
      { t: 'Exclusive Content & Early Access' },
      { t: 'Fresh Content & Updates' },
      { t: 'Higher Quality Videos' },
      { t: 'Lifetime Channel Access' },
    ],
  },
  exclusive: {
    name: 'Exclusive',
    tag: 'ALL ACCESS',
    ultimate: true,
    desc: 'Everything. Every category. No limits.',
    features: [
      { t: 'Access 10,000+ Videos' },
      { t: 'Extra Omegle Wins Channel' },
      { t: 'Every Category Unlocked' },
      { t: 'Highest Quality + Sound' },
      { t: 'Lifetime Access' },
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
  $('#btn-admin').href   = CONFIG.links.admin;
  $('#cr-admin').href    = CONFIG.links.admin;

  buildSlider([
    '/assets/preview9.mp4',
    '/assets/preview10.mp4',
    '/assets/preview8.mp4',
    '/assets/preview3.mp4',
    '/assets/preview6.mp4',
    '/assets/preview2.mp4',
    '/assets/preview5.mp4',
    '/assets/preview7.mp4',
    '/assets/preview4.mp4',
  ]);

  renderTiers();
  wireFaq();
  animateMembers();
  wireCtaBtn();
}

/* ---------------- preview slider (clean square, one-at-a-time) ---------------- */
let slideIdx  = 0;
let slideMuted = true;
let mgxVideos = [];
let mgxDots   = [];

/* Inject CSS once — nukes old coverflow styles, installs the square layout */
(function injectSliderCSS() {
  if (document.getElementById('mgx-css')) return;
  document.head.insertAdjacentHTML('beforeend', `<style id="mgx-css">
/* kill old coverflow elements */
.ps-viewport,.ps-track,.ps-slide,.ps-mute{display:none!important}
.ps-inner{padding:0!important}
/* wrap keeps arrows outside the square */
.mgx-wrap{position:relative;max-width:600px;margin:0 auto;padding:0 52px;box-sizing:border-box}
.mgx-stage{position:relative!important;overflow:hidden!important;border-radius:18px!important;width:100%!important;aspect-ratio:16/9!important;border:1px solid rgba(168,85,247,.8);box-shadow:0 0 15px rgba(168,85,247,.25),0 0 35px rgba(168,85,247,.12);background:#0a0a0a;font-size:0;line-height:0}
/* All videos fill the fixed-ratio stage — opacity drives visibility, not position */
.mgx-stage video{display:block!important;width:100%!important;height:100%!important;position:absolute!important;top:0!important;left:0!important;object-fit:contain!important;object-position:center!important;transform:none!important;zoom:1!important;margin:0!important;padding:0!important;border:0!important;max-width:none!important;max-height:none!important;min-width:0!important;min-height:0!important;opacity:0;transition:opacity .35s ease;pointer-events:none!important}
/* Active: same absolute flow — stage size comes from aspect-ratio, not video intrinsic height */
.mgx-stage video.mgx-active{opacity:1!important;pointer-events:auto!important}
/* mute lives inside the square, bottom-right corner */
.mgx-mute{position:absolute;bottom:12px;right:12px;z-index:10;background:rgba(0,0,0,.55);border:none;border-radius:50%;width:36px;height:36px;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);color:#fff;line-height:1}
/* arrows flank the stage */
.ps-arrow{position:absolute;top:50%;transform:translateY(-50%);z-index:10;background:rgba(0,0,0,.5);border:none;border-radius:50%;width:38px;height:38px;font-size:22px;color:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);transition:background .2s}
.ps-arrow:hover{background:rgba(80,0,180,.7)}
.ps-prev{left:4px}.ps-next{right:4px}
/* dots sit directly below the wrap */
.ps-dots{display:flex;gap:6px;justify-content:center;margin-top:10px}
.ps-dot{width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.25);border:none;cursor:pointer;padding:0;transition:all .25s}
.ps-dot.active{background:linear-gradient(90deg,#c084fc,#a855f7);width:22px;border-radius:4px}
@media(max-width:560px){.mgx-wrap{padding:0 40px}}
@media(max-width:420px){.mgx-wrap{padding:0 36px}}
</style>`);
})();

function buildSlider(urls) {
  const slider = document.getElementById('preview-slider');
  const inner  = slider.querySelector('.ps-inner');
  slider.hidden = false;

  /* Wipe whatever the HTML shipped with */
  inner.innerHTML = '';

  if (!urls.length) return;

  /* Build DOM */
  const wrap = document.createElement('div');
  wrap.className = 'mgx-wrap';

  const stage = document.createElement('div');
  stage.id = 'mgx-stage';
  stage.className = 'mgx-stage';

  const btnPrev = document.createElement('button');
  btnPrev.className = 'ps-arrow ps-prev';
  btnPrev.id = 'ps-prev';
  btnPrev.setAttribute('aria-label', 'Previous');
  btnPrev.textContent = '‹';

  const btnNext = document.createElement('button');
  btnNext.className = 'ps-arrow ps-next';
  btnNext.id = 'ps-next';
  btnNext.setAttribute('aria-label', 'Next');
  btnNext.textContent = '›';

  const btnMute = document.createElement('button');
  btnMute.className = 'mgx-mute';
  btnMute.id = 'mgx-mute';
  btnMute.setAttribute('aria-label', 'Toggle sound');
  btnMute.textContent = '🔇';

  const dotsRow = document.createElement('div');
  dotsRow.className = 'ps-dots';
  dotsRow.id = 'ps-dots';

  /* Create videos + dots */
  mgxVideos = [];
  mgxDots   = [];
  slideIdx  = 0;

  urls.forEach((url, i) => {
    const v = document.createElement('video');
    v.src = url;
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.preload = 'auto';
    v.autoplay = true;
    if (i === 0) v.classList.add('mgx-active');

    stage.appendChild(v);
    mgxVideos.push(v);

    const dot = document.createElement('button');
    dot.className = 'ps-dot' + (i === 0 ? ' active' : '');
    dot.setAttribute('aria-label', 'Preview ' + (i + 1));
    dot.addEventListener('click', () => mgxGo(i));
    dotsRow.appendChild(dot);
    mgxDots.push(dot);
  });

  /* Mute button goes last inside stage so it layers on top */
  stage.appendChild(btnMute);

  wrap.appendChild(btnPrev);
  wrap.appendChild(stage);
  wrap.appendChild(btnNext);
  inner.appendChild(wrap);
  inner.appendChild(dotsRow);

  /* Wire arrows */
  btnPrev.addEventListener('click', () => mgxGo(slideIdx - 1));
  btnNext.addEventListener('click', () => mgxGo(slideIdx + 1));

  /* Wire mute */
  btnMute.addEventListener('click', mgxToggleMute);

  /* Touch swipe */
  let swipeX = null;
  stage.addEventListener('touchstart', (e) => { swipeX = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', (e) => {
    if (swipeX === null) return;
    const dx = e.changedTouches[0].clientX - swipeX;
    if (Math.abs(dx) > 40) mgxGo(dx < 0 ? slideIdx + 1 : slideIdx - 1);
    swipeX = null;
  });

  /* Attempt autoplay on all — browsers may silently block non-visible ones */
  mgxVideos.forEach((v) => v.play().catch(() => {}));
}

function mgxGo(n) {
  if (!mgxVideos.length) return;
  const from = slideIdx;
  slideIdx = (n + mgxVideos.length) % mgxVideos.length;
  if (from === slideIdx) return;

  mgxVideos[from].classList.remove('mgx-active');
  mgxVideos[slideIdx].classList.add('mgx-active');
  mgxVideos[from].pause();
  mgxVideos[slideIdx].muted = slideMuted;
  mgxVideos[slideIdx].play().catch(() => {});

  mgxDots.forEach((d, i) => d.classList.toggle('active', i === slideIdx));
}

function mgxToggleMute() {
  slideMuted = !slideMuted;
  mgxVideos.forEach((v) => { v.muted = slideMuted; });
  const m = document.getElementById('mgx-mute');
  if (m) m.textContent = slideMuted ? '🔇' : '🔊';
  if (!slideMuted && mgxVideos[slideIdx]) mgxVideos[slideIdx].play().catch(() => {});
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
    let cls = 'tier-card';
    if (d.popular)  cls += ' popular';
    if (d.ultimate) cls += ' ultimate';
    card.className = cls;
    const price = moneyShort(p.amount);
    let topLabel = '';
    if (d.popular)  topLabel = '<div class="tier-popular-label">Most popular</div>';
    if (d.ultimate) topLabel = '<div class="tier-ultimate-label">All access</div>';
    const desc = d.desc ? `<p class="tier-desc">${d.desc}</p>` : '';
    let btnCls = 'tier-btn';
    if (d.popular)  btnCls += ' tier-btn-popular';
    if (d.ultimate) btnCls += ' tier-btn-ultimate';
    const btnLabel = d.popular
      ? `Get ${d.name} — ${price} →`
      : `Get ${d.name} Access`;
    const footnote = 'One-time · instant · no subscription';
    card.innerHTML = `
      ${topLabel}
      <div class="tier-name">${d.name.toUpperCase()}</div>
      <div class="tier-price-row">
        <span class="tier-price">${price}</span>
        <span class="tier-onetime">one-time</span>
      </div>
      ${desc}
      <div class="tier-divider"></div>
      <ul class="tier-features">
        ${d.features.map((f) => `
          <li>
            <span class="check-icon">✓</span>${f.t}
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
  $('#cr-amount').textContent  = moneyShort(p.amount);
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
function hide(sel) { $(sel).hidden = true;  document.body.style.overflow = ''; }

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

/* ---------------- scroll reveal ---------------- */
function initReveal() {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (e.isIntersecting) {
        e.target.classList.add('visible');
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.07 });
  document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
}

boot();
initReveal();
wireCryptoModal();
