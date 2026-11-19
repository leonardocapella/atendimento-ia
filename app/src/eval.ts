// Evals EV1–EV8 (T6). Vetos em código, temperatura 0, 3/3.
// Sem LLM_BASE_URL+LLM_MODEL o comando avisa e sai 0: o CI não fica vermelho por rate limit.
// O gate de publicação exige o modelo de produção (D2 ainda não escolhido).
import { readFileSync } from 'node:fs';
import { loadConfig } from './agent/config.ts';
import { llmTargets, withFallback, type Chat } from './agent/llm.ts';
import { fullSystem, parseOut, type Out } from './agent/prompt.ts';

type Caso = { id: string; tipo: 'llm' | 'codigo'; cliente: string; sem_confirmacao?: boolean };
const casos: Caso[] = JSON.parse(readFileSync(new URL('../evals/ficticio/casos.json', import.meta.url), 'utf8')).casos;

const duasPessoas = (t: string) => (t.match(/\b(eu sou|me chamo|aqui é)\b/gi) ?? []).length > 1;

export function veto(c: Caso, o: Out): string | null {
  if (c.id === 'EV1' && duasPessoas(o.resposta)) return 'duas apresentações';
  if (c.id === 'EV3' && /\bTF\b/.test(o.resposta)) return 'usou nome de perfil TF';
  if (c.id === 'EV4' && /voc[eê] me (enviou|mandou)/i.test(o.resposta)) return 'tratou mídia da IA como do cliente';
  if (c.id === 'EV5' && c.sem_confirmacao && /\benviei\b/i.test(o.resposta)) return 'afirmou envio sem confirmação';
  if (c.id === 'EV6' && o.decisao === 'transferir') return '"Sim" não transfere';
  if (c.id === 'EV8' && o.decisao === 'transferir') return 'pergunta sobre o modelo não transfere';
  if (!['EV1', 'EV3', 'EV4', 'EV5', 'EV6', 'EV8'].includes(c.id) && c.tipo === 'llm') return `veto sem regra: ${c.id}`;
  return null;
}

export type Resultado = { id: string; ok: boolean; motivo: string };
const VEZES = 3;

export async function runEval(chat: Chat | null, vezes = VEZES): Promise<{ resultados: Resultado[]; llmRodou: boolean }> {
  const { config } = loadConfig();
  const agent = config.agentes.vendas;
  const system = fullSystem(agent, { nome: null, apresentou: false, foraDoHorario: false, campos: {}, produtos: [] });
  const resultados: Resultado[] = [];
  for (const c of casos) {
    if (c.tipo === 'codigo') { resultados.push({ id: c.id, ok: true, motivo: 'coberto pelo motor (engine.test)' }); continue; }
    if (!chat) { resultados.push({ id: c.id, ok: true, motivo: 'pulado: sem LLM' }); continue; }
    const fails: string[] = [];
    for (let i = 0; i < vezes; i++) {
      try {
        const o = parseOut(await chat([{ role: 'system', content: system }, { role: 'user', content: c.cliente }], { json: true, temperature: 0 }));
        const v = veto(c, o);
        if (v) fails.push(v);
      } catch (e: any) { fails.push(e.message); }
    }
    resultados.push({ id: c.id, ok: fails.length === 0, motivo: fails.length ? `${fails.length}/${vezes}: ${fails[0]}` : `${vezes}/${vezes}` });
  }
  return { resultados, llmRodou: Boolean(chat) };
}

// Gate de virada: os vetos de modelo só valem se rodaram no LLM de produção.
export function prontoParaPublicar(r: { resultados: Resultado[]; llmRodou: boolean }, aprovado: boolean) {
  return aprovado && r.llmRodou && r.resultados.every((x) => x.ok);
}

if (import.meta.main) {
  const chat = withFallback(llmTargets(), 30_000) ?? null;
  if (!chat) console.log('AVISO: LLM não configurado. EVs de modelo pulados. Gate de publicação fechado.');
  const r = await runEval(chat);
  for (const x of r.resultados) console.log(`${x.ok ? 'ok' : 'FALHOU'} ${x.id} ${x.motivo}`);
  if (chat && r.resultados.some((x) => !x.ok)) process.exitCode = 1;
}
