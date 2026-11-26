import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY, DIAS_AVISO, HW_OPCOES } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------- estado
const S = {
  subs: [],
  sort: { campo: 'payment_due_date', asc: true },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- utilitários
const fmtEUR = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });
const eur = (v) => fmtEUR.format(Number(v) || 0);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtData = (iso) => (iso ? iso.split('-').reverse().join('/') : '—');
const isoUTC = (dt) => dt.toISOString().slice(0, 10);
const hojeISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Soma meses a uma data ISO, limitando ao último dia do mês (igual ao Postgres). */
function somaMeses(iso, meses) {
  const [y, m, d] = iso.split('-').map(Number);
  const total = (m - 1) + meses;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const ultimo = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return isoUTC(new Date(Date.UTC(ny, nm, Math.min(d, ultimo))));
}
const mesesDe = (p) => (p === 'anual' ? 12 : 6);
const proximoVenc = (iso, p) => somaMeses(iso, mesesDe(p));

const ESTADOS = { ativo: 'Ativo', a_terminar: 'A vencer', desligado: 'Desligado', cancelado: 'Cancelado' };
const badge = (e) => `<span class="badge ${e}">${ESTADOS[e] ?? e}</span>`;
const PER = { semestral: 'Semestral', anual: 'Anual' };
const titulo = (s) => s.owner ? `${s.code} · ${s.owner}` : s.code;

function textoDias(s) {
  if (s.status === 'cancelado') return '—';
  const d = s.days_left;
  if (d === null || d === undefined) return 'sem data';
  if (d === 0) return 'vence hoje';
  if (d < 0) return `há ${-d} dia${d === -1 ? '' : 's'}`;
  return `${d} dia${d === 1 ? '' : 's'}`;
}

function toast(msg, erro = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('erro', erro);
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), erro ? 6000 : 3000);
}

const unicos = (campo) => [...new Set(S.subs.map((s) => s[campo]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt'));

// ---------------------------------------------------------------- modal
function abrirModal(tit, html) {
  $('#modal-titulo').textContent = tit;
  $('#modal-corpo').innerHTML = html;
  $('#modal').classList.remove('hidden');
  return $('#modal-corpo');
}
const fecharModal = () => $('#modal').classList.add('hidden');
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.closest('[data-close]')) fecharModal();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fecharModal(); });

function confirmar(tit, texto, rotulo = 'Confirmar') {
  return new Promise((resolve) => {
    const corpo = abrirModal(tit, `<p>${texto}</p>
      <div class="row end"><button class="btn" data-r="0">Cancelar</button><button class="btn primary" data-r="1">${esc(rotulo)}</button></div>`);
    corpo.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (!b) return;
      fecharModal();
      resolve(b.dataset.r === '1');
    });
  });
}

// ---------------------------------------------------------------- auth
let carregado = false;
function mostrar(session) {
  $('#login-view').classList.toggle('hidden', !!session);
  $('#app-view').classList.toggle('hidden', !session);
  if (session) {
    $('#user-email').textContent = session.user.email;
    if (!carregado) { carregado = true; carregar(); }
  } else {
    carregado = false;
    S.subs = [];
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-erro').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
  if (error) $('#login-erro').textContent = 'Email ou password inválidos.';
});
$('#logout').addEventListener('click', () => sb.auth.signOut());

// ---------------------------------------------------------------- dados
async function carregar() {
  const { data: admin, error: eAdm } = await sb.rpc('is_admin');
  if (eAdm || !admin) {
    toast('Esta conta não tem acesso de administrador.', true);
    await sb.auth.signOut();
    $('#login-erro').textContent = 'Esta conta não tem acesso de administrador.';
    return;
  }
  const { data, error } = await sb.from('subscribers_status').select('*').order('payment_due_date');
  if (error) { toast('Erro a carregar: ' + error.message, true); return; }
  S.subs = data;
  preencherFiltros();
  renderPainel();
  renderLista();
}

