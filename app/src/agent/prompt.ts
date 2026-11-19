// Contrato de saída do LLM (schema único: resposta + decisão + campos + motivo) e montagem do histórico com autoria.
import { z } from 'zod';
import { systemPrompt, type AgentConfig } from './config.ts';
import { authorOf, type CwMsg } from '../chatwoot.ts';
import type { Msg, Part } from './llm.ts';

// RQ6: o LLM só pode pedir estes; lead_quente é decidido em código, falha_tecnica pelo worker.
export const MOTIVOS_LLM = ['pedido_cliente', 'insatisfacao', 'pergunta_fora_do_escopo'] as const;

export const Out = z.object({
  resposta: z.string().trim().min(1).max(2000),
  decisao: z.enum(['responder', 'transferir']),
  motivo: z.string().nullish(),
  justificativa: z.string().nullish(),
  campos: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  sinal_compra: z.boolean().default(false),
  enviar_produtos: z.array(z.string()).max(3).default([]),
});
export type Out = z.infer<typeof Out>;

export function parseOut(text: string): Out {
  const json = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  return Out.parse(JSON.parse(json));
}

// RQ3: nome do perfil só se parecer nome de pessoa.
export function validName(n?: string | null): string | null {
  const full = (n ?? '').trim(), first = full.split(/\s+/)[0] ?? '';
  if (!/^\p{L}{3,}$/u.test(first)) return null;                       // "TF", "J.", emoji, números
  if (first.length <= 4 && first === first.toUpperCase()) return null;  // sigla
  if (/\b(ltda|me|eireli|mei|loja|store|com[eé]rcio|empresa|oficial|distribuidora)\b/iu.test(full)) return null;
  return first[0].toUpperCase() + first.slice(1).toLowerCase();
}

export type Ctx = {
  nome: string | null; apresentou: boolean; foraDoHorario: boolean;
  campos: Record<string, unknown>; produtos: { codigo: string; nome: string; preco_centavos: number | null; disponivel: boolean }[];
  ferramenta?: string;   // resultado de enviar_midia, na 2ª chamada
};

const brl = (c: number | null) => (c == null ? 'sob consulta' : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

export function fullSystem(a: AgentConfig, c: Ctx): string {
  const chaves = a.regras.perguntas_qualificacao.map((p) => p.chave);
  return [
    systemPrompt(a),
    '\n## Contexto desta conversa',
    c.apresentou ? 'Você JÁ se apresentou nesta conversa: não se apresente de novo.' : 'Ainda não se apresentou: apresente-se uma vez.',
    c.nome ? `Nome do cliente: ${c.nome}.` : 'Nome do cliente desconhecido: não use nome nenhum; pergunte durante a qualificação.',
    `Campos já coletados: ${JSON.stringify(c.campos)}`,
    c.foraDoHorario && 'Agora está fora do expediente: não prometa retorno humano imediato.',
    c.produtos.length && `\nProdutos (código | nome | preço | disponível):\n${c.produtos.map((p) => `${p.codigo} | ${p.nome} | ${brl(p.preco_centavos)} | ${p.disponivel ? 'sim' : 'não'}`).join('\n')}`,
    '\nNo histórico, [CLIENTE ENVIOU ...] é mídia do cliente e [VOCÊ ENVIOU ...] é mídia que você enviou. Nunca descreva mídia sua como se fosse do cliente.',
    c.ferramenta
      ? `\n## Resultado de enviar_midia\n${c.ferramenta}\nSó diga "enviei" para o que foi entregue. Se ficou sem confirmação, não afirme nada: pergunte se o cliente conseguiu ver.${a.conhecimento.catalogo_url ? ` Se falhou, mande o link do catálogo: ${a.conhecimento.catalogo_url}` : ''}`
      : '\nPara enviar foto de produto, coloque o código em enviar_produtos e NÃO diga no texto que enviou; você receberá o resultado.',
    `\n## Formato da resposta
Responda SOMENTE com um JSON:
{"resposta": "texto para o cliente", "decisao": "responder" | "transferir", "motivo": null | ${MOTIVOS_LLM.map((m) => `"${m}"`).join(' | ')}, "justificativa": null | "por quê",
 "campos": {${chaves.map((k) => `"${k}": valor ou null`).join(', ')}}, "sinal_compra": true se o cliente quer comprar/orçamento, "enviar_produtos": ["código"]}
Transfira só por um dos motivos da lista. Mesmo transferindo, escreva a resposta ao cliente.`,
  ].filter(Boolean).join('\n');
}

const mark = (who: 'CLIENTE ENVIOU' | 'VOCÊ ENVIOU', m: CwMsg) => (m.attachments ?? []).map((a) => `[${who} ${a.file_type}${who === 'VOCÊ ENVIOU' && m.content ? `: ${m.content}` : ''}]`);

// Histórico → mensagens do LLM. images: data URLs das imagens do cliente no turno atual (só elas passam pela visão).
export function buildMessages(system: string, history: CwMsg[], images: Map<number, string> = new Map()): Msg[] {
  const byId = new Map(history.map((m) => [m.id, m]));
  const out: Msg[] = [{ role: 'system', content: system }];
  for (const m of history.slice(-30)) {
    const who = authorOf(m);
    if (!who) continue;
    const quoted = m.content_attributes?.in_reply_to ? byId.get(m.content_attributes.in_reply_to) : undefined;
    const lines = [
      quoted && `[respondendo a: ${authorOf(quoted) === 'cliente' ? 'mensagem do cliente' : 'sua mensagem'} "${quoted.content ?? ''}" ${mark(authorOf(quoted) === 'cliente' ? 'CLIENTE ENVIOU' : 'VOCÊ ENVIOU', quoted).join(' ')}]`,
      who === 'humano' && '[ATENDENTE HUMANO]',
      ...mark(who === 'cliente' ? 'CLIENTE ENVIOU' : 'VOCÊ ENVIOU', m),
      who === 'ia' && m.attachments?.length ? '' : m.content,
    ].filter(Boolean).join('\n');
    const img = images.get(m.id);
    const content: string | Part[] = img ? [{ type: 'text', text: lines }, { type: 'image_url', image_url: { url: img } }] : lines;
    out.push({ role: who === 'cliente' ? 'user' : 'assistant', content });
  }
  return out;
}

// Mensagens do cliente depois da última fala nossa (IA ou humano) = turno atual.
export function currentTurn(history: CwMsg[]): CwMsg[] {
  const turn: CwMsg[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const who = authorOf(history[i]);
    if (who === 'ia' || who === 'humano') break;
    if (who === 'cliente') turn.unshift(history[i]);
  }
  return turn;
}
