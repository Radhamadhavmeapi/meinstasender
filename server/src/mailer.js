// Optional SMTP mail (password reset, payment notices). Without SMTP_HOST every send is a logged no-op.
const nodemailer = require('nodemailer');

function createMailer(cfg, { log = console.log } = {}) {
  if (!cfg.host) {
    return { enabled: false, async send({ to, subject }) { log(`[mail disabled] to=${to} subject=${subject}`); return false; } };
  }
  const transport = nodemailer.createTransport({
    host: cfg.host, port: cfg.port || 587, secure: (cfg.port || 587) === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  return {
    enabled: true,
    async send({ to, subject, text }) {
      try {
        await transport.sendMail({ from: cfg.from || cfg.user, to, subject, text });
        return true;
      } catch (e) {
        log(`[mail] failed to=${to}: ${e.message}`);
        return false;
      }
    },
  };
}

module.exports = { createMailer };