function preencherFiltros() {
  for (const [id, campo, rot] of [['#f-owner', 'owner', 'Todos os owners'], ['#f-type', 'type', 'Todos os types'], ['#f-hw', 'hw', 'Todos os HW']]) {
    const sel = $(id);
    const atual = sel.value;
    sel.innerHTML = `<option value="">${rot}</option>` + unicos(campo).map((v) => `<option ${v === atual ? 'selected' : ''}>${esc(v)}</option>`).join('');
  }
}

// ---------------------------------------------------------------- tabs
$$('.tab').forEach((b) => b.addEventListener('click', () => {
  $$('.tab').forEach((x) => x.classList.toggle('active', x === b));
  $$('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + b.dataset.tab));
}));

// ---------------------------------------------------------------- painel
function renderPainel() {
  const cs = S.subs;
  const vivos = cs.filter((s) => s.status === 'ativo' || s.status === 'a_terminar');
  const aTerminar = cs.filter((s) => s.status === 'a_terminar').sort((a, b) => a.days_left - b.days_left);
  const desligados = cs.filter((s) => s.status === 'desligado').sort((a, b) => (b.days_left ?? -1e9) - (a.days_left ?? -1e9));
  const receita = vivos.reduce((t, s) => t + Number(s.value_year || 0), 0);
  const comissoes = vivos.reduce((t, s) => t + Number(s.commission_year || 0), 0);
  const soma = (arr) => arr.reduce((t, s) => t + Number(s.value || 0), 0);

  $('#kpis').innerHTML = `
    <div class="kpi"><div class="lbl">Subscritores ativos</div><div class="val">${vivos.length}</div>
      <div class="sub">${vivos.filter((s) => s.periodicity === 'semestral').length} semestrais · ${vivos.filter((s) => s.periodicity === 'anual').length} anuais</div></div>
    <div class="kpi"><div class="lbl">Receita anual recorrente</div><div class="val">${eur(receita)}</div>
      <div class="sub">comissões ${eur(comissoes)} · líquido ${eur(receita - comissoes)}</div></div>
    <div class="kpi warn"><div class="lbl">A vencer (${DIAS_AVISO} dias)</div><div class="val">${aTerminar.length}</div><div class="sub">${eur(soma(aTerminar))} a receber</div></div>
    <div class="kpi bad"><div class="lbl">Desligados</div><div class="val">${desligados.length}</div><div class="sub">sem pagamento em dia</div></div>`;

  $('#aviso-dias').textContent = `próximos ${DIAS_AVISO} dias`;
  const item = (s) => `<div class="item">
      <div class="who"><b data-editar="${s.id}">${esc(titulo(s))}</b><span>${[s.type, s.hw, PER[s.periodicity], eur(s.value)].filter(Boolean).map(esc).join(' · ')} · ${s.payment_due_date ? 'vence ' + fmtData(s.payment_due_date) : 'sem data de pagamento'}</span></div>
      <div class="dias">${textoDias(s)}</div>
      <button class="btn sm" data-renovar="${s.id}">Renovar</button></div>`;
  $('#lista-a-terminar').innerHTML = aTerminar.map(item).join('') || '<p class="vazio">Nada a vencer. 👌</p>';
  $('#lista-desligados').innerHTML = desligados.map(item).join('') || '<p class="vazio">Nenhum desligado.</p>';

  // Próximos 12 meses: valor a receber por mês (subscritores em vigor)
  const hoje = new Date();
  const meses = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    meses.push({ chave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, rot: d.toLocaleDateString('pt-PT', { month: 'short' }).replace('.', ''), v: 0 });
  }
  const limite = meses[11].chave;
  for (const s of vivos) {
    let venc = s.payment_due_date;
    if (!venc) continue;
    while (venc.slice(0, 7) <= limite) {
      const m = meses.find((x) => x.chave === venc.slice(0, 7));
      if (m) m.v += Number(s.value || 0);
      venc = proximoVenc(venc, s.periodicity);
    }
  }
  const max = Math.max(1, ...meses.map((m) => m.v));
  $('#meses').innerHTML = meses.map((m) => `<div class="mes" title="${m.rot}: ${eur(m.v)}">
      <span class="v">${m.v ? Math.round(m.v).toLocaleString('pt-PT') : ''}</span>
      <div class="barra" style="height:${(m.v / max) * 110}px"></div>
      <span class="m">${m.rot}</span></div>`).join('');
}

