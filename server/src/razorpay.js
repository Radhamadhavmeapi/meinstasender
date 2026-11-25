// Minimal Razorpay client: subscriptions, payment links, webhook signature check.
const crypto = require('crypto');

const API = 'https://api.razorpay.com/v1';

function createClient({ keyId, keySecret, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

  async function call(method, pathname, body) {
    const res = await fetchImpl(API + pathname, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      const msg = json?.error?.description || text.slice(0, 200) || `http_${res.status}`;
      const e = new Error(`razorpay: ${msg}`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  return {
    // Recurring PRO. total_count = number of billing cycles Razorpay will attempt.
    createSubscription({ planId, totalCount, notes }) {
      return call('POST', '/subscriptions', {
        plan_id: planId,
        total_count: totalCount,
        customer_notify: 1,
        notes,
      });
    },
    cancelSubscription(id) {
      return call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: 0 });
    },
    // One-time purchase (24h pass etc.).
    createPaymentLink({ amount, currency, description, notes, referenceId, callbackUrl }) {
      const body = {
        amount, currency, description, notes,
        reference_id: referenceId,
        reminder_enable: false,
      };
      if (callbackUrl) { body.callback_url = callbackUrl; body.callback_method = 'get'; }
      return call('POST', '/payment_links', body);
    },
  };
}

function verifyWebhook(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createClient, verifyWebhook };
