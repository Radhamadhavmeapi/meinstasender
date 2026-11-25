// Fills prices, the free limit and the install link from the server.
(async () => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  try {
    const [prod, cfg] = await Promise.all([fetch('/v1/products').then((r) => r.json()), fetch('/api/u/config').then((r) => r.json())]);
    if (cfg.extensionUrl) {
      const b = document.getElementById('installBtn');
      b.href = cfg.extensionUrl;
      b.target = '_blank';
      b.rel = 'noopener';
    }
    if (cfg.freeDailyLimit) document.querySelectorAll('[data-free-limit]').forEach((e) => (e.textContent = cfg.freeDailyLimit));
    if (cfg.supportEmail) {
      const s = document.getElementById('supportLink');
      s.href = 'mailto:' + cfg.supportEmail;
      s.hidden = false;
    }
    const box = document.getElementById('plans');
    for (const p of prod.products || []) {
      const per = p.kind === 'subscription' ? `/ ${p.interval || 'month'}` : p.kind === 'pass' ? 'one time' : '';
      const el = document.createElement('article');
      el.className = 'plan' + (p.code === 'pro_month' ? ' featured' : '');
      el.innerHTML = `<h3>${esc(p.name)}</h3><p class="price">${esc(p.price)} <small>${esc(per)}</small></p>
        ${p.priceUsd ? `<p class="usd">or ${esc(p.priceUsd)} by PayPal</p>` : ''}
        <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        <a class="btn ${p.code === 'pro_month' ? 'primary' : ''}" href="/users/#buy=${encodeURIComponent(p.code)}">Choose ${esc(p.name)}</a>`;
      box.appendChild(el);
    }
  } catch (_) { /* page still works with the static free plan */ }
})();