// ---------------------------------------------------------------- lista
function filtrados() {
  const q = $('#f-pesquisa').value.trim().toLowerCase();
  const est = $('#f-estado').value, ow = $('#f-owner').value, ty = $('#f-type').value, hw = $('#f-hw').value;
  const { campo, asc } = S.sort;
  const numericos = ['value', 'commission', 'days_left'];
  return S.subs
    .filter((s) => (!est || s.status === est) && (!ow || s.owner === ow) && (!ty || s.type === ty) && (!hw || s.hw === hw))
    .filter((s) => !q || [s.code, s.owner, s.type, s.hw, s.notes].some((v) => String(v ?? '').toLowerCase().includes(q)))
    .sort((a, b) => {
      let x = a[campo], y = b[campo];
      if (numericos.includes(campo)) { x = x ?? -1e9; y = y ?? -1e9; return (Number(x) - Number(y)) * (asc ? 1 : -1); }
      return String(x ?? '').localeCompare(String(y ?? ''), 'pt', { numeric: true }) * (asc ? 1 : -1);
    });
}

function renderLista() {
  const lista = filtrados();
  $('#tbody-clientes').innerHTML = lista.map((s) => `<tr>
      <td><span class="nome" data-editar="${s.id}">${esc(s.code)}</span></td>
      <td>${esc(s.owner || '')}</td>
      <td>${esc(s.type || '')}</td>
      <td>${esc(s.hw || '')}</td>
      <td>${PER[s.periodicity]}</td>
      <td class="num">${eur(s.value)}</td>
      <td class="num">${eur(s.commission)}</td>
      <td>${fmtData(s.last_payment_date)}</td>
      <td>${fmtData(s.payment_due_date)}</td>
      <td class="num">${s.status === 'cancelado' || s.days_left == null ? '—' : s.days_left}</td>
      <td>${badge(s.status)}</td>
      <td><div class="acoes"><button class="btn sm" data-renovar="${s.id}">Renovar</button><button class="btn sm ghost" data-editar="${s.id}">Editar</button></div></td>
    </tr>`).join('');
  $('#vazio-clientes').classList.toggle('hidden', lista.length > 0);
  $$('.tabela th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === S.sort.campo);
    th.classList.toggle('asc', th.dataset.sort === S.sort.campo && S.sort.asc);
  });
}

['#f-pesquisa', '#f-estado', '#f-owner', '#f-type', '#f-hw'].forEach((s) => $(s).addEventListener('input', renderLista));
$$('.tabela th[data-sort]').forEach((th) => th.addEventListener('click', () => {
  const campo = th.dataset.sort;
  S.sort = { campo, asc: S.sort.campo === campo ? !S.sort.asc : true };
  renderLista();
}));

document.addEventListener('click', (e) => {
  if (e.target.closest('#modal')) return;
  const r = e.target.closest('[data-renovar]');
  if (r) return abrirRenovar(r.dataset.renovar);
  const ed = e.target.closest('[data-editar]');
  if (ed) return abrirSub(ed.dataset.editar);
});
$('#btn-novo').addEventListener('click', () => abrirSub(null));

