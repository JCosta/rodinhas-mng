import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_KEY, DIAS_AVISO, HW_OPCOES, SESSAO_MINUTOS } from './config.js?v=202611261613';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------- estado
const S = {
  subs: [],
  custos: [],
  waTemplate: '',
  sel: new Set(),   // ids selecionados na lista
  pagamentos: [],
  naoPagos: [],     // pagamentos registados como não pagos (todos)
  metodos: [],      // métodos de pagamento   // renovações dos últimos 12 meses (separador Financeiro)
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
/** Dias entre duas datas ISO (b − a). */
const diasEntre = (a, b) => Math.round((Date.UTC(...b.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) - Date.UTC(...a.split('-').map((x, i) => (i === 1 ? x - 1 : +x)))) / 86400000);
const somaDiasISO = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return isoUTC(new Date(Date.UTC(y, m - 1, d + n))); };
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

// Cor por Type (definida em Configuração / tabela type_costs)
const corType = (t) => (t && S.custos.find((c) => c.type === t)?.color) || null;
const estiloType = (t) => { const c = corType(t); return c && /^#[0-9a-f]{3,8}$/i.test(c) ? ` style="--tc:${c}"` : ''; };
const INI_CORES = ['#257de0', '#f47230', '#00b894', '#6a4ce2', '#ee7fac', '#008a17', '#ec4647', '#f2a600'];
function avatar(nome) {
  const n = String(nome || '').trim();
  if (!n) return '';
  const p = n.split(/\s+/).filter((x) => /[\p{L}\d]/u.test(x));
  const ini = ((p[0]?.[0] || '') + (p.length > 1 ? p[p.length - 1][0] : (p[0]?.[1] || ''))).toUpperCase();
  let h = 0; for (const ch of n) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return `<span class="avatar" style="--av:${INI_CORES[h % INI_CORES.length]}" aria-hidden="true">${esc(ini)}</span>`;
}
const chipType = (t) => (t ? `<span class="tchip"${estiloType(t)}>${esc(t)}</span>` : '');

// ---------------------------------------------------------------- apagar com "Desfazer"
// A eliminação só é enviada ao fim de alguns segundos; até lá pode ser anulada.
const DESFAZER_MS = 8000;
let pendente = null;   // { executar, timer }
function comDesfazer(msg, esconder, executar) {
  if (pendente) { clearTimeout(pendente.timer); pendente.executar(); }   // confirma a anterior
  esconder();
  const t = $('#toast-desfazer');
  t.innerHTML = `<span>${esc(msg)}</span><button class="btn sm" type="button">Desfazer</button><i style="animation-duration:${DESFAZER_MS}ms"></i>`;
  t.classList.remove('hidden');
  const fim = () => { t.classList.add('hidden'); pendente = null; };
  const p = {
    executar: async () => { fim(); const erro = await executar(); if (erro) toast('Erro ao apagar: ' + erro.message, true); carregar(); },
    timer: null,
  };
  p.timer = setTimeout(p.executar, DESFAZER_MS);
  $('button', t).onclick = () => { clearTimeout(p.timer); fim(); toast('Anulado.'); carregar(); };
  pendente = p;
}
// se a página for fechada com uma eliminação pendente, envia-a na mesma
window.addEventListener('pagehide', () => { if (pendente) { clearTimeout(pendente.timer); pendente.executar(); } });

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
    if (!carregado) { carregado = true; esqueleto(); carregar(); }
  } else {
    carregado = false;
    S.subs = [];
  }
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  gravarLS('sessao.ultima', Date.now());
  const f = new FormData(e.target);
  $('#login-erro').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email: f.get('email'), password: f.get('password') });
  if (error) $('#login-erro').textContent = 'Email ou password inválidos.';
});
$('#logout').addEventListener('click', () => sb.auth.signOut());

// Estrutura da página enquanto os dados carregam
function esqueleto() {
  $('#kpis').innerHTML = Array.from({ length: 5 }, () => '<div class="kpi sk"><i class="skl w40"></i><i class="skl w20 big"></i><i class="skl w60"></i></div>').join('');
  $('#hoje').innerHTML = '<i class="skl w20"></i>' + Array.from({ length: 3 }, () => '<div class="acao"><i class="skl w80"></i></div>').join('');
  ['#lista-a-terminar', '#lista-em-atraso', '#lista-desligados', '#lista-arquivados', '#lista-por-receber'].forEach((id) => {
    $(id).innerHTML = Array.from({ length: 2 }, () => '<div class="item"><div class="who"><i class="skl w60"></i><i class="skl w40"></i></div></div>').join('');
  });
  $('#tbody-clientes').innerHTML = Array.from({ length: 6 }, () => `<tr>${'<td><i class="skl w80"></i></td>'.repeat(8)}</tr>`).join('');
}

// ---------------------------------------------------------------- dados
async function carregar() {
  const { data: admin, error: eAdm } = await sb.rpc('is_admin');
  if (eAdm || !admin) {
    toast('Esta conta não tem acesso de administrador.', true);
    await sb.auth.signOut();
    $('#login-erro').textContent = 'Esta conta não tem acesso de administrador.';
    return;
  }
  const [r1, rc, rs, rm, rnp, rp] = await Promise.all([
    sb.from('subscribers_status').select('*').order('payment_due_date'),
    sb.from('type_costs').select('*').order('type'),
    sb.from('app_settings').select('*').eq('key', 'whatsapp_template'),
    sb.from('payment_methods').select('name,sort_order').order('sort_order').order('name'),
    sb.from('renewals').select('id,subscriber_id,payment_date,period_start,period_end,value,commission,payment_method,notes').eq('paid', false).order('payment_date'),
    sb.from('renewals').select('payment_date,value,commission,paid,payment_method').gte('payment_date', somaMeses(hojeISO().slice(0, 8) + '01', -11)),
  ]);
  S.erroCustos = rc.error ? rc.error.message : null;
  S.metodos = rm.error ? [] : rm.data.map((m) => m.name);
  S.custos = rc.error ? [] : rc.data;
  S.waTemplate = (!rs.error && rs.data[0]?.value) || 'Olá {owner}! A sua subscrição {id} vence a {data} (daqui a {dias} dias). Valor da renovação: {valor}. Obrigado!';
  if (r1.error) {
    toast('Erro a carregar subscritores: ' + r1.error.message, true);
    renderConfig();
    return;
  }
  S.subs = r1.data;
  S.pagamentos = rp.error ? [] : rp.data;
  S.naoPagos = rnp.error ? [] : rnp.data;
  preencherFiltros();
  renderConfig();
  renderPainel();
  renderLista();
  renderFinanceiro();
  renderCalendario();
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
  if (b.dataset.tab === 'financeiro') renderFinanceiro();   // gráficos precisam da largura visível
}));

// ---------------------------------------------------------------- painel (só operacional)
const EMO = { ligados: '🟢', a_terminar: '⏰', em_atraso: '⚠️', desligado: '🔌', arquivado: '🗄️' };
const lerLS = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
const gravarLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem armazenamento */ } };
const SEC_FECHADAS = new Set(lerLS('painel.fechadas', []));

