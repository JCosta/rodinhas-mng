// Exporta todas as tabelas do Supabase para um ficheiro JSON (backup/rodinhas-AAAA-MM-DD.json).
// Corre na GitHub Action .github/workflows/backup.yml, que depois o encripta antes de o guardar.
import { mkdirSync, writeFileSync } from 'node:fs';

const { SUPABASE_URL, SUPABASE_SECRET_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.log('::warning::Secret SUPABASE_SECRET_KEY em falta — backup não feito.');
  process.exit(0);
}

// tabela → coluna para ordenar (paginação estável)
const TABELAS = { subscribers: 'id', renewals: 'id', type_costs: 'type', payment_methods: 'name', resellers: 'id', app_settings: 'key', admins: 'user_id', audit_log: 'id' };
const PAGINA = 1000;

async function exportar(tabela) {
  const linhas = [];
  for (let de = 0; ; de += PAGINA) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${tabela}?select=*&order=${TABELAS[tabela]}`, {
      headers: { apikey: SUPABASE_SECRET_KEY, Range: `${de}-${de + PAGINA - 1}`, 'Range-Unit': 'items' },
    });
    if (!res.ok) throw new Error(`${tabela}: HTTP ${res.status} ${await res.text()}`);
    const lote = await res.json();
    linhas.push(...lote);
    if (lote.length < PAGINA) break;
  }
  return linhas;
}

const dados = { gerado_em: new Date().toISOString(), origem: SUPABASE_URL, tabelas: {} };
for (const t of Object.keys(TABELAS)) {
  dados.tabelas[t] = await exportar(t);
  console.log(`${t}: ${dados.tabelas[t].length} linhas`);
}

mkdirSync('backup', { recursive: true });
const nome = `backup/rodinhas-${dados.gerado_em.slice(0, 10)}.json`;
writeFileSync(nome, JSON.stringify(dados, null, 1));
console.log('Exportado para', nome);
