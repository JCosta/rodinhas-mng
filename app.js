import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY, DIAS_AVISO, HW_OPCOES } from './config.js?v=202611261402';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------- estado
const S = {
  subs: [],
  custos: [],
  waTemplate: '',
  sel: new Set(),   // ids selecionados na lista
  pagamentos: [],   // renovações dos últimos 12 meses (separador Financeiro)
  sort: { campo: 'payment_due_date', asc: true },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------------------------------------------------------------- utilitários
const fmtNum = new Intl.NumberFormat('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const eur = (v) => fmtNum.format(Number(v) || 0);   // valores sem símbolo de moeda
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

const ESTADOS = { ativo: 'Ativo', a_terminar: 'A vencer', em_atraso: 'Em atraso', desligado: 'Desligado', arquivado: 'Arquivado', cancelado: 'Cancelado' };
const LIGADOS = ['ativo', 'a_terminar', 'em_atraso'];   // continuam a ter serviço (e custo)
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
  const [r1, rc, rs, rp] = await Promise.all([
    sb.from('subscribers_status').select('*').order('payment_due_date'),
    sb.from('type_costs').select('*').order('type'),
    sb.from('app_settings').select('*').eq('key', 'whatsapp_template'),
    sb.from('renewals').select('payment_date,value,commission,paid').gte('payment_date', somaMeses(hojeISO().slice(0, 8) + '01', -11)),
  ]);
  S.erroCustos = rc.error ? rc.error.message : null;
  S.custos = rc.error ? [] : rc.data;
  S.waTemplate = (!rs.error && rs.data[0]?.value) || 'Olá {owner}! A sua subscrição {id} vence a {data} (daqui a {dias} dias). Valor da renovação: {valor}. Obrigado!';
  if (r1.error) {
    toast('Erro a carregar subscritores: ' + r1.error.message, true);
    renderConfig();
    return;
  }
  S.subs = r1.data;
  S.pagamentos = rp.error ? [] : rp.data;
  preencherFiltros();
  renderConfig();
  renderPainel();
  renderLista();
  renderFinanceiro();
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
  if (b.dataset.tab === 'auditoria') carregarAuditoria(true);
}));

// ---------------------------------------------------------------- painel (só operacional)
function renderPainel() {
  const cs = S.subs;
  const por = (st) => cs.filter((s) => s.status === st);
  const ligados = cs.filter((s) => LIGADOS.includes(s.status));
  const aTerminar = por('a_terminar').sort((a, b) => a.days_left - b.days_left);
  const emAtraso = por('em_atraso').sort((a, b) => a.days_left - b.days_left);      // mais atrasado primeiro
  const desligados = por('desligado').sort((a, b) => b.days_left - a.days_left);    // mais recente primeiro
  const arquivados = por('arquivado').sort((a, b) => String(a.code).localeCompare(String(b.code), 'pt', { numeric: true }));

  $('#kpis').innerHTML = `
    <div class="kpi"><div class="lbl">Ligados</div><div class="val">${ligados.length}</div>
      <div class="sub">${ligados.filter((s) => s.periodicity === 'semestral').length} semestrais · ${ligados.filter((s) => s.periodicity === 'anual').length} anuais</div></div>
    <div class="kpi warn"><div class="lbl">A vencer (${DIAS_AVISO} dias)</div><div class="val">${aTerminar.length}</div>
      <div class="sub">${aTerminar.filter((s) => s.last_notified_at).length} já avisados</div></div>
    <div class="kpi late"><div class="lbl">Em atraso</div><div class="val">${emAtraso.length}</div>
      <div class="sub">${emAtraso.length ? `o mais antigo há ${-emAtraso[0].days_left} dias` : 'ligados sem pagamento'}</div></div>
    <div class="kpi bad"><div class="lbl">Desligados</div><div class="val">${desligados.length}</div><div class="sub">pagamento passado</div></div>
    <div class="kpi off"><div class="lbl">Arquivados</div><div class="val">${arquivados.length}</div><div class="sub">sem data</div></div>`;

  $('#aviso-dias').textContent = `próximos ${DIAS_AVISO} dias`;
  const item = (s, extra = '') => `<div class="item">
      <div class="who"><b data-editar="${s.id}">${esc(titulo(s))}</b><span>${[s.type, s.hw, PER[s.periodicity]].filter(Boolean).map(esc).join(' · ')} · ${s.payment_due_date ? (s.days_left < 0 ? 'venceu ' : 'vence ') + fmtData(s.payment_due_date) : 'sem data de pagamento'}</span></div>
      <div class="dias">${textoDias(s)}</div>${extra}
      <button class="btn sm" data-renovar="${s.id}">${s.status === 'arquivado' ? 'Reativar' : 'Renovar'}</button></div>`;
  const bManter = (s) => `<button class="btn sm ghost" data-manter="${s.id}" title="Continua com serviço apesar do pagamento em atraso">Manter ligado</button>`;
  const bDesligar = (s) => `<button class="btn sm ghost danger" data-desligar="${s.id}" title="Passa para Desligados">Desligar</button>`;
  $('#lista-a-terminar').innerHTML = aTerminar.map((s) => item(s, botaoWA(s))).join('') || '<p class="vazio">Nada a vencer. 👌</p>';
  $('#lista-em-atraso').innerHTML = emAtraso.map((s) => item(s, botaoWA(s) + bDesligar(s))).join('') || '<p class="vazio">Ninguém em atraso.</p>';
  $('#lista-desligados').innerHTML = desligados.map((s) => item(s, bManter(s))).join('') || '<p class="vazio">Nenhum desligado.</p>';
  $('#lista-arquivados').innerHTML = arquivados.map((s) => item(s)).join('') || '<p class="vazio">Nenhum arquivado.</p>';
}