function aplicarSecoes() {
  $$('#tab-painel .sec').forEach((el) => el.classList.toggle('fechada', SEC_FECHADAS.has(el.dataset.sec)));
}
$$('#tab-painel .sec-head').forEach((b) => b.addEventListener('click', () => {
  const k = b.closest('.sec').dataset.sec;
  SEC_FECHADAS.has(k) ? SEC_FECHADAS.delete(k) : SEC_FECHADAS.add(k);
  gravarLS('painel.fechadas', [...SEC_FECHADAS]);
  aplicarSecoes();
}));
$('#p-expandir').addEventListener('click', () => { SEC_FECHADAS.clear(); gravarLS('painel.fechadas', []); aplicarSecoes(); });
$('#p-colapsar').addEventListener('click', () => {
  $$('#tab-painel .sec').forEach((el) => SEC_FECHADAS.add(el.dataset.sec));
  gravarLS('painel.fechadas', [...SEC_FECHADAS]); aplicarSecoes();
});
let tPainel;
$('#p-pesquisa').addEventListener('input', () => { clearTimeout(tPainel); tPainel = setTimeout(renderPainel, 150); });
// Clicar num indicador abre a secção e salta para ela
$('#kpis').addEventListener('click', (e) => {
  const k = e.target.closest('[data-ir]')?.dataset.ir;
  if (!k) return;
  SEC_FECHADAS.delete(k); gravarLS('painel.fechadas', [...SEC_FECHADAS]); aplicarSecoes();
  $(`#tab-painel .sec[data-sec="${k}"]`).scrollIntoView({ behavior: 'smooth', block: 'start' });
});

function realcar(texto, q) {
  const t = esc(texto);
  if (!q) return t;
  const i = String(texto).toLowerCase().indexOf(q);
  if (i < 0) return t;
  return esc(String(texto).slice(0, i)) + '<mark>' + esc(String(texto).slice(i, i + q.length)) + '</mark>' + esc(String(texto).slice(i + q.length));
}

function renderPainel() {
  const q = $('#p-pesquisa').value.trim().toLowerCase();
  const cs = S.subs;
  const corresponde = (s) => !q || String(s.code).toLowerCase().includes(q) || String(s.owner ?? '').toLowerCase().includes(q);
  const por = (st) => cs.filter((s) => s.status === st);
  const ligados = cs.filter((s) => LIGADOS.includes(s.status));
  const aTerminar = por('a_terminar').sort((a, b) => a.days_left - b.days_left);
  const emAtraso = por('em_atraso').sort((a, b) => a.days_left - b.days_left);      // mais atrasado primeiro
  const desligados = por('desligado').sort((a, b) => b.days_left - a.days_left);    // mais recente primeiro
  const arquivados = por('arquivado').sort((a, b) => String(a.code).localeCompare(String(b.code), 'pt', { numeric: true }));

  $('#kpis').innerHTML = `
    <div class="kpi"><div class="lbl">${EMO.ligados} Ligados</div><div class="val">${ligados.length}</div>
      <div class="sub">${ligados.filter((s) => s.periodicity === 'semestral').length} semestrais · ${ligados.filter((s) => s.periodicity === 'anual').length} anuais</div></div>
    <div class="kpi warn" data-ir="a_terminar"><div class="lbl">${EMO.a_terminar} A vencer (${DIAS_AVISO} dias)</div><div class="val">${aTerminar.length}</div>
      <div class="sub">${aTerminar.filter((s) => s.last_notified_at).length} já avisados</div></div>
    <div class="kpi late" data-ir="em_atraso"><div class="lbl">${EMO.em_atraso} Em atraso</div><div class="val">${emAtraso.length}</div>
      <div class="sub">${emAtraso.length ? `o mais antigo há ${-emAtraso[0].days_left} dias` : 'ligados sem pagamento'}</div></div>
    <div class="kpi bad" data-ir="desligado"><div class="lbl">${EMO.desligado} Desligados</div><div class="val">${desligados.length}</div><div class="sub">pagamento passado</div></div>
    <div class="kpi off" data-ir="arquivado"><div class="lbl">${EMO.arquivado} Arquivados</div><div class="val">${arquivados.length}</div><div class="sub">sem data</div></div>`;

  $('#aviso-dias').textContent = `próximos ${DIAS_AVISO} dias`;
  const item = (s, extra = '') => `<div class="item"${estiloType(s.type)}>
      <div class="who"><b data-editar="${s.id}">${chipType(s.type)} ${realcar(s.code, q)}${s.owner ? ' · ' + realcar(s.owner, q) : ''}</b>${recontactar(s) ? `<span class="recontactar" title="Mensagem copiada a ${fmtData(s.last_notified_at)}">🔁 voltar a contactar</span>` : ''}<span>${[s.hw, PER[s.periodicity]].filter(Boolean).map(esc).join(' · ')} · ${s.payment_due_date ? (s.days_left < 0 ? 'venceu ' : 'vence ') + fmtData(s.payment_due_date) : 'sem data de pagamento'}${s.status === 'em_atraso' ? (s.keep_active_until ? ` · <span class="tolerado">tolerado até ${fmtData(s.keep_active_until)}</span>` : ' · tolerado sem prazo') : ''}</span></div>
      <div class="dias ${s.status === 'a_terminar' ? urgencia(s) : ''}">${textoDias(s)}${s.status === 'a_terminar' || s.status === 'ativo' ? barraProg(s) : ''}</div>${extra}
      <button class="btn sm" data-renovar="${s.id}">${s.status === 'arquivado' ? 'Reativar' : 'Renovar'}</button></div>`;
  const bManter = (s) => `<button class="btn sm ghost" data-manter="${s.id}" title="Continua com serviço apesar do pagamento em atraso">Manter ligado</button>`;
  const bDesligar = (s) => `<button class="btn sm ghost danger" data-desligar="${s.id}" title="Passa para Desligados">Desligar</button>`;
  const secao = (id, chave, lista, render, vazio) => {
    const f = lista.filter(corresponde);
    $('#cnt-' + chave).textContent = q ? `${f.length} de ${lista.length}` : lista.length;
    $(id).innerHTML = f.map(render).join('') || `<p class="vazio">${q ? 'Sem resultados para a pesquisa.' : vazio}</p>`;
  };
  secao('#lista-a-terminar', 'a_terminar', aTerminar, (s) => item(s, botaoWA(s)), 'Nada a vencer. 👌');
  secao('#lista-em-atraso', 'em_atraso', emAtraso, (s) => item(s, botaoWA(s) + bDesligar(s)), 'Ninguém em atraso. 👌');
  secao('#lista-desligados', 'desligado', desligados, (s) => item(s, bManter(s)), 'Nenhum desligado.');
  secao('#lista-arquivados', 'arquivado', arquivados, (s) => item(s), 'Nenhum arquivado.');

  // ---- Por receber (pagamentos registados como não pagos)
  const subPorId = new Map(S.subs.map((s) => [s.id, s]));
  const naoPagos = S.naoPagos.map((r) => ({ ...r, sub: subPorId.get(r.subscriber_id) })).filter((r) => r.sub);
  const npF = naoPagos.filter((r) => corresponde(r.sub));
  $('#cnt-por_receber').textContent = q ? `${npF.length} de ${naoPagos.length}` : naoPagos.length;
  $('#lista-por-receber').innerHTML = npF.map((r) => `<div class="item"${estiloType(r.sub.type)}>
      <div class="who"><b data-editar="${r.sub.id}">${chipType(r.sub.type)} ${realcar(r.sub.code, q)}${r.sub.owner ? ' · ' + realcar(r.sub.owner, q) : ''}</b>
        <span>${eur(r.value)} · período ${fmtData(r.period_start)} → ${fmtData(r.period_end)} · registado a ${fmtData(r.payment_date)}${r.payment_method ? ' · ' + esc(r.payment_method) : ''}</span></div>
      <div class="dias">há ${Math.max(0, diasEntre(r.payment_date, hojeISO()))} dias</div>
      <button class="btn sm primary" data-pagar="${r.id}">Marcar como pago</button></div>`).join('')
    || `<p class="vazio">${q ? 'Sem resultados para a pesquisa.' : 'Nada por receber. 👌'}</p>`;

  renderHoje(naoPagos);

  // Com pesquisa ativa, abre as secções que têm resultados (sem alterar a preferência guardada)
  if (q) $$('#tab-painel .sec').forEach((el) => el.classList.toggle('fechada', !$('.item', el)));
  else aplicarSecoes();
}

