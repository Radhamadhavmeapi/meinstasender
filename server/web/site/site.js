// Landing page: live prices, currency toggle, reseller calculator, hero mock, thread replay.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
  $('#year').textContent = new Date().getFullYear();

  // ---------- currency toggle ----------
  let cur = 'inr';
  function paintCurrency() {
    $$('.seg [data-cur]').forEach((b) => b.classList.toggle('on', b.dataset.cur === cur));
    $$('[data-inr]').forEach((e) => (e.hidden = cur !== 'inr'));
    $$('[data-usd]').forEach((e) => (e.hidden = cur !== 'usd'));
  }
  $$('.seg [data-cur]').forEach((b) => (b.onclick = () => { cur = b.dataset.cur; paintCurrency(); }));

  // ---------- reseller calculator ----------
  let perCredit = 250; // replaced by the best live credit-pack price
  let creditsPerMonth = 1;
  function calc() {
    const n = +$('#rClients').value, price = +$('#rPrice').value;
    const cost = n * creditsPerMonth * perCredit;
    $('#cClients').textContent = n;
    $('#cPrice').textContent = inr(price);
    $('#cCost').textContent = inr(cost);
    $('#cPer').textContent = `at ${inr(perCredit)} per credit`;
    const profit = n * price - cost;
    $('#cProfit').textContent = (profit < 0 ? '−' : '') + inr(Math.abs(profit));
  }
  $('#rClients').oninput = calc;
  $('#rPrice').oninput = calc;
  calc();

  // ---------- live data ----------
  (async () => {
    try {
      const [prod, cfg] = await Promise.all([fetch('/v1/products').then((r) => r.json()), fetch('/api/u/config').then((r) => r.json())]);
      if (cfg.extensionUrl) Object.assign($('#installBtn'), { href: cfg.extensionUrl, target: '_blank', rel: 'noopener' });
      if (cfg.supportEmail) Object.assign($('#supportLink'), { href: 'mailto:' + cfg.supportEmail, hidden: false });
      if (cfg.freeDailyLimit) $$('[data-free-limit]').forEach((e) => (e.textContent = cfg.freeDailyLimit));
      if (cfg.creditsPerMonth) creditsPerMonth = cfg.creditsPerMonth;
      if (cfg.bestCreditPaise) perCredit = cfg.bestCreditPaise / 100;
      calc();

      const box = $('#plans');
      for (const p of prod.products || []) {
        const per = p.kind === 'subscription' ? `/ ${p.interval || 'month'}` : p.kind === 'pass' ? 'one time' : '';
        const featured = p.code === 'pro_month';
        const el = document.createElement('article');
        el.className = 'plan' + (featured ? ' featured' : '');
        el.innerHTML = `${featured ? '<span class="badge">Most popular</span>' : ''}<h3>${esc(p.name)}</h3>
          <p class="price"><span data-inr>${esc(p.price)}</span><span data-usd hidden>${esc(p.priceUsd || '—')}</span> <small>${esc(per)}</small></p>
          <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
          <a class="btn ${featured ? 'primary' : ''}" href="/users/#buy=${encodeURIComponent(p.code)}">Choose ${esc(p.name)}</a>`;
        box.appendChild(el);
      }
      paintCurrency();
    } catch (_) { /* static free plan still shows */ }
  })();

  // ---------- hero mock: one gentle countdown ----------
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce) {
    let s = 38, sent = 7;
    const t = setInterval(() => {
      s -= 1;
      if (s <= 0) {
        sent += 1; s = 30 + Math.floor(Math.random() * 30);
        $('#mockCount').textContent = sent;
        $('#mockBar').style.width = Math.min(100, (sent / 40) * 100) + '%';
        if (sent >= 12) clearInterval(t);
      }
      $('#mockSecs').textContent = s;
    }, 1000);
  }

  // ---------- safety thread plays once when scrolled into view ----------
  const thread = $('.thread');
  if (thread && 'IntersectionObserver' in window && !reduce) {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { thread.classList.add('play'); io.disconnect(); } }, { threshold: 0.3 });
    io.observe(thread);
  } else thread?.classList.add('play');
})();
