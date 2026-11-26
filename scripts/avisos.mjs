// Envia por email a lista de subscritores com pagamento a vencer (próximos N dias) ou em atraso.
// Corre na GitHub Action .github/workflows/avisos.yml — as credenciais vêm de GitHub Secrets.
import nodemailer from 'nodemailer';

const {
  SUPABASE_URL, SUPABASE_SECRET_KEY,
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
  EMAIL_TO, DIAS_AVISO = '30',
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.log('Secrets do Supabase em falta — nada a fazer.');
  process.exit(0);
}

const url = `${SUPABASE_URL}/rest/v1/subscribers_status?select=*&active=eq.true&order=payment_due_date`;
const res = await fetch(url, { headers: { apikey: SUPABASE_SECRET_KEY } });
if (!res.ok) {
  console.error('Erro Supabase', res.status, await res.text());
  process.exit(1);
}
const todos = await res.json();
const dias = Number(DIAS_AVISO);
const desligados = todos.filter((s) => s.days_left == null || s.days_left < 0);
const aVencer = todos.filter((s) => s.days_left >= 0 && s.days_left <= dias);

console.log(`Total: ${todos.length} · a vencer: ${aVencer.length} · desligados: ${desligados.length}`);

if (!aVencer.length && !desligados.length) {
  console.log('Nada a avisar esta semana.');
  process.exit(0);
}
if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_TO) {
  console.log('Secrets de email em falta — não envio email.');
  process.exit(0);
}

const eur = (v) => new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' }).format(Number(v) || 0);
const data = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const tabela = (lista) => `<table cellpadding="6" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px">
  <tr style="background:#f2f4f7;text-align:left"><th>ID</th><th>Owner</th><th>Type</th><th>HW</th><th>Value</th><th>Payment Due</th><th>Dias</th></tr>
  ${lista.map((s) => `<tr style="border-top:1px solid #e4e7ec"><td><b>${esc(s.code)}</b></td><td>${esc(s.owner)}</td><td>${esc(s.type)}</td><td>${esc(s.hw)}</td>
    <td style="text-align:right">${eur(s.value)}</td><td>${data(s.payment_due_date)}</td><td style="text-align:right">${s.days_left ?? '—'}</td></tr>`).join('')}
</table>`;

const soma = (l) => eur(l.reduce((t, s) => t + Number(s.value || 0), 0));
const html = `<div style="font-family:Arial,sans-serif;color:#1c2430">
  <h2 style="margin:0 0 12px">Avenças — resumo semanal</h2>
  ${desligados.length ? `<h3 style="color:#b42318">Desligados (${desligados.length} · ${soma(desligados)})</h3>${tabela(desligados)}` : ''}
  ${aVencer.length ? `<h3 style="color:#a15c00">A vencer nos próximos ${dias} dias (${aVencer.length} · ${soma(aVencer)})</h3>${tabela(aVencer)}` : ''}
</div>`;

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT) || 465,
  secure: (Number(SMTP_PORT) || 465) === 465,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

await transporter.sendMail({
  from: SMTP_USER,
  to: EMAIL_TO,
  subject: `Avenças: ${aVencer.length} a vencer, ${desligados.length} desligados`,
  html,
});
console.log('Email enviado para', EMAIL_TO);