// ---------- urgência, avisos e caixa "Hoje"
/** a_terminar: vermelho ≤ 7 dias, laranja ≤ 15, amarelo ≤ 30 */
/** Quanto do período atual já passou (0–1); null sem data */
function progresso(s) {
  if (!s.payment_due_date) return null;
  const ini = somaMeses(s.payment_due_date, -mesesDe(s.periodicity));
  const total = diasEntre(ini, s.payment_due_date) || 1;
  return Math.max(0, Math.min(1, diasEntre(ini, hojeISO()) / total));
}
function barraProg(s) {
  const p = progresso(s);
  if (p === null || s.status === 'cancelado') return '';
  const cls = p >= 0.9 ? 'p-bad' : p >= 0.7 ? 'p-warn' : 'p-ok';
  return `<span class="prog" title="${Math.round(p * 100)}% do período ${s.periodicity === 'anual' ? 'anual' : 'semestral'} já passou"><i class="${cls}" style="width:${Math.round(p * 100)}%"></i></span>`;
}
const urgencia = (s) => (s.days_left <= 7 ? 'u1' : s.days_left <= 15 ? 'u2' : 'u3');
/** Avisado neste ciclo de renovação (mensagem copiada nos 45 dias antes do vencimento ou depois) */
const avisadoNoCiclo = (s) => !!(s.last_notified_at && s.payment_due_date && s.last_notified_at >= somaDiasISO(s.payment_due_date, -(DIAS_AVISO + 15)));
/** Avisado há mais de 7 dias e ainda não renovou */
const recontactar = (s) => (s.status === 'a_terminar' || s.status === 'em_atraso') && avisadoNoCiclo(s) && diasEntre(s.last_notified_at, hojeISO()) > 7;

let hojeTudo = false;
function renderHoje(naoPagos) {
  const acoes = [];
  const quem = (s) => `<b data-editar="${s.id}">${chipType(s.type)} ${esc(s.code)}${s.owner ? ' · ' + esc(s.owner) : ''}</b>`;
  const bMsg = (s) => `<button class="btn sm wa" data-wa="${s.id}">Copiar msg</button>`;
  const bRen = (s) => `<button class="btn sm" data-renovar="${s.id}">Renovar</button>`;
  for (const s of S.subs) {
    if (s.status === 'em_atraso' && s.keep_active_until && diasEntre(hojeISO(), s.keep_active_until) <= 3) {
      const d = diasEntre(hojeISO(), s.keep_active_until);
      acoes.push({ p: 1, o: d, html: `<span class="emo">⏳</span><div class="txt">${quem(s)}<br><span>Prazo de tolerância ${d === 0 ? 'termina hoje' : `termina em ${d} dia${d === 1 ? '' : 's'}`} (${fmtData(s.keep_active_until)}) · em atraso há ${-s.days_left} dias</span></div>${bMsg(s)}<button class="btn sm ghost" data-manter="${s.id}">Prolongar</button>${bRen(s)}` });
    }
    if (s.status === 'a_terminar' && s.days_left <= 7 && !avisadoNoCiclo(s)) {
      acoes.push({ p: 2, o: s.days_left, html: `<span class="emo">⏰</span><div class="txt">${quem(s)}<br><span>Vence ${s.days_left === 0 ? 'hoje' : `em ${s.days_left} dia${s.days_left === 1 ? '' : 's'}`} (${fmtData(s.payment_due_date)}) e ainda não foi avisado</span></div>${bMsg(s)}${bRen(s)}` });
    }
    if (recontactar(s)) {
      acoes.push({ p: 3, o: -diasEntre(s.last_notified_at, hojeISO()), html: `<span class="emo">🔁</span><div class="txt">${quem(s)}<br><span>Avisado há ${diasEntre(s.last_notified_at, hojeISO())} dias e ainda não renovou · ${s.days_left < 0 ? `em atraso há ${-s.days_left} dias` : `vence em ${s.days_left} dias`}</span></div>${bMsg(s)}${bRen(s)}` });
    }
    if (s.status === 'em_atraso' && s.days_left < -30) {
      acoes.push({ p: 4, o: s.days_left, html: `<span class="emo">⚠️</span><div class="txt">${quem(s)}<br><span>Em atraso há ${-s.days_left} dias e continua ligado</span></div>${bRen(s)}<button class="btn sm ghost danger" data-desligar="${s.id}">Desligar</button>` });
    }
  }
  for (const r of naoPagos) {
    acoes.push({ p: 5, o: r.payment_date, html: `<span class="emo">💸</span><div class="txt">${quem(r.sub)}<br><span>Pagamento por receber: ${eur(r.value)} (registado a ${fmtData(r.payment_date)})</span></div><button class="btn sm primary" data-pagar="${r.id}">Marcar como pago</button>` });
  }
  acoes.sort((a, b) => a.p - b.p || (a.o < b.o ? -1 : a.o > b.o ? 1 : 0));
  const MAX = 5;
  const vis = hojeTudo ? acoes : acoes.slice(0, MAX);
  $('#hoje').innerHTML = `<h2>📌 Hoje ${acoes.length ? `<span class="cnt">${acoes.length}</span>` : ''}</h2>` +
    (acoes.length
      ? vis.map((a) => `<div class="acao">${a.html}</div>`).join('') +
        (acoes.length > MAX ? `<button class="btn sm ghost mais" id="hoje-mais">${hojeTudo ? 'Mostrar só as 5 mais urgentes' : `Ver todas (${acoes.length})`}</button>` : '')
      : '<p class="ok">✅ Nada urgente hoje.</p>');
  $('#hoje-mais')?.addEventListener('click', () => { hojeTudo = !hojeTudo; renderHoje(naoPagos); });
}

// ---------- Manter ligado (com prazo) / Desligar
function abrirManter(s) {
  const hoje = hojeISO();
  const atual = s.keep_active_until && s.keep_active_until >= hoje ? s.keep_active_until : null;
  const corpo = abrirModal(`Manter ligado — ${titulo(s)}`, `
    <div class="info">Pagamento em atraso desde <b>${fmtData(s.payment_due_date)}</b>. Até quando o mantens ligado? Passado o prazo, volta automaticamente aos <b>Desligados</b>.</div>
    <form class="form" id="form-manter" style="margin-top:14px">
      <label class="full">Prazo<select name="prazo">
        <option value="7">7 dias (até ${fmtData(somaDiasISO(hoje, 7))})</option>
        <option value="15" selected>15 dias (até ${fmtData(somaDiasISO(hoje, 15))})</option>
        <option value="30">30 dias (até ${fmtData(somaDiasISO(hoje, 30))})</option>
        <option value="data">Escolher data…</option>
        <option value="sem">Sem prazo</option></select></label>
      <label class="full hidden" id="lbl-data">Até<input name="ate" type="date" min="${hoje}" value="${atual || somaDiasISO(hoje, 15)}"></label>
    </form>
    <div class="row end"><button class="btn" data-close type="button">Cancelar</button><button class="btn primary" id="btn-manter-ok" type="button">Manter ligado</button></div>`);
  const form = $('#form-manter', corpo);
  form.prazo.addEventListener('change', () => $('#lbl-data', corpo).classList.toggle('hidden', form.prazo.value !== 'data'));
  $('#btn-manter-ok', corpo).addEventListener('click', async () => {
    const p = form.prazo.value;
    const ate = p === 'sem' ? null : p === 'data' ? form.ate.value : somaDiasISO(hoje, Number(p));
    if (p === 'data' && (!ate || ate < hoje)) return toast('Escolhe uma data a partir de hoje.', true);
    const { error } = await sb.from('subscribers').update({ keep_active: true, keep_active_until: ate }).eq('id', s.id);
    if (error) return toast('Erro: ' + error.message, true);
    fecharModal();
    toast(`${s.code} mantido ligado ${ate ? 'até ' + fmtData(ate) : 'sem prazo'}.`);
    carregar();
  });
}
document.addEventListener('click', async (e) => {
  if (e.target.closest('#modal')) return;
  const m = e.target.closest('[data-manter]'), d = e.target.closest('[data-desligar]');
  if (m) return abrirManter(S.subs.find((x) => x.id === m.dataset.manter));
  if (!d) return;
  const s = S.subs.find((x) => x.id === d.dataset.desligar);
  const { error } = await sb.from('subscribers').update({ keep_active: false, keep_active_until: null }).eq('id', s.id);
  if (error) return toast('Erro: ' + error.message, true);
  toast(`${s.code} desligado.`);
  carregar();
});