// ---------------------------------------------------------------- formulário
function campoHW(valor) {
  const opcoes = [...new Set([...HW_OPCOES, ...unicos('hw')])];
  if (!HW_OPCOES.length) {
    // Sem lista definida em config.js: texto com sugestões dos valores já usados
    return `<input name="hw" list="dl-hw" value="${esc(valor)}"><datalist id="dl-hw">${opcoes.map((o) => `<option value="${esc(o)}">`).join('')}</datalist>`;
  }
  if (valor && !opcoes.includes(valor)) opcoes.push(valor);
  return `<select name="hw"><option value="">—</option>${opcoes.map((o) => `<option ${o === valor ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
}
const datalist = (id, campo) => `<datalist id="${id}">${unicos(campo).map((o) => `<option value="${esc(o)}">`).join('')}</datalist>`;

async function abrirSub(id) {
  const s = id ? S.subs.find((x) => x.id === id) : null;
  const v = s ?? { periodicity: 'semestral', value: '', commission: '', payment_due_date: proximoVenc(hojeISO(), 'semestral'), last_payment_date: hojeISO(), active: true };

  const corpo = abrirModal(s ? titulo(s) : 'Novo subscritor', `
    <form class="form" id="form-sub">
      <label>ID *<input name="code" required value="${esc(v.code)}"></label>
      <label>Owner<input name="owner" list="dl-owner" value="${esc(v.owner)}">${datalist('dl-owner', 'owner')}</label>
      <label>Type<input name="type" list="dl-type" value="${esc(v.type)}">${datalist('dl-type', 'type')}</label>
      <label>HW${campoHW(v.hw)}</label>
      <label>Avença<select name="periodicity">
        <option value="semestral" ${v.periodicity === 'semestral' ? 'selected' : ''}>Semestral</option>
        <option value="anual" ${v.periodicity === 'anual' ? 'selected' : ''}>Anual</option></select></label>
      <span></span>
      <label>Value (€ por período)<input name="value" type="number" step="0.01" min="0" value="${esc(v.value)}"></label>
      <label>Commission (€ por período)<input name="commission" type="number" step="0.01" min="0" value="${esc(v.commission)}"></label>
      <label>Last Payment Date<input name="last_payment_date" type="date" value="${esc(v.last_payment_date)}"></label>
      <label>Payment Due Date<input name="payment_due_date" type="date" value="${esc(v.payment_due_date)}"></label>
      <label class="full">Notas<textarea name="notes">${esc(v.notes)}</textarea></label>
      ${s ? `<label class="check full"><input type="checkbox" name="cancelado" ${s.active ? '' : 'checked'}> Cancelado (deixa de contar e de aparecer nos avisos)</label>` : ''}
    </form>
    ${s ? '<h3>Histórico de pagamentos</h3><div id="historico" class="muted">A carregar…</div>' : ''}
    <div class="row">
      ${s ? '<button class="btn danger ghost" id="btn-apagar">Apagar</button>' : ''}
      <span class="spacer"></span>
      <button class="btn" data-close>Cancelar</button>
      <button class="btn primary" id="btn-guardar">Guardar</button>
    </div>`);

  const form = $('#form-sub', corpo);
  if (!s) {
    // Em subscritores novos, sugere o Payment Due a partir do Last Payment
    const sugerir = () => {
      if (form.last_payment_date.value) form.payment_due_date.value = proximoVenc(form.last_payment_date.value, form.periodicity.value);
    };
    form.last_payment_date.addEventListener('change', sugerir);
    form.periodicity.addEventListener('change', sugerir);
  }

  $('#btn-guardar', corpo).addEventListener('click', async () => {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    const t = (k) => (f.get(k) ?? '').toString().trim() || null;
    const reg = {
      code: t('code'),
      owner: t('owner'),
      type: t('type'),
      hw: t('hw'),
      periodicity: f.get('periodicity'),
      value: Number(f.get('value')) || 0,
      commission: Number(f.get('commission')) || 0,
      last_payment_date: t('last_payment_date'),
      payment_due_date: t('payment_due_date'),
      notes: t('notes'),
    };
    if (s) reg.active = !f.get('cancelado');
    const { error } = s ? await sb.from('subscribers').update(reg).eq('id', s.id) : await sb.from('subscribers').insert(reg);
    if (error) {
      const msg = error.code === '23505' ? `Já existe um subscritor com o ID "${reg.code}".` : error.message;
      return toast('Erro ao guardar: ' + msg, true);
    }
    fecharModal();
    toast(s ? 'Subscritor atualizado.' : 'Subscritor criado.');
    carregar();
  });

  if (!s) return;

  $('#btn-apagar', corpo).addEventListener('click', async () => {
    const ok = await confirmar('Apagar subscritor', `Apagar <b>${esc(titulo(s))}</b> e todo o histórico? Esta ação não pode ser desfeita.<br><span class="muted small">Se apenas deixou de pagar, marca-o como cancelado em vez de apagar.</span>`, 'Apagar');
    if (!ok) return abrirSub(id);
    const { error } = await sb.from('subscribers').delete().eq('id', s.id);
    if (error) return toast('Erro ao apagar: ' + error.message, true);
    toast('Subscritor apagado.');
    carregar();
  });

  const { data, error } = await sb.from('renewals').select('*').eq('subscriber_id', s.id).order('payment_date', { ascending: false });
  const h = $('#historico', corpo);
  if (!h) return;
  if (error) h.textContent = 'Erro a carregar o histórico.';
  else if (!data.length) h.textContent = 'Ainda sem pagamentos registados aqui.';
  else {
    h.classList.remove('muted');
    h.innerHTML = `<div class="scroll"><table class="tabela"><thead><tr><th>Data</th><th>Período</th><th class="num">Value</th><th class="num">Commission</th><th>Pago</th><th>Notas</th></tr></thead><tbody>
      ${data.map((r) => `<tr><td>${fmtData(r.payment_date)}</td><td>${fmtData(r.period_start)} → ${fmtData(r.period_end)}</td>
        <td class="num">${eur(r.value)}</td><td class="num">${eur(r.commission)}</td>
        <td>${r.paid ? 'Sim' : '<span class="badge a_terminar">Não</span>'}</td><td>${esc(r.notes || '')}</td></tr>`).join('')}
    </tbody></table></div>`;
  }
}

// ---------------------------------------------------------------- renovar
function abrirRenovar(id) {
  const s = S.subs.find((x) => x.id === id);
  if (!s) return;
  const hoje = hojeISO();
  // Desligado (sem data ou data passada) → novo período começa no dia do pagamento; senão mantém o ciclo
  const inicioAuto = () => (s.status === 'desligado' ? $('#form-renovar [name=payment_date]').value || hoje : s.payment_due_date);
  const corpo = abrirModal(`Renovar — ${titulo(s)}`, `
    <div class="info" id="renov-info"></div>
    <form class="form" id="form-renovar" style="margin-top:14px">
      <label class="full">Duração<select name="meses">
        <option value="">Período normal (${mesesDe(s.periodicity)} meses)</option>
        <option value="3">Reforço de 3 meses</option>
        <option value="1">Reforço de 1 mês</option></select></label>
      <label>Value (€)<input name="value" type="number" step="0.01" min="0" value="${esc(s.value)}"></label>
      <label>Commission (€)<input name="commission" type="number" step="0.01" min="0" value="${esc(s.commission)}"></label>
      <label>Data do pagamento<input name="payment_date" type="date" value="${hoje}"></label>
      <label>Início do novo período<input name="start" type="date" required></label>
      <label class="check full"><input type="checkbox" name="paid" checked> Já está pago</label>
      <label class="full">Notas<input name="notes" placeholder="Ex.: fatura, referência da transferência…"></label>
    </form>
    <div class="row end"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="btn-ok">Confirmar renovação</button></div>`);
  const form = $('#form-renovar', corpo);
  let startManual = false, valorManual = false;
  const meses = () => Number(form.meses.value) || mesesDe(s.periodicity);
  const atualizar = () => {
    if (!startManual) form.start.value = inicioAuto();
    const novo = form.start.value ? somaMeses(form.start.value, meses()) : null;
    const dur = form.meses.value ? `Reforço de <b>${meses()} ${meses() === 1 ? 'mês' : 'meses'}</b>` : `Avença <b>${PER[s.periodicity].toLowerCase()}</b>`;
    $('#renov-info', corpo).innerHTML = `${dur}. Payment Due: <b>${s.payment_due_date ? fmtData(s.payment_due_date) : 'sem data'}</b> → <b>${novo ? fmtData(novo) : '—'}</b>` +
      (s.status === 'desligado' ? '<br><span class="muted small">Está desligado, por isso o novo período começa na data do pagamento.</span>' : '');
    return novo;
  };
  form.start.addEventListener('change', () => { startManual = true; atualizar(); });
  // Valores proporcionais à duração escolhida (até serem editados à mão)
  const arred = (v) => Math.round(v * 100) / 100;
  form.value.addEventListener('input', () => { valorManual = true; });
  form.commission.addEventListener('input', () => { valorManual = true; });
  form.meses.addEventListener('change', () => {
    if (!valorManual) {
      const f = meses() / mesesDe(s.periodicity);
      form.value.value = arred(Number(s.value) * f);
      form.commission.value = arred(Number(s.commission) * f);
    }
    atualizar();
  });
  form.payment_date.addEventListener('change', atualizar);
  atualizar();

  $('#btn-ok', corpo).addEventListener('click', async (e) => {
    if (!form.reportValidity()) return;
    e.target.disabled = true;
    const f = new FormData(form);
    const novo = atualizar();
    const { error } = await sb.rpc('renew_subscriber', {
      p_id: s.id,
      p_value: Number(f.get('value')) || 0,
      p_commission: Number(f.get('commission')) || 0,
      p_paid: !!f.get('paid'),
      p_notes: f.get('notes').trim() || null,
      p_payment_date: f.get('payment_date') || null,
      p_start: f.get('start'),
      p_months: form.meses.value ? Number(form.meses.value) : null,
    });
    if (error) { e.target.disabled = false; return toast('Erro ao renovar: ' + error.message, true); }
    fecharModal();
    toast(`${s.code} renovado — próximo pagamento a ${fmtData(novo)}.`);
    carregar();
  });
}

// ---------------------------------------------------------------- exportar
$('#btn-exportar').addEventListener('click', () => {
  const cols = [
    ['ID', 'code'], ['PaymentDueDate', 'payment_due_date'], ['LastPaymentDate', 'last_payment_date'], ['Value', 'value'],
    ['Commission', 'commission'], ['Owner', 'owner'], ['Type', 'type'], ['HW', 'hw'], ['Periodicity', 'periodicity'],
    ['Status', 'status'], ['DaysLeft', 'days_left'], ['Notes', 'notes'],
  ];
  const cel = (v) => {
    const t = String(v ?? '');
    return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const val = (s, k) => (k === 'value' || k === 'commission') ? String(s[k]).replace('.', ',') : k.endsWith('_date') ? fmtData(s[k]).replace('—', '') : s[k];
  const linhas = [cols.map((c) => c[0]).join(';'), ...filtrados().map((s) => cols.map(([, k]) => cel(val(s, k))).join(';'))];
  const blob = new Blob(['﻿' + linhas.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `subscritores-${hojeISO()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------- importar
const CAMPOS = [
  { k: 'code', rot: 'ID *', sin: ['id', 'code', 'codigo', 'subscriber id', 'n'] },
  { k: 'payment_due_date', rot: 'PaymentDueDate', sin: ['paymentduedate', 'payment due date', 'due date', 'pagamento ate', 'vencimento', 'proximo pagamento', 'due'] },
  { k: 'last_payment_date', rot: 'LastPaymentDate', sin: ['lastpaymentdate', 'last payment date', 'last payment', 'ultimo pagamento', 'data pagamento'] },
  { k: 'value', rot: 'Value', sin: ['value', 'valor', 'valor semestre', 'amount', 'preco'] },
  { k: 'commission', rot: 'Commission', sin: ['comission', 'commission', 'comissao'] },
  { k: 'owner', rot: 'Owner', sin: ['owner', 'dono', 'cliente', 'nome', 'responsavel'] },
  { k: 'type', rot: 'Type', sin: ['type', 'tipo', 'categoria'] },
  { k: 'hw', rot: 'HW', sin: ['hw', 'hardware', 'equipamento'] },
  { k: 'periodicity', rot: 'Periodicidade', sin: ['periodicity', 'periodicidade', 'avenca', 'periodo', 'frequencia'] },
  { k: 'notes', rot: 'Notas', sin: ['notes', 'notas', 'observacoes', 'obs', 'comentarios'] },
];
const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

let IMP = { cab: [], linhas: [] };

// ---------- modelo / exemplo ----------
const MODELO_CAB = ['ID', 'PaymentDueDate', 'LastPaymentDate', 'Value', 'Comission', 'Owner', 'Type', 'HW', 'Periodicity', 'Notes'];
function modeloLinhas() {
  const h = hojeISO();
  const ultimo1 = somaMeses(h, -2), ultimo2 = somaMeses(h, -5);
  return [
    ['EXEMPLO-1', proximoVenc(ultimo1, 'semestral'), ultimo1, 120, 12, 'Ana Silva', 'Pro', HW_OPCOES[0] || 'Router X1', 'semestral', ''],
    ['EXEMPLO-2', proximoVenc(ultimo2, 'anual'), ultimo2, 300, 30, 'Rui Costa', 'Basic', HW_OPCOES[1] || HW_OPCOES[0] || 'Box X2', 'anual', 'Paga por transferência'],
  ];
}
const XLSX_URL = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs';

$('#tabela-exemplo').innerHTML = `<thead><tr>${MODELO_CAB.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
  <tbody>${modeloLinhas().map((l) => `<tr>${l.map((v, i) => `<td>${esc(i === 1 || i === 2 ? fmtData(v) : (i === 3 || i === 4) ? String(v).replace('.', ',') : v)}</td>`).join('')}</tr>`).join('')}</tbody>`;

$('#btn-modelo').addEventListener('click', async () => {
  try {
    const XLSX = await import(XLSX_URL);
    const toDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
    const dados = [MODELO_CAB, ...modeloLinhas().map((l) => l.map((v, i) => (i === 1 || i === 2) ? toDate(v) : v))];
    const ws = XLSX.utils.aoa_to_sheet(dados, { cellDates: true, dateNF: 'dd/mm/yyyy' });
    ws['!cols'] = [10, 16, 16, 10, 12, 18, 14, 16, 12, 28].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Subscritores');
    XLSX.writeFile(wb, 'modelo-subscritores.xlsx');
  } catch (err) {
    toast('Não consegui gerar o modelo: ' + err.message, true);
  }
});

$('#ficheiro').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const XLSX = await import(XLSX_URL);
    const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
    const [cab = [], ...linhas] = rows;
    IMP = { cab: cab.map((x) => String(x).trim()), linhas: linhas.filter((l) => l.some((v) => String(v).trim() !== '')) };
    montarMapa();
  } catch (err) {
    toast('Não consegui ler o ficheiro: ' + err.message, true);
  }
});

function montarMapa() {
  const cabN = IMP.cab.map(norm);
  const usados = new Set();
  const auto = (campo) => {
    for (const s of campo.sin) { const i = cabN.findIndex((h, j) => !usados.has(j) && h === s); if (i >= 0) { usados.add(i); return i; } }
    for (const s of campo.sin) { if (s.length < 3) continue; const i = cabN.findIndex((h, j) => !usados.has(j) && h.includes(s)); if (i >= 0) { usados.add(i); return i; } }
    return -1;
  };
  // Primeiro todas as correspondências exatas, depois as parciais
  const sel = {};
  for (const campo of CAMPOS) {
    const i = cabN.findIndex((h, j) => !usados.has(j) && campo.sin.includes(h));
    if (i >= 0) { usados.add(i); sel[campo.k] = i; }
  }
  for (const campo of CAMPOS) if (sel[campo.k] === undefined) sel[campo.k] = auto(campo);

  $('#mapa-campos').innerHTML = CAMPOS.map((campo) => `<label>${campo.rot}<select data-campo="${campo.k}"><option value="-1">— ignorar —</option>
      ${IMP.cab.map((h, i) => `<option value="${i}" ${i === sel[campo.k] ? 'selected' : ''}>${esc(h || `Coluna ${i + 1}`)}</option>`).join('')}</select></label>`).join('');
  $$('#mapa-campos select').forEach((s) => s.addEventListener('change', previsualizar));
  $('#import-mapa').classList.remove('hidden');
  previsualizar();
}

function lerData(v) {
  if (v instanceof Date && !isNaN(v)) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return isoUTC(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000)); // nº de série Excel
  }
  const s = String(v ?? '').trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}
function lerValor(v) {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function lerPeriodicidade(v) {
  const s = norm(v);
  if (!s) return 'semestral';
  return /anu|year|12|annual/.test(s) ? 'anual' : 'semestral';
}

function converter() {
  const mapa = Object.fromEntries($$('#mapa-campos select').map((s) => [s.dataset.campo, Number(s.value)]));
  const get = (l, k) => (mapa[k] >= 0 ? l[mapa[k]] : '');
  const txt = (l, k) => String(get(l, k) ?? '').trim() || null;
  const porCodigo = new Map(), erros = [];
  IMP.linhas.forEach((l, i) => {
    const code = txt(l, 'code');
    const periodicity = lerPeriodicidade(get(l, 'periodicity'));
    const last = lerData(get(l, 'last_payment_date'));
    let due = lerData(get(l, 'payment_due_date'));
    if (!due && last) due = proximoVenc(last, periodicity);
    if (!code) return erros.push(`Linha ${i + 2}: sem ID`);
    porCodigo.set(code, { // IDs repetidos: fica a última linha
      code,
      payment_due_date: due || null,
      last_payment_date: last,
      value: lerValor(get(l, 'value')),
      commission: lerValor(get(l, 'commission')),
      owner: txt(l, 'owner'),
      type: txt(l, 'type'),
      hw: txt(l, 'hw'),
      periodicity,
      notes: txt(l, 'notes'),
    });
  });
  return { ok: [...porCodigo.values()], erros };
}

function previsualizar() {
  const { ok, erros } = converter();
  const cols = [['ID', 'code'], ['PaymentDue', 'payment_due_date'], ['LastPayment', 'last_payment_date'], ['Value', 'value'], ['Commission', 'commission'], ['Owner', 'owner'], ['Type', 'type'], ['HW', 'hw'], ['Avença', 'periodicity']];
  const fmt = (r, k) => (k === 'value' || k === 'commission') ? eur(r[k]) : k.endsWith('_date') ? fmtData(r[k]) : r[k] ?? '';
  $('#preview').innerHTML = `<thead><tr>${cols.map(([h]) => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${ok.slice(0, 8).map((r) => `<tr>${cols.map(([, k]) => `<td>${esc(fmt(r, k))}</td>`).join('')}</tr>`).join('')}</tbody>`;
  const existentes = ok.filter((r) => S.subs.some((s) => s.code === r.code)).length;
  $('#import-info').innerHTML = `${ok.length} subscritor(es) prontos${existentes ? ` (${existentes} já existem e serão atualizados)` : ''}` +
    (erros.length ? ` · <span class="erro">${erros.length} linha(s) ignorada(s)</span> <span class="small" title="${esc(erros.join('\n'))}">(passa o rato para ver)</span>` : '');
  $('#btn-importar').disabled = ok.length === 0;
}

$('#btn-importar').addEventListener('click', async (e) => {
  const { ok } = converter();
  if (!ok.length) return;
  if (!(await confirmar('Importar', `Importar <b>${ok.length}</b> subscritor(es)? Os que já existem (mesmo ID) são atualizados com os dados da folha.`, 'Importar'))) return;
  e.target.disabled = true;
  const linhas = ok;
  for (let i = 0; i < linhas.length; i += 200) {
    const { error } = await sb.from('subscribers').upsert(linhas.slice(i, i + 200), { onConflict: 'code' });
    if (error) { e.target.disabled = false; return toast(`Erro a importar (a partir do nº ${i + 1}): ${error.message}`, true); }
  }
  toast(`${ok.length} subscritor(es) importados.`);
  $('#import-mapa').classList.add('hidden');
  $('#ficheiro').value = '';
  await carregar();
  $('.tab[data-tab="clientes"]').click();
});

// ---------------------------------------------------------------- arranque
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  mostrar(session);
  sb.auth.onAuthStateChange((_e, sess) => mostrar(sess));
})();
