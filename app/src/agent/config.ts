// Config dos agentes (D3): no F1 vem de config/ebm.yaml versionado, não do banco.
// O schema é a fonte de verdade das 4 etapas; o editor visual (F1.5) vai gravar este mesmo formato.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const hora = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');
const faixas = z.array(z.tuple([hora, hora]).refine(([a, b]) => a < b, 'início deve ser antes do fim'));
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'] as const;

const Agent = z.object({
  nome_interno: z.string().min(1),          // ex.: "Vendas" (no painel)
  inbox_ids: z.array(z.number().int()).default([]),
  status: z.enum(['teste', 'live']).default('teste'),   // live exige LLM aprovado para produção (regra 10)

  // Etapa 1: comportamento e tom de voz
  comportamento: z.object({
    nome: z.string().min(1),                // nome de apresentação (RQ1: único)
    saudacao: z.string().min(1),
    funcao: z.string().min(1),
    tom: z.enum(['formal', 'neutro', 'amigavel', 'energetico']),
    idioma: z.string().default('pt-BR'),
    fuso: z.string().default('America/Sao_Paulo'),
  }),

  // Etapa 2: regras, roteiro e limites
  regras: z.object({
    perguntas_qualificacao: z.array(z.object({
      chave: z.string().regex(/^[a-z_]+$/),
      pergunta: z.string().min(1),
      obrigatorio: z.boolean().default(true),
      tipo: z.enum(['texto', 'numero', 'data', 'sim_nao']).default('texto'),
    })).min(1),
    instrucoes_prioritarias: z.array(z.string()).default([]),
    regras_negocio: z.array(z.string()).default([]),
    nao_prometer: z.array(z.string()).default([]),
    transbordo: z.object({
      frases_pedido: z.array(z.string().min(3)).default([]),   // atalho sem LLM (regra 2)
      lead_quente: z.object({
        campos_obrigatorios: z.array(z.string()).min(1),
        exige_sinal_compra: z.boolean().default(true),
      }),
      destino: z.object({ user_id: z.number().int().optional(), team_id: z.number().int().optional() })
        .refine((d) => d.user_id || d.team_id, 'defina user_id ou team_id'),
      backup_team_id: z.number().int().optional(),
      sla_min: z.number().int().positive().default(10),
      sla2_min: z.number().int().positive().default(30),
      msg_passagem: z.string().min(1),
      msg_espera: z.string().min(1),
      msg_falha: z.string().default('Já vou te passar para um atendente.'),
      msg_pedir_texto: z.string().default('Consegue me mandar por escrito? Assim te respondo mais rápido.'),
    }),
  }),

  // Etapa 3: conhecimento e oferta (texto no F1; PDF/RAG no F2)
  conhecimento: z.object({
    biografia: z.string().min(1),
    publico_alvo: z.string().default(''),
    diferenciais: z.array(z.string()).default([]),
    objetivo: z.string().min(1),
    pagamento: z.string().default(''),
    entrega: z.string().default(''),
    enderecos: z.array(z.string()).default([]),
    redes: z.record(z.string(), z.string()).default({}),
    catalogo_url: z.string().url().optional(),
  }),

  // Etapa 4: horários e automação
  horario: z.object({
    dias: z.partialRecord(z.enum(DIAS), faixas).default({}),
    responder_fora_do_horario: z.boolean().default(true),
    msg_ausencia: z.string().default(''),
    followup: z.object({ intervalo_min: z.number().int().positive().default(60), tentativas: z.number().int().min(0).default(3) }).default({ intervalo_min: 60, tentativas: 3 }),
  }),
}).superRefine((a, ctx) => {
  const chaves = new Set(a.regras.perguntas_qualificacao.map((p) => p.chave));
  for (const c of a.regras.transbordo.lead_quente.campos_obrigatorios)
    if (!chaves.has(c)) ctx.addIssue({ code: 'custom', path: ['regras', 'transbordo', 'lead_quente'], message: `campo "${c}" não existe em perguntas_qualificacao` });
  if (!a.horario.responder_fora_do_horario && !a.horario.msg_ausencia)
    ctx.addIssue({ code: 'custom', path: ['horario', 'msg_ausencia'], message: 'obrigatória quando responder_fora_do_horario=false' });
});

export const Config = z.object({
  chatwoot_account_id: z.number().int(),
  debounce_s: z.number().int().min(0).default(8),
  agentes: z.record(z.string().regex(/^[a-z_]+$/), Agent).refine((r) => Object.keys(r).length > 0, 'defina pelo menos 1 agente'),
});
export type Config = z.infer<typeof Config>;
export type AgentConfig = Config['agentes'][string];

// Erro legível no boot: "agentes.vendas.comportamento.nome: ..." em vez de stack do zod.
export function parseConfig(text: string): { config: Config; hash: string } {
  const r = Config.safeParse(parse(text));
  if (!r.success) throw new Error('config inválida:\n' + r.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  return { config: r.data, hash: createHash('sha256').update(text).digest('hex').slice(0, 12) };
}

export function loadConfig(path = process.env.CONFIG_PATH ?? new URL('../../config/ebm.yaml', import.meta.url).pathname) {
  return parseConfig(readFileSync(path, 'utf8'));
}

const TOM = { formal: 'formal e cordial', neutro: 'cordial e objetivo', amigavel: 'amigável e próximo', energetico: 'animado e energético' };
const lista = (t: string, xs: string[]) => (xs.length ? `\n${t}:\n${xs.map((x) => `- ${x}`).join('\n')}` : '');

// Prompt de sistema montado só da config. ponytail: texto livre por enquanto; o T4 acrescenta o contrato JSON (resposta + decisão + campos).
export function systemPrompt(a: AgentConfig): string {
  const c = a.comportamento, r = a.regras, k = a.conhecimento;
  return [
    `Você é ${c.nome}, ${c.funcao}. Fale em ${c.idioma}, com tom ${TOM[c.tom]}. Fuso: ${c.fuso}.`,
    `Apresente-se no máximo uma vez por conversa, sempre como "${c.nome}". Saudação: "${c.saudacao}".`,
    `Objetivo: ${k.objetivo}`,
    lista('Instruções prioritárias', r.instrucoes_prioritarias),
    `\nQualificação: faça UMA pergunta por vez, na ordem, pulando o que o cliente já respondeu:\n${r.perguntas_qualificacao.map((p, i) => `${i + 1}. ${p.pergunta}${p.obrigatorio ? '' : ' (opcional)'}`).join('\n')}`,
    lista('Regras de negócio', r.regras_negocio),
    lista('NUNCA prometa sem validação humana', r.nao_prometer),
    `\nSobre a empresa: ${k.biografia}`,
    k.publico_alvo && `Público-alvo: ${k.publico_alvo}`,
    lista('Diferenciais', k.diferenciais),
    k.pagamento && `Pagamento: ${k.pagamento}`,
    k.entrega && `Entrega: ${k.entrega}`,
    lista('Endereços', k.enderecos),
    k.catalogo_url && `Catálogo: ${k.catalogo_url}`,
    `\nSe não souber a resposta, diga que vai confirmar; nunca invente preço, prazo ou disponibilidade.`,
  ].filter(Boolean).join('\n');
}