// Manter ligado / Desligar (pagamento em atraso)
document.addEventListener('click', async (e) => {
  const m = e.target.closest('[data-manter]'), d = e.target.closest('[data-desligar]');
  if (!m && !d) return;
  const id = (m || d).dataset[m ? 'manter' : 'desligar'];
  const s = S.subs.find((x) => x.id === id);
  const { error } = await sb.from('subscribers').update({ keep_active: !!m }).eq('id', id);
  if (error) return toast('Erro: ' + error.message, true);
  toast(m ? `${s.code} mantido ligado (em atraso).` : `${s.code} desligado.`);
  carregar();
});

// ---------------------------------------------------------------- financeiro
function renderFinanceiro() {
  const ligados = S.subs.filter((s) => LIGADOS.includes(s.status));
  const somaK = (arr, k) => arr.reduce((t, s) => t + Number(s[k] || 0), 0);
  const receitaM = somaK(ligados, 'value_year') / 12;
  const comissoesM = somaK(ligados, 'commission_year') / 12;
  const custosM = somaK(ligados, 'monthly_cost');
  const liquidoM = receitaM - comissoesM - custosM;
  const neg = (v) => (v < 0 ? ' style="color:var(--bad)"' : '');

  $('#fin-kpis').innerHTML = `
    <div class="kpi"><div class="lbl">Subscritores ligados</div><div class="val">${ligados.length}</div><div class="sub">inclui ${ligados.filter((s) => s.status === 'em_atraso').length} em atraso</div></div>
    <div class="kpi"><div class="lbl">Receita mensal</div><div class="val">${eur(receitaM)}</div><div class="sub">${eur(receitaM * 12)} por ano</div></div>
    <div class="kpi"><div class="lbl">Comissões mensais</div><div class="val">${eur(comissoesM)}</div><div class="sub">${eur(comissoesM * 12)} por ano</div></div>
    <div class="kpi"><div class="lbl">Custos mensais</div><div class="val">${eur(custosM)}</div><div class="sub">${eur(custosM * 12)} por ano</div></div>
    <div class="kpi"><div class="lbl">Lucro líquido mensal</div><div class="val"${neg(liquidoM)}>${eur(liquidoM)}</div><div class="sub">${eur(liquidoM * 12)} por ano</div></div>`;

  // ---- por Type
  const tipos = [...new Set(ligados.map((s) => s.type || '—'))].sort((a, b) => a.localeCompare(b, 'pt'));
  const linhasT = tipos.map((t) => {
    const g = ligados.filter((s) => (s.type || '—') === t);
    const r = somaK(g, 'value_year') / 12, c = somaK(g, 'commission_year') / 12, k = somaK(g, 'monthly_cost');
    return { t, n: g.length, unit: g[0]?.monthly_cost ?? 0, r, c, k, l: r - c - k, sem: g.some((s) => s.type && s.type_sem_custo) };
  });
  const tot = linhasT.reduce((a, x) => ({ n: a.n + x.n, r: a.r + x.r, c: a.c + x.c, k: a.k + x.k, l: a.l + x.l }), { n: 0, r: 0, c: 0, k: 0, l: 0 });
  $('#fin-types').innerHTML = `<thead><tr><th>Type</th><th class="num">Subscritores</th><th class="num">Custo unitário/mês</th><th class="num">Receita/mês</th><th class="num">Comissões/mês</th><th class="num">Custos/mês</th><th class="num">Lucro líquido/mês</th></tr></thead>
    <tbody>${linhasT.map((x) => `<tr><td><b>${esc(x.t)}</b>${x.sem ? ' <span title="Type sem custo definido em Configuração">⚠</span>' : ''}</td><td class="num">${x.n}</td><td class="num">${eur(x.unit)}</td>
      <td class="num">${eur(x.r)}</td><td class="num">${eur(x.c)}</td><td class="num">${eur(x.k)}</td><td class="num ${x.l < 0 ? 'neg' : ''}">${eur(x.l)}</td></tr>`).join('') || '<tr><td colspan="7" class="vazio">Sem subscritores ligados.</td></tr>'}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${tot.n}</td><td></td><td class="num">${eur(tot.r)}</td><td class="num">${eur(tot.c)}</td><td class="num">${eur(tot.k)}</td><td class="num ${tot.l < 0 ? 'neg' : ''}">${eur(tot.l)}</td></tr></tfoot>`;

  // ---- previsão 12 meses (pelas datas de renovação)
  const hoje = new Date();
  const meses = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() + i, 1);
    meses.push({ chave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, rot: d.toLocaleDateString('pt-PT', { month: 'short', year: '2-digit' }).replace('.', ''), n: 0, r: 0, c: 0, k: custosM });
  }
  const limite = meses[11].chave, primeiro = meses[0].chave;
  for (const s of ligados) {
    let venc = s.payment_due_date;
    if (!venc) continue;
    while (venc.slice(0, 7) <= limite) {
      const m = meses.find((x) => x.chave === (venc.slice(0, 7) < primeiro ? primeiro : venc.slice(0, 7)));   // atrasados contam no mês atual
      m.n += 1; m.r += Number(s.value || 0); m.c += Number(s.commission || 0);
      venc = proximoVenc(venc, s.periodicity);
    }
  }
  meses.forEach((m) => { m.l = m.r - m.c - m.k; });
  const max = Math.max(1, ...meses.map((m) => Math.abs(m.l)));
  $('#fin-meses').innerHTML = meses.map((m) => `<div class="mes" title="${m.rot}: líquido ${eur(m.l)}">
      <span class="v">${m.l ? Math.round(m.l).toLocaleString('pt-PT') : ''}</span>
      <div class="barra ${m.l < 0 ? 'neg' : ''}" style="height:${(Math.abs(m.l) / max) * 110}px"></div>
      <span class="m">${m.rot}</span></div>`).join('');
  const tp = meses.reduce((a, m) => ({ n: a.n + m.n, r: a.r + m.r, c: a.c + m.c, k: a.k + m.k, l: a.l + m.l }), { n: 0, r: 0, c: 0, k: 0, l: 0 });
  $('#fin-previsao').innerHTML = `<thead><tr><th>Mês</th><th class="num">Renovações</th><th class="num">A receber</th><th class="num">Comissões</th><th class="num">Custos</th><th class="num">Líquido</th></tr></thead>
    <tbody>${meses.map((m) => `<tr><td>${m.rot}</td><td class="num">${m.n}</td><td class="num">${eur(m.r)}</td><td class="num">${eur(m.c)}</td><td class="num">${eur(m.k)}</td><td class="num ${m.l < 0 ? 'neg' : ''}">${eur(m.l)}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>12 meses</td><td class="num">${tp.n}</td><td class="num">${eur(tp.r)}</td><td class="num">${eur(tp.c)}</td><td class="num">${eur(tp.k)}</td><td class="num ${tp.l < 0 ? 'neg' : ''}">${eur(tp.l)}</td></tr></tfoot>`;

  // ---- histórico de pagamentos registados
  const hist = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(hoje.getFullYear(), hoje.getMonth() - i, 1);
    hist.push({ chave: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, rot: d.toLocaleDateString('pt-PT', { month: 'short', year: '2-digit' }).replace('.', ''), n: 0, v: 0, c: 0, pend: 0 });
  }
  for (const p of S.pagamentos) {
    const h = hist.find((x) => x.chave === String(p.payment_date).slice(0, 7));
    if (!h) continue;
    if (p.paid) { h.n += 1; h.v += Number(p.value || 0); h.c += Number(p.commission || 0); } else h.pend += Number(p.value || 0);
  }
  const th = hist.reduce((a, h) => ({ n: a.n + h.n, v: a.v + h.v, c: a.c + h.c, pend: a.pend + h.pend }), { n: 0, v: 0, c: 0, pend: 0 });
  $('#fin-historico').innerHTML = `<thead><tr><th>Mês</th><th class="num">Pagamentos</th><th class="num">Recebido</th><th class="num">Comissões</th><th class="num">Recebido − comissões</th><th class="num">Registado como não pago</th></tr></thead>
    <tbody>${hist.reverse().map((h) => `<tr><td>${h.rot}</td><td class="num">${h.n}</td><td class="num">${eur(h.v)}</td><td class="num">${eur(h.c)}</td><td class="num">${eur(h.v - h.c)}</td><td class="num">${h.pend ? eur(h.pend) : '—'}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>12 meses</td><td class="num">${th.n}</td><td class="num">${eur(th.v)}</td><td class="num">${eur(th.c)}</td><td class="num">${eur(th.v - th.c)}</td><td class="num">${th.pend ? eur(th.pend) : '—'}</td></tr></tfoot>`;
}

// ---------------------------------------------------------------- lista
function filtrados() {
  const q = $('#f-pesquisa').value.trim().toLowerCase();
  const est = $('#f-estado').value, ow = $('#f-owner').value, ty = $('#f-type').value, hw = $('#f-hw').value;
  const { campo, asc } = S.sort;
  const numericos = ['value', 'commission', 'days_left', 'net_year'];
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
  // limpa seleções de subscritores que já não existem
  for (const id of [...S.sel]) if (!S.subs.some((s) => s.id === id)) S.sel.delete(id);
  $('#tbody-clientes').innerHTML = lista.map((s) => `<tr class="${S.sel.has(s.id) ? 'selecionado' : ''}">
      <td class="sel"><input type="checkbox" data-sel="${s.id}" ${S.sel.has(s.id) ? 'checked' : ''}></td>
      <td><span class="nome" data-editar="${s.id}">${esc(s.code)}</span></td>
      <td>${esc(s.owner || '')}</td>
      <td>${esc(s.type || '')}</td>
      <td>${esc(s.hw || '')}</td>
      <td>${PER[s.periodicity]}</td>
      <td class="num">${eur(s.value)}</td>
      <td class="num">${eur(s.commission)}</td>
      <td class="num ${Number(s.net_year) < 0 ? 'neg' : ''}" title="custo ${eur(s.monthly_cost)}/mês${s.type_sem_custo && s.type ? ' — Type sem custo definido' : ''}">${eur(s.net_year)}${s.type_sem_custo && s.type ? ' ⚠' : ''}</td>
      <td>${fmtData(s.last_payment_date)}</td>
      <td>${fmtData(s.payment_due_date)}</td>
      <td class="num">${s.status === 'cancelado' || s.days_left == null ? '—' : s.days_left}</td>
      <td>${badge(s.status)}</td>
      <td><div class="acoes">${s.status === 'a_terminar' || s.status === 'em_atraso' ? botaoWA(s) : ''}<button class="btn sm" data-renovar="${s.id}">${s.status === 'arquivado' ? 'Reativar' : 'Renovar'}</button><button class="btn sm ghost" data-editar="${s.id}">Editar</button></div></td>
    </tr>`).join('');
  $('#vazio-clientes').classList.toggle('hidden', lista.length > 0);
  const visSel = lista.filter((s) => S.sel.has(s.id)).length;
  $('#sel-todos').checked = lista.length > 0 && visSel === lista.length;
  $('#sel-todos').indeterminate = visSel > 0 && visSel < lista.length;
  $('#btn-apagar-sel').classList.toggle('hidden', S.sel.size === 0);
  $('#btn-apagar-sel').textContent = `Apagar selecionados (${S.sel.size})`;
  $$('.tabela th[data-sort]').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === S.sort.campo);
    th.classList.toggle('asc', th.dataset.sort === S.sort.campo && S.sort.asc);
  });
}

