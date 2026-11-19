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

// Primeiras frases. Se a pergunta ficou depois do corte, ela entra no lugar da última.
export function capFrases(text: string, max = 3): string {
  const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length <= max) return text.trim();
  const q = parts.findIndex((p) => p.includes('?'));
  const kept = q >= max ? [...parts.slice(0, max - 1), parts[q]] : parts.slice(0, max);
  return kept.join(' ');
}

// Prévia: o modelo transferia e ainda perguntava a cidade. As duas coisas juntas não saem.
const SO_OLA = /^(oi|ol[aá]|opa|hey|e a[ií]|bom dia|boa tarde|boa noite|tudo bem)[!,.?\s]*$/i;

// Teste ao vivo: "Opa, qro comprar um armário" voltou só "como posso te ajudar?".
// Cumprimento puro fica como o modelo escreveu. O resto perde a frase genérica e ganha a próxima pergunta se não houver nenhuma.
export function primeiraFala(resposta: string, cliente: string, proxima: string): string {
  if (SO_OLA.test(cliente.trim())) return resposta.trim();
  let r = resposta.replace(/\s*como posso te ajudar\??/gi, '').replace(/\s{2,}/g, ' ').trim();
  if (!r.includes('?') && proxima) {
    r = r.replace(/[.!\s]+$/, '');
    r = r ? `${r}. ${proxima}` : proxima;
  }
  return capFrases(r);
}

export function guardReply(out: Out): Out {
  const resposta = capFrases(out.resposta);
  if (out.decisao === 'transferir' && resposta.includes('?'))
    return { ...out, resposta, decisao: 'responder', motivo: null };
  return { ...out, resposta };
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
    c.apresentou ? 'Você JÁ se apresentou nesta conversa: não se apresente de novo.' : 'Primeira fala: apresente-se. Se o cliente já disse o que quer, pergunte o próximo campo da qualificação. Nunca "como posso te ajudar".',
    c.nome ? `Nome do cliente: ${c.nome}. Use esse nome. Não pergunte como chamar.` : 'Nome do cliente desconhecido: não use nome nenhum; pergunte durante a qualificação.',
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
 "campos": {${chaves.map((k) => `"${k}": valor ou null`).join(', ')}}, "sinal_compra": true só se o cliente quer fechar, proposta ou orçamento (medidas, prazo ou "quanto custa" não bastam), "enviar_produtos": ["código"]}
Pedido de preço não é transbordo. Fora do que a empresa faz (ex.: armário para carro) também não: explique com educação e deixe decisao em responder. Transfira só por um motivo da lista. Nunca transfira e faça uma pergunta na mesma fala: se falta campo, decisao é responder. No máximo 3 frases.`,
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
// skip: brain_send_ids que não respondem o cliente (ex.: mensagem de ausência), para a reativação achar o turno.
export function currentTurn(history: CwMsg[], skip: Set<string> = new Set()): CwMsg[] {
  const turn: CwMsg[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (skip.has(history[i].content_attributes?.brain_send_id ?? '')) continue;
    const who = authorOf(history[i]);
    if (who === 'ia' || who === 'humano') break;
    if (who === 'cliente') turn.unshift(history[i]);
  }
  return turn;
}