// ---------- Marcar pagamento como pago
document.addEventListener('click', (e) => {
  if (e.target.closest('#modal')) return;
  const b = e.target.closest('[data-pagar]');
  if (!b) return;
  const r = S.naoPagos.find((x) => x.id === b.dataset.pagar);
  const s = r && S.subs.find((x) => x.id === r.subscriber_id);
  if (!r || !s) return;
  const corpo = abrirModal(`Marcar como pago — ${titulo(s)}`, `
    <div class="info">${eur(r.value)} · período ${fmtData(r.period_start)} → ${fmtData(r.period_end)}</div>
    <form class="form" id="form-pagar" style="margin-top:14px">
      <label>Data do pagamento<input name="payment_date" type="date" required value="${hojeISO()}"></label>
      <label>Método de pagamento<select name="method"><option value="">— escolher —</option>${S.metodos.map((m) => `<option ${m === r.payment_method ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label class="full">Value recebido<input name="value" type="number" step="0.01" min="0" value="${esc(r.value)}"></label>
    </form>
    <div class="row end"><button class="btn" data-close type="button">Cancelar</button><button class="btn primary" id="btn-pagar-ok" type="button">Confirmar pagamento</button></div>`);
  $('#btn-pagar-ok', corpo).addEventListener('click', async () => {
    const f = new FormData($('#form-pagar', corpo));
    if (!f.get('payment_date')) return toast('Indica a data do pagamento.', true);
    const { error } = await sb.from('renewals').update({
      paid: true, payment_date: f.get('payment_date'), payment_method: f.get('method') || r.payment_method || null, value: Number(f.get('value')) || 0,
    }).eq('id', r.id);
    if (error) return toast('Erro: ' + error.message, true);
    fecharModal();
    toast(`Pagamento de ${s.code} marcado como pago.`);
    carregar();
  });
});

// ---------------------------------------------------------------- gráficos (SVG simples, sem bibliotecas)
/** Linha de uma série (12 meses) com eixo recessivo e tooltip por mês */
function graficoLinha(el, pts) {
  if (!el) return;
  const W = Math.max(300, Math.round(el.clientWidth || 720)), H = W < 500 ? 180 : 220, mE = 46, mD = 12, mT = 14, mB = 26;
  const max = Math.max(1, ...pts.map((p) => p.v));
  const passo = Math.pow(10, Math.floor(Math.log10(max))) / 2;
  const topo = Math.ceil(max / passo) * passo;
  const x = (i) => mE + (i * (W - mE - mD)) / Math.max(1, pts.length - 1);
  const y = (v) => mT + (H - mT - mB) * (1 - v / topo);
  const ticks = [0, topo / 2, topo];
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="graf" role="img" aria-label="Recebido por mês nos últimos 12 meses">
      ${ticks.map((t) => `<line x1="${mE}" x2="${W - mD}" y1="${y(t)}" y2="${y(t)}" class="g-grid"/><text x="${mE - 8}" y="${y(t) + 4}" class="g-eixo" text-anchor="end">${Math.round(t).toLocaleString('pt-PT')}</text>`).join('')}
      ${pts.map((p, i) => (i % (W < 500 ? 3 : 2) === 0 || pts.length <= 6 ? `<text x="${x(i)}" y="${H - 8}" class="g-eixo" text-anchor="middle">${esc(p.rot)}</text>` : '')).join('')}
      <path d="${d} L${x(pts.length - 1)},${y(0)} L${x(0)},${y(0)} Z" class="g-area"/>
      <path d="${d}" class="g-linha"/>
      ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="4" class="g-ponto"/>`).join('')}
      <line class="g-cruz hidden" y1="${mT}" y2="${y(0)}"/>
      ${pts.map((p, i) => `<rect x="${x(i) - (W - mE - mD) / (2 * (pts.length - 1))}" y="0" width="${(W - mE - mD) / (pts.length - 1)}" height="${H}" fill="transparent" data-i="${i}"/>`).join('')}
    </svg><div class="g-tip hidden"></div>`;
  const svg = $('svg', el), tip = $('.g-tip', el), cruz = $('.g-cruz', el);
  svg.addEventListener('pointermove', (e) => {
    const r = e.target.closest('rect[data-i]');
    if (!r) return;
    const i = Number(r.dataset.i), p = pts[i];
    cruz.setAttribute('x1', x(i)); cruz.setAttribute('x2', x(i)); cruz.classList.remove('hidden');
    tip.innerHTML = `<b>${esc(p.rot)}</b><br>Recebido: <b>${eur(p.v)}</b><br>${p.n} pagamento${p.n === 1 ? '' : 's'}`;
    const bb = svg.getBoundingClientRect();
    tip.style.left = `${Math.min(bb.width - 150, Math.max(0, (x(i) / W) * bb.width - 70))}px`;
    tip.style.top = `${Math.max(0, (y(p.v) / H) * bb.height - 70)}px`;
    tip.classList.remove('hidden');
  });
  svg.addEventListener('pointerleave', () => { tip.classList.add('hidden'); cruz.classList.add('hidden'); });
}
/** Barras horizontais com nome e valor escritos (sem depender só da cor) */
function barrasH(el, itens, unidade) {
  if (!el) return;
  if (!itens.length) { el.innerHTML = '<p class="vazio">Sem dados.</p>'; return; }
  const max = Math.max(1, ...itens.map((x) => Math.abs(x.v)));
  const tot = itens.reduce((t, x) => t + x.v, 0);
  el.innerHTML = `<div class="barras" role="list" aria-label="${esc(unidade)}">${itens.map((x) => `
    <div class="barra-l" role="listitem" title="${esc(x.rot)}: ${eur(x.v)} ${esc(unidade)}${x.sub ? ' · ' + esc(x.sub) : ''}">
      <span class="b-rot">${esc(x.rot)}<small>${esc(x.sub || '')}</small></span>
      <span class="b-pista"><i style="width:${Math.max(1, (Math.abs(x.v) / max) * 100)}%;background:${x.cor || 'var(--off)'}" class="${x.v < 0 ? 'neg' : ''}"></i></span>
      <span class="b-val">${eur(x.v)}${tot > 0 && x.v >= 0 ? `<small>${Math.round((x.v / tot) * 100)}%</small>` : ''}</span>
    </div>`).join('')}</div>`;
}

let tRes;
window.addEventListener('resize', () => { clearTimeout(tRes); tRes = setTimeout(() => { if (!$('#tab-financeiro').classList.contains('hidden')) renderFinanceiro(); }, 200); });

// ---------------------------------------------------------------- calendário de vencimentos
let calMes = hojeISO().slice(0, 7), calDia = null;
function renderCalendario() {
  const [y, m] = calMes.split('-').map(Number);
  const primeiro = new Date(Date.UTC(y, m - 1, 1));
  const diasMes = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (primeiro.getUTCDay() + 6) % 7;   // segunda-feira primeiro
  const doMes = S.subs.filter((s) => s.payment_due_date && s.payment_due_date.slice(0, 7) === calMes && s.status !== 'cancelado');
  const porDia = new Map();
  for (const s of doMes) { const d = Number(s.payment_due_date.slice(8, 10)); porDia.set(d, [...(porDia.get(d) || []), s]); }
  const hoje = hojeISO();
  $('#cal-titulo').textContent = primeiro.toLocaleDateString('pt-PT', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('#cal-resumo').textContent = `${doMes.length} vencimento${doMes.length === 1 ? '' : 's'} · ${eur(doMes.reduce((t, s) => t + Number(s.value || 0), 0))}`;
  let html = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((d) => `<div class="cal-sem">${d}</div>`).join('');
  html += '<div class="cal-vazio"></div>'.repeat(offset);
  for (let d = 1; d <= diasMes; d++) {
    const iso = `${calMes}-${String(d).padStart(2, '0')}`;
    const lista = porDia.get(d) || [];
    html += `<button type="button" class="cal-dia${iso === hoje ? ' hoje' : ''}${calDia === iso ? ' sel' : ''}${lista.length ? ' tem' : ''}" data-dia="${iso}">
      <span class="n">${d}</span>
      <span class="pts">${lista.slice(0, 4).map((s) => `<span class="pt"${estiloType(s.type)} title="${esc(s.code)}"><span class="lbl">${esc(s.code)}</span></span>`).join('')}${lista.length > 4 ? `<span class="mais">+${lista.length - 4}</span>` : ''}</span></button>`;
  }
  $('#cal-grelha').innerHTML = html;
  const sel = calDia && calDia.slice(0, 7) === calMes ? calDia : null;
  const lista = sel ? (porDia.get(Number(sel.slice(8, 10))) || []) : doMes.sort((a, b) => (a.payment_due_date < b.payment_due_date ? -1 : 1));
  $('#cal-lista-titulo').textContent = sel ? `Vencimentos a ${fmtData(sel)}` : 'Todos os vencimentos do mês';
  $('#cal-lista').innerHTML = lista.map((s) => `<div class="item"${estiloType(s.type)}>
      <div class="who"><b data-editar="${s.id}">${chipType(s.type)} ${esc(s.code)}${s.owner ? ' · ' + esc(s.owner) : ''}</b><span>${fmtData(s.payment_due_date)} · ${PER[s.periodicity]} · ${eur(s.value)}</span></div>
      <div class="dias">${badge(s.status)}</div>
      ${s.status === 'a_terminar' || s.status === 'em_atraso' ? botaoWA(s) : ''}<button class="btn sm" data-renovar="${s.id}">${s.status === 'arquivado' ? 'Reativar' : 'Renovar'}</button></div>`).join('')
    || '<p class="vazio">Sem vencimentos.</p>';
}
$('#cal-grelha').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dia]');
  if (!b) return;
  calDia = calDia === b.dataset.dia ? null : b.dataset.dia;
  renderCalendario();
});
$('#cal-ant').addEventListener('click', () => { calMes = somaMeses(calMes + '-01', -1).slice(0, 7); calDia = null; renderCalendario(); });
$('#cal-seg').addEventListener('click', () => { calMes = somaMeses(calMes + '-01', 1).slice(0, 7); calDia = null; renderCalendario(); });
$('#cal-hoje').addEventListener('click', () => { calMes = hojeISO().slice(0, 7); calDia = hojeISO(); renderCalendario(); });

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
    <tbody>${linhasT.map((x) => `<tr${estiloType(x.t)}><td>${x.t === '—' ? '<b>—</b>' : chipType(x.t)}${x.sem ? ' <span title="Type sem custo definido em Configuração">⚠</span>' : ''}</td><td class="num">${x.n}</td><td class="num">${eur(x.unit)}</td>
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

  // ---- por método de pagamento (12 meses, só pagos)
  const mesAtual = hojeISO().slice(0, 7);
  const porM = new Map();
  for (const p of S.pagamentos) {
    if (!p.paid) continue;
    const k = p.payment_method || 'Sem método';
    const x = porM.get(k) || { n: 0, v: 0, c: 0, mes: 0 };
    x.n += 1; x.v += Number(p.value || 0); x.c += Number(p.commission || 0);
    if (String(p.payment_date).slice(0, 7) === mesAtual) x.mes += Number(p.value || 0);
    porM.set(k, x);
  }
  const ordem = [...S.metodos, 'Sem método'];
  const metodosL = [...porM.entries()].sort((a, b) => (ordem.indexOf(a[0]) + 1 || 99) - (ordem.indexOf(b[0]) + 1 || 99));
  const totM = metodosL.reduce((a, [, x]) => ({ n: a.n + x.n, v: a.v + x.v, c: a.c + x.c, mes: a.mes + x.mes }), { n: 0, v: 0, c: 0, mes: 0 });
  const pct = (v) => (totM.v ? Math.round((v / totM.v) * 100) + '%' : '—');
  $('#fin-metodos').innerHTML = `<thead><tr><th>Método</th><th class="num">Pagamentos</th><th class="num">Recebido</th><th class="num">% do total</th><th class="num">Comissões</th><th class="num">Recebido − comissões</th><th class="num">Este mês</th></tr></thead>
    <tbody>${metodosL.map(([k, x]) => `<tr><td><b>${esc(k)}</b></td><td class="num">${x.n}</td><td class="num">${eur(x.v)}</td><td class="num">${pct(x.v)}</td><td class="num">${eur(x.c)}</td><td class="num">${eur(x.v - x.c)}</td><td class="num">${x.mes ? eur(x.mes) : '—'}</td></tr>`).join('')
      || '<tr><td colspan="7" class="vazio">Ainda sem pagamentos registados.</td></tr>'}</tbody>
    <tfoot><tr><td>Total</td><td class="num">${totM.n}</td><td class="num">${eur(totM.v)}</td><td class="num">${totM.v ? '100%' : '—'}</td><td class="num">${eur(totM.c)}</td><td class="num">${eur(totM.v - totM.c)}</td><td class="num">${totM.mes ? eur(totM.mes) : '—'}</td></tr></tfoot>`;

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
  graficoLinha($('#fin-graf-recebido'), hist.map((h) => ({ rot: h.rot, v: h.v, n: h.n })));
  barrasH($('#fin-graf-types'), linhasT.map((x) => ({ rot: x.t, v: x.l, cor: corType(x.t === '—' ? null : x.t), sub: `${x.n} subscritor${x.n === 1 ? '' : 'es'}` })), 'lucro líquido / mês');
  barrasH($('#fin-graf-metodos'), metodosL.map(([k, x]) => ({ rot: k, v: x.v, cor: k === 'Sem método' ? 'var(--off)' : `var(--cat-${(Math.max(0, S.metodos.indexOf(k)) % 8) + 1})`, sub: `${x.n} pagamento${x.n === 1 ? '' : 's'}` })), 'recebido em 12 meses');
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
  $('#tbody-clientes').innerHTML = lista.map((s) => `<tr class="${S.sel.has(s.id) ? 'selecionado' : ''}"${estiloType(s.type)}>
      <td class="sel"><input type="checkbox" data-sel="${s.id}" ${S.sel.has(s.id) ? 'checked' : ''}></td>
      <td class="c-id"><span class="nome" data-editar="${s.id}">${esc(s.code)}</span></td>
      <td class="c-owner" data-label="Owner">${s.owner ? avatar(s.owner) + esc(s.owner) : ''}</td>
      <td class="c-type" data-label="Type">${chipType(s.type)}</td>
      <td data-label="HW">${esc(s.hw || '')}</td>
      <td data-label="Avença">${PER[s.periodicity]}</td>
      <td class="num" data-label="Value">${eur(s.value)}</td>
      <td class="num" data-label="Commission">${eur(s.commission)}</td>
      <td data-label="Lucro/ano" class="num ${Number(s.net_year) < 0 ? 'neg' : ''}" title="custo ${eur(s.monthly_cost)}/mês${s.type_sem_custo && s.type ? ' — Type sem custo definido' : ''}">${eur(s.net_year)}${s.type_sem_custo && s.type ? ' ⚠' : ''}</td>
      <td data-label="Last Payment">${fmtData(s.last_payment_date)}</td>
      <td data-label="Payment Due">${fmtData(s.payment_due_date)}${barraProg(s)}</td>
      <td class="num" data-label="Dias">${s.status === 'cancelado' || s.days_left == null ? '—' : s.days_left}</td>
      <td class="c-estado" data-label="Estado">${badge(s.status)}</td>
      <td class="c-acoes"><div class="acoes">${s.status === 'a_terminar' || s.status === 'em_atraso' ? botaoWA(s) : ''}<button class="btn sm" data-renovar="${s.id}">${s.status === 'arquivado' ? 'Reativar' : 'Renovar'}</button><button class="btn sm ghost" data-editar="${s.id}">Editar</button></div></td>
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
    `Apagar <b>${alvo.length}</b> subscritor(es) e todo o histórico de pagamentos? ${nomes}.<br>Terás alguns segundos para desfazer.<br>
     <span class="muted small">Se só quiseres tirá-los dos ativos, apaga o PaymentDueDate (ficam arquivados) ou marca-os como cancelados.</span>`, 'Apagar');
  if (!ok) return;
  const ids = alvo.map((s) => s.id);
  S.sel.clear();
  comDesfazer(`${ids.length} subscritor(es) apagado(s).`,
    () => { S.subs = S.subs.filter((s) => !ids.includes(s.id)); renderPainel(); renderLista(); renderFinanceiro(); },
    async () => (await sb.from('subscribers').delete().in('id', ids)).error);
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

async function abrirSub(id, opc = {}) {
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
      <label class="check"><input type="checkbox" name="keep_active" ${v.keep_active ? 'checked' : ''}> Manter ligado mesmo com o pagamento em atraso</label>
      <label>… até (vazio = sem prazo)<input name="keep_active_until" type="date" value="${esc(v.keep_active_until)}"></label>
      ${s ? `<label class="check full"><input type="checkbox" name="cancelado" ${s.active ? '' : 'checked'}> Cancelado (deixa de contar e de aparecer nos avisos)</label>` : ''}
    </form>
    ${s ? '<div class="hist-head"><h3>Histórico de pagamentos</h3><button class="btn sm" id="btn-add-pag" type="button">+ Adicionar pagamento</button></div><div id="linha-temporal" class="linha-temporal"></div><div id="historico" class="muted">A carregar…</div>' : ''}
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
      keep_active_until: f.get('keep_active') ? t('keep_active_until') : null,
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
    const ok = await confirmar('Apagar subscritor', `Apagar <b>${esc(titulo(s))}</b> e todo o histórico? Terás alguns segundos para desfazer.<br><span class="muted small">Se apenas deixou de pagar, marca-o como cancelado em vez de apagar.</span>`, 'Apagar');
    if (!ok) return abrirSub(id);
    comDesfazer(`${s.code} apagado.`,
      () => { S.subs = S.subs.filter((x) => x.id !== s.id); renderPainel(); renderLista(); renderFinanceiro(); },
      async () => (await sb.from('subscribers').delete().eq('id', s.id)).error);
  });

  $('#btn-add-pag', corpo).addEventListener('click', () => abrirPagamento(s, null));
  const { data, error } = await sb.from('renewals').select('*').eq('subscriber_id', s.id).order('period_start', { ascending: false }).order('payment_date', { ascending: false });
  const h = $('#historico', corpo);
  if (!h) return;
  HIST = (data || []).filter((r) => r.id !== opc.esconderPag);
  if (error) h.textContent = 'Erro a carregar o histórico.';
  if (!error) desenharLinhaTemporal(s, $('#linha-temporal', corpo));
  if (error) { /* já tratado */ }
  else if (!HIST.length) h.textContent = 'Ainda sem pagamentos registados. Usa "+ Adicionar pagamento" para preencher o histórico.';
  else {
    h.classList.remove('muted');
    h.innerHTML = `<div class="scroll"><table class="tabela cartoes tabela-hist"><thead><tr><th>Data</th><th>Período</th><th class="num">Value</th><th class="num">Commission</th><th>Método</th><th>Pago</th><th>Notas</th><th></th></tr></thead><tbody>
      ${HIST.map((r) => `<tr><td data-label="Data">${fmtData(r.payment_date)}</td><td data-label="Período">${fmtData(r.period_start)} → ${fmtData(r.period_end)}</td>
        <td class="num" data-label="Value">${eur(r.value)}</td><td class="num" data-label="Commission">${eur(r.commission)}</td><td data-label="Método">${esc(r.payment_method || '—')}</td>
        <td data-label="Pago">${r.paid ? 'Sim' : '<span class="badge a_terminar">Não</span>'}</td><td data-label="Notas">${esc(r.notes || '')}</td>
        <td class="c-acoes"><div class="acoes"><button class="btn sm ghost" type="button" data-edit-pag="${r.id}">Editar</button><button class="btn sm ghost danger" type="button" data-del-pag="${r.id}">Apagar</button></div></td></tr>`).join('')}
    </tbody></table></div>`;
    h.addEventListener('click', async (e) => {
      const ed = e.target.closest('[data-edit-pag]'), del = e.target.closest('[data-del-pag]');
      if (ed) return abrirPagamento(s, HIST.find((r) => r.id === ed.dataset.editPag));
      if (del) {
        const r = HIST.find((x) => x.id === del.dataset.delPag);
        const ok = await confirmar('Apagar pagamento', `Apagar o pagamento de <b>${fmtData(r.payment_date)}</b> (${fmtData(r.period_start)} → ${fmtData(r.period_end)}, ${eur(r.value)}) do histórico de <b>${esc(s.code)}</b>?<br><span class="muted small">O PaymentDueDate do subscritor não é alterado. Terás alguns segundos para desfazer.</span>`, 'Apagar');
        if (!ok) return abrirSub(s.id);
        comDesfazer('Pagamento apagado do histórico.',
          () => { HIST = HIST.filter((x) => x.id !== r.id); abrirSub(s.id, { esconderPag: r.id }); },
          async () => (await sb.from('renewals').delete().eq('id', r.id)).error);
      }
    });
  }
}
let HIST = [];

// ---------- linha temporal do histórico (blocos por período; buracos a vermelho)
function desenharLinhaTemporal(s, el) {
  if (!el) return;
  const hoje = hojeISO();
  const pers = HIST.map((r) => ({ a: r.period_start, b: r.period_end, r })).filter((x) => x.a && x.b && x.b > x.a).sort((x, y) => (x.a < y.a ? -1 : 1));
  if (!pers.length && !s.payment_due_date) { el.innerHTML = ''; return; }
  const ini0 = pers.length ? pers[0].a : somaMeses(s.payment_due_date, -mesesDe(s.periodicity));
  const fimMax = [hoje, s.payment_due_date, ...pers.map((x) => x.b)].filter(Boolean).sort().pop();
  const ini = somaMeses(ini0.slice(0, 8) + '01', 0), fim = somaMeses(fimMax.slice(0, 8) + '01', 1);
  const total = diasEntre(ini, fim) || 1;
  const pos = (d) => Math.max(0, Math.min(100, (diasEntre(ini, d) / total) * 100));
  // buracos: dias sem nenhum período, entre o primeiro pagamento e o PaymentDueDate (ou hoje)
  const limite = s.payment_due_date && s.payment_due_date < hoje ? s.payment_due_date : (s.payment_due_date || hoje);
  const buracos = [];
  let cob = pers.length ? pers[0].a : null;
  for (const x of pers) {
    if (cob && diasEntre(cob, x.a) > 1) buracos.push([cob, x.a]);
    if (!cob || x.b > cob) cob = x.b;
  }
  if (cob && limite && diasEntre(cob, limite) > 1) buracos.push([cob, limite]);
  const anos = [];
  for (let y = Number(ini.slice(0, 4)) + 1; `${y}-01-01` < fim; y++) anos.push(`${y}-01-01`);
  el.innerHTML = `
    <div class="lt-pista">
      ${anos.map((d) => `<span class="lt-ano" style="left:${pos(d)}%"><b>${d.slice(0, 4)}</b></span>`).join('')}
      ${buracos.map(([a, b]) => `<span class="lt-buraco" style="left:${pos(a)}%;width:${Math.max(0.6, pos(b) - pos(a))}%" title="Sem pagamento registado: ${fmtData(a)} → ${fmtData(b)} (${diasEntre(a, b)} dias)"></span>`).join('')}
      ${pers.map((x) => `<span class="lt-bloco ${x.r.paid ? 'pago' : 'npago'}" style="left:${pos(x.a)}%;width:${Math.max(0.6, pos(x.b) - pos(x.a))}%" title="${fmtData(x.a)} → ${fmtData(x.b)} · ${eur(x.r.value)}${x.r.payment_method ? ' · ' + esc(x.r.payment_method) : ''} · ${x.r.paid ? 'pago' : 'não pago'}"></span>`).join('')}
      <span class="lt-marca hoje" style="left:${pos(hoje)}%" title="Hoje"></span>
      ${s.payment_due_date ? `<span class="lt-marca due" style="left:${pos(s.payment_due_date)}%" title="PaymentDueDate ${fmtData(s.payment_due_date)}"></span>` : ''}
    </div>
    <div class="lt-eixo"><span>${fmtData(ini)}</span><span>${fmtData(fim)}</span></div>
    <div class="lt-legenda"><span><i class="pago"></i>pago</span><span><i class="npago"></i>não pago</span><span><i class="buraco"></i>sem pagamento registado${buracos.length ? ` (${buracos.length})` : ''}</span><span><i class="hoje"></i>hoje</span><span><i class="due"></i>PaymentDueDate</span></div>`;
}

// ---------------------------------------------------------------- histórico: adicionar / editar pagamento
function abrirPagamento(s, r) {
  const novo = !r;
  // Sugestão para um pagamento novo: o período imediatamente antes do pagamento mais antigo (ou do PaymentDueDate)
  const maisAntigo = HIST.length ? HIST.reduce((a, x) => (x.period_start < a ? x.period_start : a), HIST[0].period_start) : null;
  const fimSug = maisAntigo || s.payment_due_date || hojeISO();
  const iniSug = somaMeses(fimSug, -mesesDe(s.periodicity));
  const v = r ?? { payment_date: iniSug, period_start: iniSug, period_end: fimSug, value: s.value, commission: s.commission, paid: true, payment_method: '', notes: '' };
  const metodos = [...new Set([...S.metodos, ...(v.payment_method ? [v.payment_method] : [])])];

  const corpo = abrirModal(`${novo ? 'Adicionar pagamento' : 'Editar pagamento'} — ${titulo(s)}`, `
    ${novo ? `<div class="info">Fica só no histórico: o PaymentDueDate atual (<b>${s.payment_due_date ? fmtData(s.payment_due_date) : 'sem data'}</b>) não muda, a não ser que marques a opção no fim.</div>` : ''}
    <form class="form" id="form-pag" style="margin-top:14px">
      <label>Data do pagamento *<input name="payment_date" type="date" required value="${esc(v.payment_date)}"></label>
      <label>Método de pagamento<select name="method"><option value="">— escolher —</option>${metodos.map((m) => `<option ${m === v.payment_method ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>
      <label>Início do período *<input name="period_start" type="date" required value="${esc(v.period_start)}"></label>
      <label>Fim do período *<input name="period_end" type="date" required value="${esc(v.period_end)}"></label>
      <label>Value<input name="value" type="number" step="0.01" min="0" value="${esc(v.value)}"></label>
      <label>Commission<input name="commission" type="number" step="0.01" min="0" value="${esc(v.commission)}"></label>
      <label class="check full"><input type="checkbox" name="paid" ${v.paid ? 'checked' : ''}> Pago</label>
      <label class="full">Notas<input name="notes" value="${esc(v.notes)}"></label>
      ${novo ? `<label class="check full"><input type="checkbox" name="atualizar_due"> Atualizar também o PaymentDueDate para o fim deste período</label>` : ''}
    </form>
    <div class="row end"><button class="btn" type="button" id="btn-voltar">Voltar</button><button class="btn primary" type="button" id="btn-gravar-pag">${novo ? 'Adicionar' : 'Guardar'}</button></div>`);

  const form = $('#form-pag', corpo);
  // ao mudar o início, sugere o fim conforme a avença (até ser alterado à mão)
  let fimManual = !novo;
  form.period_end.addEventListener('change', () => { fimManual = true; });
  form.period_start.addEventListener('change', () => {
    if (!fimManual && form.period_start.value) form.period_end.value = somaMeses(form.period_start.value, mesesDe(s.periodicity));
  });
  $('#btn-voltar', corpo).addEventListener('click', () => abrirSub(s.id));
  $('#btn-gravar-pag', corpo).addEventListener('click', async (e) => {
    if (!form.reportValidity()) return;
    const f = new FormData(form);
    if (f.get('period_end') <= f.get('period_start')) return toast('O fim do período tem de ser depois do início.', true);
    const reg = {
      payment_date: f.get('payment_date'),
      period_start: f.get('period_start'),
      period_end: f.get('period_end'),
      value: Number(f.get('value')) || 0,
      commission: Number(f.get('commission')) || 0,
      paid: !!f.get('paid'),
      payment_method: f.get('method') || null,
      notes: (f.get('notes') || '').trim() || null,
    };
    e.target.disabled = true;
    const { error } = novo
      ? await sb.from('renewals').insert({ ...reg, subscriber_id: s.id })
      : await sb.from('renewals').update(reg).eq('id', r.id);
    if (error) { e.target.disabled = false; return toast('Erro ao gravar: ' + error.message, true); }
    if (novo && f.get('atualizar_due')) {
      const upd = { payment_due_date: reg.period_end };   // o LastPaymentDate é atualizado pela base de dados
      const { error: e2 } = await sb.from('subscribers').update(upd).eq('id', s.id);
      if (e2) toast('Pagamento gravado, mas não consegui atualizar o PaymentDueDate: ' + e2.message, true);
    }
    toast(novo ? 'Pagamento adicionado ao histórico.' : 'Pagamento atualizado.');
    await carregar();
    abrirSub(s.id);
  });
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
      <label>Método de pagamento<select name="method"><option value="">— escolher —</option>${S.metodos.map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
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
      p_method: f.get('method') || null,
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
  renderMetodos();
  if (document.activeElement !== $('#wa-template')) { $('#wa-template').value = S.waTemplate; previewWA(); }
  const cont = (t) => S.subs.filter((s) => s.type === t).length;
  if (S.erroCustos) {
    $('#tabela-custos tbody').innerHTML = `<tr><td colspan="4" class="erro" style="white-space:normal">Não consegui ler os custos: ${esc(S.erroCustos)}.<br>
      Confirma que correste <b>supabase/migrations/004_custos_type.sql</b> no SQL Editor do Supabase.</td></tr>`;
    $('#aviso-tipos').innerHTML = '';
    return;
  }
  $('#tabela-custos tbody').innerHTML = S.custos.map((c) => `<tr${estiloType(c.type)}>
      <td>${chipType(c.type)} <input type="color" value="${esc(c.color && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : '#888888')}" data-cor="${esc(c.type)}" title="Cor do Type ${esc(c.type)}" style="vertical-align:middle;margin-left:6px"></td>
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
    const cor = $(`[data-cor="${CSS.escape(type)}"]`).value;
    const { error } = await sb.from('type_costs').update({ monthly_cost: v, color: cor, updated_at: new Date().toISOString() }).eq('type', type);
    if (error) return toast('Erro ao guardar: ' + error.message, true);
    toast(`Type ${type} atualizado.`);
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
  const { error } = await sb.from('type_costs').insert({ type, monthly_cost: v, color: $('#novo-cor').value });
  if (error) return toast(error.code === '23505' ? `O Type ${type} já existe.` : 'Erro: ' + error.message, true);
  $('#novo-type').value = ''; $('#novo-custo').value = '';
  toast(`Custo de ${type} adicionado.`);
  carregar();
});

// ---------------------------------------------------------------- configuração: métodos de pagamento
function renderMetodos() {
  const usados = (m) => S.pagamentos.filter((p) => p.payment_method === m).length;
  $('#tabela-metodos tbody').innerHTML = S.metodos.map((m) => `<tr><td><b>${esc(m)}</b></td><td class="num">${usados(m)}</td>
      <td><div class="acoes"><button class="btn sm ghost danger" data-apagar-metodo="${esc(m)}">Apagar</button></div></td></tr>`).join('')
    || '<tr><td colspan="3" class="vazio">Sem métodos definidos.</td></tr>';
}
$('#tabela-metodos').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-apagar-metodo]');
  if (!b) return;
  const m = b.dataset.apagarMetodo;
  if (!(await confirmar('Apagar método', `Retirar <b>${esc(m)}</b> da lista? Os pagamentos já registados com este método mantêm-no.`, 'Apagar'))) return;
  const { error } = await sb.from('payment_methods').delete().eq('name', m);
  if (error) return toast('Erro: ' + error.message, true);
  carregar();
});
$('#btn-add-metodo').addEventListener('click', async () => {
  const name = $('#novo-metodo').value.trim();
  if (!name) return toast('Indica o nome do método.', true);
  const { error } = await sb.from('payment_methods').insert({ name, sort_order: S.metodos.length + 1 });
  if (error) return toast(error.code === '23505' ? `${name} já existe.` : 'Erro: ' + error.message, true);
  $('#novo-metodo').value = '';
  toast(`Método ${name} adicionado.`);
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
const ACOES = { criar: 'Criar', editar: 'Editar', renovar: 'Renovar', pagamento: 'Pagamento (histórico)', editar_pag: 'Editar pagamento', apagar_pag: 'Apagar pagamento', apagar: 'Apagar', aviso: 'Aviso copiado', ligar: 'Manter ligado', desligar: 'Desligar', config: 'Configuração' };
const CAMPO = {
  code: 'ID', payment_due_date: 'PaymentDueDate', last_payment_date: 'LastPaymentDate', value: 'Value', commission: 'Commission',
  owner: 'Owner', type: 'Type', hw: 'HW', periodicity: 'Avença', active: 'Ativo', keep_active: 'Manter ligado', keep_active_until: 'Manter ligado até',
  notes: 'Notas', last_notified_at: 'Aviso copiado em', monthly_cost: 'Custo mensal',
  payment_date: 'Data do pagamento', period_start: 'Início do período', period_end: 'Fim do período', paid: 'Pago', payment_method: 'Método',
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
      const { active, keep_active, keep_active_until, ...resto } = d;
      return lista(resto);
    }
    case 'editar': return difs(d);
    case 'editar_pag': return difs(d);
    case 'apagar_pag':
    case 'pagamento':
    case 'renovar':
      return `Pagamento a <b>${fmtData(d.payment_date)}</b> · período ${fmtData(d.period_start)} → <b>${fmtData(d.period_end)}</b> · Value <b>${eur(d.value)}</b> · Commission ${eur(d.commission)} · ${d.payment_method ? 'método <b>' + esc(d.payment_method) + '</b> · ' : ''}${d.paid ? 'pago' : '<b>não pago</b>'}${d.notes ? ' · ' + esc(d.notes) : ''}`;
    case 'aviso': return 'Mensagem de aviso copiada para o WhatsApp';
    case 'ligar': return `Mantido ligado com o pagamento em atraso${d.keep_active_until?.[1] ? ` até <b>${fmtData(d.keep_active_until[1])}</b>` : ' (sem prazo)'}`;
    case 'desligar': return 'Passou a desligado';
    case 'config': {
      const alvo = r.entity === 'type_cost' ? `Custo do Type <b>${esc(r.record_id)}</b>` : r.entity === 'payment_method' ? `Método de pagamento <b>${esc(r.record_id)}</b>` : `Definição <b>${r.record_id === 'whatsapp_template' ? 'mensagem de WhatsApp' : esc(r.record_id)}</b>`;
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
      <td data-label="Data/hora">${fmtHora(r.at)}</td>
      <td data-label="Utilizador">${esc(r.user_email || '—')}</td>
      <td data-label="Ação"><span class="badge a-${r.action}">${ACOES[r.action] || esc(r.action)}</span></td>
      <td data-label="ID">${r.code ? `<b>${esc(r.code)}</b>` : '—'}</td>
      <td class="c-det">${detalhesAud(r)}</td></tr>`).join('');
  $('#audit-info').textContent = AUD.linhas.length ? '' : 'Sem registos.';
  $('#audit-info').classList.toggle('hidden', AUD.linhas.length > 0);
  $('#a-mais').classList.toggle('hidden', data.length < AUD.tam);
}
let tAud;
$('#a-pesquisa').addEventListener('input', () => { clearTimeout(tAud); tAud = setTimeout(() => carregarAuditoria(true), 300); });
$('#a-acao').addEventListener('change', () => carregarAuditoria(true));
$('#a-atualizar').addEventListener('click', () => carregarAuditoria(true));
$('#a-mais').addEventListener('click', () => carregarAuditoria(false));

// ---------------------------------------------------------------- sessão com tempo limite
// Termina a sessão após SESSAO_MINUTOS sem atividade (partilhado entre separadores do browser).
const SESSAO_MS = (Number(SESSAO_MINUTOS) || 0) * 60000;
const marcarAtividade = () => gravarLS('sessao.ultima', Date.now());
if (SESSAO_MS > 0) {
  let ult = 0;
  ['click', 'keydown', 'touchstart', 'scroll', 'mousemove'].forEach((ev) => document.addEventListener(ev, () => {
    if (Date.now() - ult > 15000) { ult = Date.now(); marcarAtividade(); }   // no máximo a cada 15 s
  }, { passive: true }));
  const verificar = async () => {
    if ($('#app-view').classList.contains('hidden')) return;
    const ultima = Number(lerLS('sessao.ultima', 0)) || Date.now();
    if (Date.now() - ultima > SESSAO_MS) {
      await sb.auth.signOut();
      fecharModal();
      $('#login-erro').textContent = `Sessão terminada após ${SESSAO_MINUTOS} minutos sem atividade.`;
    }
  };
  setInterval(verificar, 30000);
  setTimeout(verificar, 1500);   // ao abrir a app: sessão antiga sem atividade termina logo
  document.addEventListener('visibilitychange', () => { if (!document.hidden) verificar(); });
}

// ---------------------------------------------------------------- tema (automático / claro / escuro)
const TEMAS = ['auto', 'light', 'dark'];
const ROT_TEMA = { auto: '◐ Auto', light: '☀️ Claro', dark: '🌙 Escuro' };
function aplicarTema(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { t === 'auto' ? localStorage.removeItem('tema') : localStorage.setItem('tema', t); } catch { /* */ }
  $('#btn-tema').textContent = ROT_TEMA[t];
}
let temaAtual = (() => { try { return localStorage.getItem('tema') || 'auto'; } catch { return 'auto'; } })();
aplicarTema(temaAtual);
$('#btn-tema').addEventListener('click', () => { temaAtual = TEMAS[(TEMAS.indexOf(temaAtual) + 1) % 3]; aplicarTema(temaAtual); toast(`Tema: ${ROT_TEMA[temaAtual]}`); });

// ---------------------------------------------------------------- app instalável (PWA)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('./sw.js').catch(() => { /* sem service worker: a app funciona na mesma */ });
}

// ---------------------------------------------------------------- arranque
(async () => {
  const { data: { session } } = await sb.auth.getSession();
  mostrar(session);
  sb.auth.onAuthStateChange((_e, sess) => mostrar(sess));
})();