$('#tbody-clientes').addEventListener('change', (e) => {
  const cb = e.target.closest('[data-sel]');
  if (!cb) return;
  cb.checked ? S.sel.add(cb.dataset.sel) : S.sel.delete(cb.dataset.sel);
  renderLista();
});
$('#sel-todos').addEventListener('change', (e) => {
  const lista = filtrados();
  for (const s of lista) e.target.checked ? S.sel.add(s.id) : S.sel.delete(s.id);
  renderLista();
});
$('#btn-apagar-sel').addEventListener('click', async () => {
  const alvo = S.subs.filter((s) => S.sel.has(s.id));
  if (!alvo.length) return;
  const nomes = alvo.slice(0, 10).map((s) => `<b>${esc(s.code)}</b>`).join(', ') + (alvo.length > 10 ? ` e mais ${alvo.length - 10}` : '');
  const ok = await confirmar('Apagar subscritores',
    `Apagar <b>${alvo.length}</b> subscritor(es) e todo o histórico de pagamentos? ${nomes}.<br>Esta ação não pode ser desfeita.<br>
     <span class="muted small">Se só quiseres tirá-los dos ativos, apaga o PaymentDueDate (ficam arquivados) ou marca-os como cancelados.</span>`, 'Apagar');
  if (!ok) return;
  const ids = alvo.map((s) => s.id);
  const { error } = await sb.from('subscribers').delete().in('id', ids);
  if (error) return toast('Erro ao apagar: ' + error.message, true);
  S.sel.clear();
  toast(`${ids.length} subscritor(es) apagado(s).`);
  carregar();
});

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
      <label>Type<input name="type" list="dl-type" value="${esc(v.type)}"><datalist id="dl-type">${[...new Set([...S.custos.map((c) => c.type), ...unicos('type')])].map((o) => `<option value="${esc(o)}">`).join('')}</datalist></label>
      <label>HW${campoHW(v.hw)}</label>
      <label>Avença<select name="periodicity">
        <option value="semestral" ${v.periodicity === 'semestral' ? 'selected' : ''}>Semestral</option>
        <option value="anual" ${v.periodicity === 'anual' ? 'selected' : ''}>Anual</option></select></label>
      <label>Value (por período)<input name="value" type="number" step="0.01" min="0" value="${esc(v.value)}"></label>
      <label>Commission (por período)<input name="commission" type="number" step="0.01" min="0" value="${esc(v.commission)}"></label>
      <label>Last Payment Date<input name="last_payment_date" type="date" value="${esc(v.last_payment_date)}"></label>
      <label>Payment Due Date<input name="payment_due_date" type="date" value="${esc(v.payment_due_date)}"></label>
      <label class="full">Notas<textarea name="notes">${esc(v.notes)}</textarea></label>
      <label class="check full"><input type="checkbox" name="keep_active" ${v.keep_active ? 'checked' : ''}> Manter ligado mesmo com o pagamento em atraso</label>
      ${s ? `<label class="check full"><input type="checkbox" name="cancelado" ${s.active ? '' : 'checked'}> Cancelado (deixa de contar e de aparecer nos avisos)</label>` : ''}
    </form>
    ${s ? '<h3>Histórico de pagamentos</h3><div id="historico" class="muted">A carregar…</div>' : ''}
    <div class="row">
      ${s ? '<button class="btn danger ghost" id="btn-apagar">Apagar</button><button class="btn ghost" id="btn-ver-audit">Ver auditoria</button>' : ''}
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
      keep_active: !!f.get('keep_active'),
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

  $('#btn-ver-audit', corpo).addEventListener('click', () => {
    fecharModal();
    $('#a-pesquisa').value = s.code;
    $('.tab[data-tab="auditoria"]').click();
  });

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
  const parado = s.status === 'desligado' || s.status === 'arquivado';
  const inicioAuto = () => (parado ? $('#form-renovar [name=payment_date]').value || hoje : s.payment_due_date);
  const corpo = abrirModal(`${s.status === 'arquivado' ? 'Reativar' : 'Renovar'} — ${titulo(s)}`, `
    <div class="info" id="renov-info"></div>
    <form class="form" id="form-renovar" style="margin-top:14px">
      <label class="full">Duração<select name="meses">
        <option value="">Período normal (${mesesDe(s.periodicity)} meses)</option>
        ${[12, 6, 3, 1].filter((m) => m !== mesesDe(s.periodicity)).map((m) => `<option value="${m}">Reforço de ${m} ${m === 1 ? 'mês' : 'meses'}</option>`).join('')}</select></label>
      <label>Value a cobrar (editável)<input name="value" type="number" step="0.01" min="0" value="${esc(s.value)}"></label>
      <label>Commission (editável)<input name="commission" type="number" step="0.01" min="0" value="${esc(s.commission)}"></label>
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
      (parado ? `<br><span class="muted small">Está ${s.status}, por isso o novo período começa na data do pagamento.</span>` : '');
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
    ['Commission', 'commission'], ['MonthlyCost', 'monthly_cost'], ['NetYear', 'net_year'], ['Owner', 'owner'] ['Type', 'type'], ['HW', 'hw'], ['Periodicity', 'periodicity'],
    ['Status', 'status'], ['DaysLeft', 'days_left'], ['Notes', 'notes'],
  ];
  const cel = (v) => {
    const t = String(v ?? '');
    return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const val = (s, k) => ['value', 'commission', 'monthly_cost', 'net_year'].includes(k) ? String(s[k]).replace('.', ',') : k.endsWith('_date') ? fmtData(s[k]).replace('—', '') : s[k];
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
    ['EXEMPLO-1', proximoVenc(ultimo1, 'semestral'), ultimo1, 120, 12, 'Ana Silva', 'C', HW_OPCOES[0] || 'Router X1', 'semestral', ''],
    ['EXEMPLO-2', proximoVenc(ultimo2, 'anual'), ultimo2, 300, 30, 'Rui Costa', 'P', HW_OPCOES[1] || HW_OPCOES[0] || 'Box X2', 'anual', 'Paga por transferência'],
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
    ws['!cols'] = [10, 16, 16, 10, 12, 18, 10, 16, 12, 28].map((w) => ({ wch: w }));
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

// ---------------------------------------------------------------- configuração: custos por Type
function renderConfig() {
  if (document.activeElement !== $('#wa-template')) { $('#wa-template').value = S.waTemplate; previewWA(); }
  const cont = (t) => S.subs.filter((s) => s.type === t).length;
  if (S.erroCustos) {
    $('#tabela-custos tbody').innerHTML = `<tr><td colspan="4" class="erro" style="white-space:normal">Não consegui ler os custos: ${esc(S.erroCustos)}.<br>
      Confirma que correste <b>supabase/migrations/004_custos_type.sql</b> no SQL Editor do Supabase.</td></tr>`;
    $('#aviso-tipos').innerHTML = '';
    return;
  }
  $('#tabela-custos tbody').innerHTML = S.custos.map((c) => `<tr>
      <td><b>${esc(c.type)}</b></td>
      <td class="num"><input type="number" step="0.01" min="0" value="${esc(c.monthly_cost)}" data-custo="${esc(c.type)}" style="max-width:110px;text-align:right"></td>
      <td class="num">${cont(c.type)}</td>
      <td><div class="acoes"><button class="btn sm" data-guardar-custo="${esc(c.type)}">Guardar</button><button class="btn sm ghost danger" data-apagar-custo="${esc(c.type)}">Apagar</button></div></td>
    </tr>`).join('') || '<tr><td colspan="4" class="vazio">Sem custos definidos.</td></tr>';
  const semCusto = unicos('type').filter((t) => !S.custos.some((c) => c.type === t));
  $('#aviso-tipos').innerHTML = semCusto.length
    ? `⚠ Types usados sem custo definido (contam como 0): <b>${semCusto.map(esc).join(', ')}</b>`
    : '';
}

$('#tabela-custos').addEventListener('click', async (e) => {
  const g = e.target.closest('[data-guardar-custo]');
  const d = e.target.closest('[data-apagar-custo]');
  if (g) {
    const type = g.dataset.guardarCusto;
    const v = Number($(`[data-custo="${CSS.escape(type)}"]`).value);
    if (!(v >= 0)) return toast('Valor inválido.', true);
    const { error } = await sb.from('type_costs').update({ monthly_cost: v, updated_at: new Date().toISOString() }).eq('type', type);
    if (error) return toast('Erro ao guardar: ' + error.message, true);
    toast(`Custo de ${type} atualizado.`);
    carregar();
  } else if (d) {
    const type = d.dataset.apagarCusto;
    if (!(await confirmar('Apagar custo', `Apagar o custo do Type <b>${esc(type)}</b>? Os subscritores deste Type passam a ter custo 0.`, 'Apagar'))) return;
    const { error } = await sb.from('type_costs').delete().eq('type', type);
    if (error) return toast('Erro ao apagar: ' + error.message, true);
    carregar();
  }
});

$('#btn-add-custo').addEventListener('click', async () => {
  const type = $('#novo-type').value.trim();
  const v = Number($('#novo-custo').value);
  if (!type || !($('#novo-custo').value !== '' && v >= 0)) return toast('Indica o Type e o custo mensal.', true);
  const { error } = await sb.from('type_costs').insert({ type, monthly_cost: v });
  if (error) return toast(error.code === '23505' ? `O Type ${type} já existe.` : 'Erro: ' + error.message, true);
  $('#novo-type').value = ''; $('#novo-custo').value = '';
  toast(`Custo de ${type} adicionado.`);
  carregar();
});

// ---------------------------------------------------------------- mensagem de aviso (WhatsApp)
function mensagemWA(s, tpl = S.waTemplate) {
  const v = { owner: s.owner || '', id: s.code, data: fmtData(s.payment_due_date), dias: s.days_left ?? '', valor: eur(s.value), type: s.type || '', hw: s.hw || '' };
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
}
function botaoWA(s) {
  const notif = s.last_notified_at ? `<span class="notif" title="Mensagem copiada a ${fmtData(s.last_notified_at)}">✓ ${fmtData(s.last_notified_at).slice(0, 5)}</span>` : '';
  return `${notif}<button class="btn sm wa" data-wa="${s.id}" title="Copiar a mensagem de aviso para colar no WhatsApp">Copiar msg</button>`;
}
async function marcarAvisado(s) {
  if (s.last_notified_at === hojeISO()) return;
  const { error } = await sb.from('subscribers').update({ last_notified_at: hojeISO() }).eq('id', s.id);
  if (!error) carregar();
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-wa]');
  if (!b) return;
  const s = S.subs.find((x) => x.id === b.dataset.wa);
  if (!s) return;
  const msg = mensagemWA(s);
  try {
    await navigator.clipboard.writeText(msg);
    toast(`Mensagem para ${s.code} copiada — cola no WhatsApp.`);
    marcarAvisado(s);
  } catch {
    // Sem acesso à área de transferência: mostra o texto para copiar à mão
    const corpo = abrirModal(`Mensagem — ${titulo(s)}`, `<textarea id="wa-msg" rows="6" readonly>${esc(msg)}</textarea>
      <div class="row end"><button class="btn" data-close>Fechar</button></div>`);
    const ta = $('#wa-msg', corpo); ta.focus(); ta.select();
    marcarAvisado(s);
  }
});

// ---------------------------------------------------------------- configuração: mensagem WhatsApp
function previewWA() {
  const ex = S.subs.find((s) => s.status === 'a_terminar') || { code: 'S-001', owner: 'Ana Silva', payment_due_date: hojeISO(), days_left: 10, value: 120, type: 'C', hw: 'Router' };
  $('#wa-preview').textContent = mensagemWA(ex, $('#wa-template').value);
}
$('#wa-template').addEventListener('input', previewWA);
$('#btn-wa-guardar').addEventListener('click', async () => {
  const value = $('#wa-template').value.trim();
  if (!value) return toast('A mensagem não pode estar vazia.', true);
  const { error } = await sb.from('app_settings').upsert({ key: 'whatsapp_template', value, updated_at: new Date().toISOString() });
  if (error) return toast('Erro ao guardar: ' + error.message, true);
  S.waTemplate = value;
  toast('Mensagem guardada.');
});

// ---------------------------------------------------------------- auditoria
const AUD = { linhas: [], pagina: 0, tam: 200 };
const ACOES = { criar: 'Criar', editar: 'Editar', renovar: 'Renovar', apagar: 'Apagar', aviso: 'Aviso copiado', ligar: 'Manter ligado', desligar: 'Desligar', config: 'Configuração' };
const CAMPO = {
  code: 'ID', payment_due_date: 'PaymentDueDate', last_payment_date: 'LastPaymentDate', value: 'Value', commission: 'Commission',
  owner: 'Owner', type: 'Type', hw: 'HW', periodicity: 'Avença', active: 'Ativo', keep_active: 'Manter ligado',
  notes: 'Notas', last_notified_at: 'Aviso copiado em', monthly_cost: 'Custo mensal',
};
function valorAud(k, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (typeof v === 'number' || ['value', 'commission', 'monthly_cost'].includes(k)) return eur(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return fmtData(v);
  const t = String(v);
  return t.length > 80 ? t.slice(0, 77) + '…' : t;
}
function detalhesAud(r) {
  const d = r.details || {};
  const lista = (o) => Object.entries(o).filter(([, v]) => v !== null && v !== '' && v !== false)
    .map(([k, v]) => `${esc(CAMPO[k] || k)}: <b>${esc(valorAud(k, v))}</b>`).join(' · ');
  const difs = (o) => Object.entries(o).map(([k, [a, b]]) => `${esc(CAMPO[k] || k)}: ${esc(valorAud(k, a))} → <b>${esc(valorAud(k, b))}</b>`).join('<br>');
  switch (r.action) {
    case 'criar':
    case 'apagar': {
      const { active, keep_active, ...resto } = d;
      return lista(resto);
    }
    case 'editar': return difs(d);
    case 'renovar':
      return `Pagamento a <b>${fmtData(d.payment_date)}</b> · período ${fmtData(d.period_start)} → <b>${fmtData(d.period_end)}</b> · Value <b>${eur(d.value)}</b> · Commission ${eur(d.commission)} · ${d.paid ? 'pago' : '<b>não pago</b>'}${d.notes ? ' · ' + esc(d.notes) : ''}`;
    case 'aviso': return 'Mensagem de aviso copiada para o WhatsApp';
    case 'ligar': return 'Mantido ligado com o pagamento em atraso';
    case 'desligar': return 'Passou a desligado';
    case 'config': {
      const alvo = r.entity === 'type_cost' ? `Custo do Type <b>${esc(r.record_id)}</b>` : `Definição <b>${r.record_id === 'whatsapp_template' ? 'mensagem de WhatsApp' : esc(r.record_id)}</b>`;
      if (d.op === 'criar') return `${alvo} criado(a): ${lista(d.novo || {})}`;
      if (d.op === 'apagar') return `${alvo} apagado(a)`;
      return `${alvo}<br>${difs(d['alterações'] || {})}`;
    }
    default: return esc(JSON.stringify(d));
  }
}
async function carregarAuditoria(reiniciar) {
  if (reiniciar) { AUD.linhas = []; AUD.pagina = 0; }
  let q = sb.from('audit_log').select('*').order('at', { ascending: false }).range(AUD.pagina * AUD.tam, AUD.pagina * AUD.tam + AUD.tam - 1);
  const acao = $('#a-acao').value, txt = $('#a-pesquisa').value.trim();
  if (acao) q = q.eq('action', acao);
  if (txt) q = q.or(`code.ilike.*${txt.replace(/[,()*]/g, ' ')}*,user_email.ilike.*${txt.replace(/[,()*]/g, ' ')}*`);
  $('#audit-info').classList.remove('hidden');
  $('#audit-info').textContent = 'A carregar…';
  const { data, error } = await q;
  if (error) {
    $('#tbody-audit').innerHTML = '';
    $('#audit-info').innerHTML = `<span class="erro">Não consegui ler a auditoria: ${esc(error.message)}. Confirma que correste <b>supabase/migrations/007_auditoria.sql</b>.</span>`;
    return;
  }
  AUD.linhas.push(...data);
  AUD.pagina += 1;
  const fmtHora = (t) => new Date(t).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  $('#tbody-audit').innerHTML = AUD.linhas.map((r) => `<tr>
      <td>${fmtHora(r.at)}</td>
      <td>${esc(r.user_email || '—')}</td>
      <td><span class="badge a-${r.action}">${ACOES[r.action] || esc(r.action)}</span></td>
      <td>${r.code ? `<b>${esc(r.code)}</b>` : ''}</td>
      <td>${detalhesAud(r)}</td></tr>`).join('');
  $('#audit-info').textContent = AUD.linhas.length ? '' : 'Sem registos.';
  $('#audit-info').classList.toggle('hidden', AUD.linhas.length > 0);
  $('#a-mais').classList.toggle('hidden', data.length < AUD.tam);
}
let tAud;
$('#a-pesquisa').addEventListener('input', () => { clearTimeout(tAud); tAud = setTimeout(() => carregarAuditoria(true), 300); });
$('#a-acao').addEventListener('change', () => carregarAuditoria(true));
$('#a-atualizar').addEventListener('click', () => carregarAuditoria(true));
$('#a-mais').addEventListener('click', () => carregarAuditoria(false));

// ---------------------------------------------------------------- arranque
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  mostrar(session);
  sb.auth.onAuthStateChange((_e, sess) => mostrar(sess));
})();
