// Configuração pública do Supabase.
// A publishable key pode estar no código: a proteção dos dados é feita pelo login + RLS.
// NUNCA colocar aqui a secret / service_role key.
export const SUPABASE_URL = 'https://byrukjbyhbkjvvlcntqi.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_a6_YtBlnmqnal7XGoVZsGw_J8tDE6ch';

// Dias de antecedência para considerar uma avença "a terminar"
export const DIAS_AVISO = 30;

// Opções da lista "HW". Edita esta lista para os teus valores.
// (Valores já existentes nos dados que não estejam aqui continuam a aparecer.)
export const HW_OPCOES = [
  // 'Exemplo A',
  // 'Exemplo B',
];
