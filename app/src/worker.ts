// Worker: executa os timers vencidos de resposta (debounce) e de transbordo. A fila é a tabela timers (R1):
// claim com lease (locked_until) + SKIP LOCKED = um job por conversa, e job que caiu volta a rodar.
// ponytail: sem BullMQ; o volume do F1 (1 tenant) cabe numa varredura por segundo. Trocar se passar de ~50 jobs/s.
import { setTimeout as sleep } from 'node:timers/promises';
import { HttpError, type Chatwoot, type CwMsg } from './chatwoot.ts';
import { startHandoff } from './conversation.ts';
import { buildMessages, currentTurn, fullSystem, MOTIVOS_LLM, parseOut, validName, type Ctx, type Out } from './agent/prompt.ts';
import type { AgentConfig, Config } from './agent/config.ts';
import { inHours, nextOpen } from './hours.ts';
export { inHours };
import type { Chat } from './agent/llm.ts';
import type { Db } from './db.ts';

export type WorkerDeps = {
  db: Db; cfg: Config; hash: string; tenantId: number; cw: Chatwoot; chat?: Chat;
  llm: { provider: string; model: string };
  fetchImage?: (url: string) => Promise<string | null>;
  mediaWaitMs?: number;
  log?: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
};
type Timer = { id: number; tenant_id: number; kind: string; ref_id: number; due: string; tentativas: number };
const MAX_TENTATIVAS = 3;

export async function claim(db: Db, limit = 10): Promise<Timer[]> {
  return db.q(`UPDATE timers SET locked_until = now() + interval '3 minutes', tentativas = tentativas + 1
    WHERE (tenant_id, id) IN (SELECT tenant_id, id FROM timers WHERE kind <> 'followup' AND done_at IS NULL AND due_at <= now()
      AND (locked_until IS NULL OR locked_until < now()) ORDER BY due_at LIMIT $1 FOR UPDATE SKIP LOCKED)
    RETURNING id, tenant_id, kind, ref_id, due_at::text AS due, tentativas`, [limit]);
}

// Se chegou mensagem nova durante o job, due_at mudou: o timer continua pendente e roda de novo.
const finish = (db: Db, t: Timer) => db.q(`UPDATE timers SET locked_until = NULL, done_at = CASE WHEN due_at::text = $3 THEN now() ELSE done_at END
  WHERE tenant_id = $1 AND id = $2`, [t.tenant_id, t.id, t.due]);

export function isHot(a: AgentConfig, campos: Record<string, unknown>, sinal: boolean): boolean {
  const lq = a.regras.transbordo.lead_quente;
  return lq.campos_obrigatorios.every((k) => campos[k] != null && campos[k] !== '') && (!lq.exige_sinal_compra || sinal);
}

// Regra 4: grava antes de enviar; numa repetição, procura o brain_send_id no Chatwoot antes de reenviar.
async function sendOnce(d: WorkerDeps, conv: number, trigger: number, kind: string, content: string, file?: { url: string; name: string }) {
  const [row] = await d.db.q(`INSERT INTO outbound_sends (tenant_id, chatwoot_conversation_id, trigger_message_id, kind) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, chatwoot_conversation_id, trigger_message_id, kind) DO UPDATE SET kind = excluded.kind
    RETURNING status, brain_send_id, chatwoot_message_id, (xmax = 0) AS novo`, [d.tenantId, conv, trigger, kind]);
  if (row.status !== 'pending') return row.status as string;
  const prev = row.novo ? undefined : (await d.cw.messages(conv)).find((m) => m.content_attributes?.brain_send_id === row.brain_send_id);
  const id = prev?.id ?? (await d.cw.send(conv, content, row.brain_send_id, file));
  await d.db.q(`UPDATE outbound_sends SET status = 'sent', chatwoot_message_id = $5 WHERE tenant_id = $1 AND chatwoot_conversation_id = $2 AND trigger_message_id = $3 AND kind = $4 AND status = 'pending'`,
    [d.tenantId, conv, trigger, kind, id]);
  return 'sent';
}

// OV-F1: entregue só com source_id; sem nada no prazo = desconhecido.
async function waitDelivery(d: WorkerDeps, conv: number, trigger: number, kind: string): Promise<'entregue' | 'falhou' | 'sem confirmação'> {
  const until = Date.now() + (d.mediaWaitMs ?? 10_000);
  do {
    const [r] = await d.db.q(`SELECT status FROM outbound_sends WHERE tenant_id = $1 AND chatwoot_conversation_id = $2 AND trigger_message_id = $3 AND kind = $4`, [d.tenantId, conv, trigger, kind]);
    if (r?.status === 'delivered') return 'entregue';
    if (r?.status === 'failed') return 'falhou';
    await sleep(300);
  } while (Date.now() < until);
  return 'sem confirmação';
}

async function ask(chat: Chat, msgs: Parameters<Chat>[0]): Promise<Out> {
  let last: unknown;
  for (let i = 0; i < 2; i++) {   // regra 5: 2 tentativas (o timeout de 30 s fica no cliente)
    try { return parseOut(await chat(msgs, { json: true })); } catch (e) { last = e; }
  }
  throw last;
}

async function defaultFetchImage(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok || Number(r.headers.get('content-length') ?? 0) > 5_000_000) return null;
    return `data:${r.headers.get('content-type') ?? 'image/jpeg'};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  } catch { return null; }
}

export async function runReply(d: WorkerDeps, t: Timer): Promise<string> {
  const T = d.tenantId, conv = t.ref_id;
  const [st] = await d.db.q(`SELECT s.*, l.qualificacao, l.sinal_compra FROM conversation_state s LEFT JOIN leads l ON l.tenant_id = s.tenant_id AND l.id = s.lead_id
    WHERE s.tenant_id = $1 AND s.chatwoot_conversation_id = $2`, [T, conv]);
  if (!st || st.ia_pausada) return 'pausada';
  const agent = d.cfg.agentes[st.agent_key];
  if (!agent) return 'sem agente';
  const tb = agent.regras.transbordo;

  const history = await d.cw.messages(conv);
  const ausencias = await d.db.q(`SELECT brain_send_id FROM outbound_sends WHERE tenant_id = $1 AND chatwoot_conversation_id = $2 AND kind = 'ausencia'`, [T, conv]);
  const turn = currentTurn(history, new Set(ausencias.map((r) => r.brain_send_id)));
  if (!turn.length) return 'nada a responder';
  const trigger = turn.at(-1)!.id;

  // Relê o estado logo antes de cada envio (regra 2): pausa ou mensagem nova = descarta.
  const stale = async () => {
    const [r] = await d.db.q(`SELECT s.ia_pausada, tm.due_at::text = $3 AS mesmo FROM conversation_state s
      JOIN timers tm ON tm.tenant_id = s.tenant_id AND tm.id = $4 AND tm.done_at IS NULL
      WHERE s.tenant_id = $1 AND s.chatwoot_conversation_id = $2`, [T, conv, t.due, t.id]);
    return !r || r.ia_pausada || !r.mesmo;
  };
  const reply = async (kind: string, text: string) => (await stale() ? 'descartada' : (await sendOnce(d, conv, trigger, kind, text), 'enviada'));

  // áudio no F1 (OV-F7): pede texto; a 2ª insistência já virou transbordo no onEvent
  if (turn.every((m) => !m.content?.trim() && m.attachments?.every((a) => a.file_type === 'audio')))
    return reply('pedir_texto', tb.msg_pedir_texto);

  const aberto = inHours(agent.horario.dias, agent.comportamento.fuso);
  if (!aberto && !agent.horario.responder_fora_do_horario) {
    // uma ausência por janela fechada: enquanto houver reativação pendente, não manda outra
    if ((await d.db.q(`SELECT 1 FROM timers WHERE tenant_id = $1 AND kind = 'reativar' AND ref_id = $2 AND done_at IS NULL`, [T, conv])).length) return 'fora do horário';
    const r = await reply('ausencia', agent.horario.msg_ausencia);
    if (r === 'enviada') {
      await d.db.q(`INSERT INTO timers (tenant_id, kind, ref_id, due_at) VALUES ($1, 'reativar', $2, $3) ON CONFLICT DO NOTHING`,
        [T, conv, nextOpen(agent.horario.dias, agent.comportamento.fuso)]);
      await d.cw.addLabels(conv, ['fora-horario']);
    }
    return r;
  }

  const campos: Record<string, unknown> = st.qualificacao ?? {};
  const produtos = await d.db.q(`SELECT codigo, nome, preco_centavos, disponivel, imagem_url FROM products WHERE tenant_id = $1 ORDER BY codigo LIMIT 200`, [T]);
  const ctx: Ctx = {
    nome: (campos.nome as string) || validName(turn.at(-1)?.sender?.name), apresentou: Boolean(st.apresentou_em),
    foraDoHorario: !aberto, campos, produtos,
  };
  const images = new Map<number, string>();
  for (const m of turn) for (const a of m.attachments ?? [])
    if (a.file_type === 'image' && a.data_url) { const img = await (d.fetchImage ?? defaultFetchImage)(a.data_url); if (img) images.set(m.id, img); }

  const started = Date.now();
  const run = async (out: Out | null, erro?: string) => d.db.q(`INSERT INTO ai_runs (tenant_id, chatwoot_conversation_id, agent_key, config_hash, provedor, modelo, latencia_ms, campos_extraidos, decisao, erro)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [T, conv, st.agent_key, d.hash, d.llm.provider, d.llm.model, Date.now() - started,
    out ? Object.keys(out.campos).filter((k) => out.campos[k] != null) : null, out?.decisao ?? null, erro ?? null]);

  const falha = async (erro: string) => {
    await run(null, erro);
    await d.db.tx((q) => startHandoff(q, { tenant: T, conv, motivo: 'falha_tecnica', justificativa: erro, msg: tb.msg_falha, agent, labels: ['ia-falhou'] }));
    return 'transbordo (falha do LLM)';
  };
  if (!d.chat) return falha('LLM não configurado');

  let out: Out;
  try { out = await ask(d.chat, buildMessages(fullSystem(agent, ctx), history, images)); }
  catch (e: any) { return falha(e.message.slice(0, 200)); }

  // enviar_midia (RQ5): o código envia, espera a confirmação e devolve o resultado ao LLM
  const pedidos = out.enviar_produtos.map((c) => produtos.find((p) => p.codigo === c && p.imagem_url)).filter(Boolean);
  if (pedidos.length) {
    if (await stale()) return 'descartada';
    const res: string[] = [];
    for (const p of pedidos) {
      try {
        await sendOnce(d, conv, trigger, `midia:${p.codigo}`, p.nome, { url: p.imagem_url, name: `${p.codigo}.jpg` });
        res.push(`${p.codigo} (${p.nome}): ${await waitDelivery(d, conv, trigger, `midia:${p.codigo}`)}`);
      } catch (e: any) { res.push(`${p.codigo} (${p.nome}): falhou`); d.log?.error({ err: e.message }, 'enviar_midia falhou'); }
    }
    try { out = await ask(d.chat, buildMessages(fullSystem(agent, { ...ctx, ferramenta: res.join('\n') }), history, images)); }
    catch (e: any) { return falha(e.message.slice(0, 200)); }
  }
  await run(out);

  // qualificação: só campos conhecidos e não vazios entram no lead
  const chaves = new Set(agent.regras.perguntas_qualificacao.map((p) => p.chave));
  const novos = Object.fromEntries(Object.entries(out.campos).filter(([k, v]) => chaves.has(k) && v != null && v !== ''));
  const todos = { ...campos, ...novos }, sinal = Boolean(st.sinal_compra) || out.sinal_compra;
  if (st.lead_id) await d.db.q(`UPDATE leads SET qualificacao = $3, sinal_compra = $4,
      estagio = CASE WHEN estagio = 'novo' THEN 'em_qualificacao' ELSE estagio END WHERE tenant_id = $1 AND id = $2`, [T, st.lead_id, JSON.stringify(todos), sinal]);

  // lead quente é decidido em código: a mensagem de passagem substitui a resposta do LLM
  if (isHot(agent, todos, sinal)) {
    if (await stale()) return 'descartada';
    await d.db.tx((q) => startHandoff(q, { tenant: T, conv, motivo: 'lead_quente', msg: tb.msg_passagem, agent, snapshot: todos, labels: ['lead-quente'] }));
    return 'transbordo (lead quente)';
  }

  const r = await reply('reply', out.resposta);
  if (r !== 'enviada') return r;
  await d.db.q(`UPDATE conversation_state SET apresentou_em = coalesce(apresentou_em, now()) WHERE tenant_id = $1 AND chatwoot_conversation_id = $2`, [T, conv]);

  // RQ6: transferência só com motivo da lista; sem motivo válido, a IA segue na conversa
  if (out.decisao === 'transferir' && MOTIVOS_LLM.includes(out.motivo as any)) {
    await d.db.tx((q) => startHandoff(q, { tenant: T, conv, motivo: out.motivo!, justificativa: out.justificativa ?? undefined, agent, snapshot: todos }));
    return `enviada + transbordo (${out.motivo})`;
  }
  return 'enviada';
}

// Efeitos do transbordo no Chatwoot; cada passo é seguro para repetir.
export async function runHandoff(d: WorkerDeps, hId: number): Promise<string> {
  const [h] = await d.db.q(`SELECT * FROM handoff_events WHERE tenant_id = $1 AND id = $2`, [d.tenantId, hId]);
  if (!h) return 'não existe';
  const conv = Number(h.chatwoot_conversation_id), snap = h.snapshot ?? {};
  if (snap._msg) await sendOnce(d, conv, hId, 'handoff', snap._msg).catch((e) => d.log?.error({ err: e.message }, 'mensagem de passagem falhou'));
  await d.cw.open(conv);
  await d.cw.assign(conv, { user_id: h.para_user_id ?? undefined, team_id: h.para_team_id ?? undefined });
  await d.cw.addLabels(conv, ['ia-pausada', ...(snap._labels ?? [])]);
  if (h.motivo === 'lead_quente') await d.cw.urgent(conv);

  const [nota] = await d.db.q(`INSERT INTO outbound_sends (tenant_id, chatwoot_conversation_id, trigger_message_id, kind, status) VALUES ($1, $2, $3, 'nota', 'pending')
    ON CONFLICT DO NOTHING RETURNING 1`, [d.tenantId, conv, hId]);
  if (nota) {
    const campos = Object.entries(snap).filter(([k]) => !k.startsWith('_'));
    await d.cw.note(conv, [`🤖 Transbordo: ${h.motivo}${h.justificativa ? ` (${h.justificativa})` : ''}`,
      ...(campos.length ? ['Qualificação:', ...campos.map(([k, v]) => `- ${k}: ${v}`)] : [])].join('\n'));
    await d.db.q(`UPDATE outbound_sends SET status = 'sent' WHERE tenant_id = $1 AND chatwoot_conversation_id = $2 AND trigger_message_id = $3 AND kind = 'nota'`, [d.tenantId, conv, hId]);
  }
  return 'ok';
}

const mention = (id: number) => `[@atendente](mention://user/${id}/atendente)`;   // menção em nota privada = notificação no Chatwoot

// SLA (RQ7): estouro 1 lembra o destino e alerta gestores; estouro 2 passa ao time de backup (ou alerta de novo).
// msg_espera: avisa o cliente que o humano já foi chamado, sem parar o SLA (mensagem do bot não conta como humana).
export async function runSla(d: WorkerDeps, t: Timer): Promise<string> {
  const [h] = await d.db.q(`SELECT h.*, s.agent_key FROM handoff_events h JOIN conversation_state s ON s.tenant_id = h.tenant_id AND s.chatwoot_conversation_id = h.chatwoot_conversation_id
    WHERE h.tenant_id = $1 AND h.id = $2`, [d.tenantId, t.ref_id]);
  if (!h || h.primeira_resposta_em) return 'já respondido';
  const conv = Number(h.chatwoot_conversation_id), tb = (d.cfg.agentes[h.agent_key] ?? Object.values(d.cfg.agentes)[0]).regras.transbordo;

  if (t.kind === 'msg_espera') return (await sendOnce(d, conv, t.id, 'espera', tb.msg_espera), 'espera enviada');

  const gestores = (await d.db.q(`SELECT chatwoot_user_id FROM users_map WHERE tenant_id = $1 AND role IN ('gestor', 'admin')`, [d.tenantId])).map((u) => Number(u.chatwoot_user_id));
  const estouro = t.kind === 'sla1' ? 1 : 2;
  const [marcado] = await d.db.q(`UPDATE handoff_events SET sla_estouros = $3 WHERE tenant_id = $1 AND id = $2 AND sla_estouros < $3 RETURNING 1`, [d.tenantId, h.id, estouro]);
  if (!marcado) return 'já tratado';
  const min = estouro === 1 ? tb.sla_min : tb.sla2_min;
  if (estouro === 2 && tb.backup_team_id) await d.cw.assign(conv, { team_id: tb.backup_team_id });
  await d.cw.addLabels(conv, ['sla-estourado']);
  const quem = [...new Set([...(h.para_user_id ? [Number(h.para_user_id)] : []), ...gestores])].map(mention).join(' ');
  await d.cw.note(conv, `⏰ SLA estourado (${min} min sem resposta humana, motivo: ${h.motivo}).${estouro === 2 && tb.backup_team_id ? ' Conversa passada ao time de backup.' : ''} ${quem}`);
  return `sla${estouro}`;
}

// Regra 6: na abertura do expediente, responde quem escreveu com a loja fechada; fora da janela de 24h, vai para humano.
// ponytail: sem template pago (permitir_templates_pagos=false é o padrão do plano); entra junto com os disparos (F5).
export async function runReactivate(d: WorkerDeps, conv: number): Promise<string> {
  const [st] = await d.db.q(`SELECT agent_key, ia_pausada, last_customer_msg_at > now() - interval '24 hours' AS na_janela FROM conversation_state WHERE tenant_id = $1 AND chatwoot_conversation_id = $2`, [d.tenantId, conv]);
  if (!st || st.ia_pausada) return 'pausada';
  if (!st.na_janela) {
    const agent = d.cfg.agentes[st.agent_key] ?? Object.values(d.cfg.agentes)[0];
    await d.db.tx((q) => startHandoff(q, { tenant: d.tenantId, conv, motivo: 'fora_janela', justificativa: 'janela de 24h fechada na reabertura', agent, labels: ['fora-janela'] }));
    return 'fora da janela';
  }
  await d.db.q(`INSERT INTO timers (tenant_id, kind, ref_id, due_at) VALUES ($1, 'reply', $2, now()) ON CONFLICT (tenant_id, kind, ref_id) WHERE done_at IS NULL DO UPDATE SET due_at = now()`, [d.tenantId, conv]);
  return 'reativada';
}

export async function runJob(d: WorkerDeps, t: Timer): Promise<string> {
  try {
    const r = t.kind === 'reply' ? await runReply(d, t) : t.kind === 'handoff' ? await runHandoff(d, t.ref_id)
      : t.kind === 'reativar' ? await runReactivate(d, t.ref_id) : await runSla(d, t);
    await finish(d.db, t);
    d.log?.info({ kind: t.kind, ref: t.ref_id, r }, 'job');
    return r;
  } catch (e: any) {
    const retry = (!(e instanceof HttpError) || e.retryable) && t.tentativas < MAX_TENTATIVAS;
    d.log?.error({ kind: t.kind, ref: t.ref_id, tentativa: t.tentativas, err: e.message, retry }, 'job falhou');
    if (retry) {   // backoff exponencial: 5 s, 10 s
      await d.db.q(`UPDATE timers SET locked_until = now() + make_interval(secs => $3) WHERE tenant_id = $1 AND id = $2`, [t.tenant_id, t.id, 5 * 2 ** (t.tentativas - 1)]);
      return 'repetir';
    }
    await finish(d.db, t);
    if (t.kind === 'reply') {   // falha final de envio = transbordo (regra 4)
      const [st] = await d.db.q(`SELECT agent_key FROM conversation_state WHERE tenant_id = $1 AND chatwoot_conversation_id = $2`, [d.tenantId, t.ref_id]);
      const agent = d.cfg.agentes[st?.agent_key] ?? Object.values(d.cfg.agentes)[0];
      await d.db.tx((q) => startHandoff(q, { tenant: d.tenantId, conv: t.ref_id, motivo: 'falha_tecnica', justificativa: e.message, agent, labels: ['ia-falhou-envio'] }));
      return 'transbordo (falha de envio)';
    }
    return 'falhou';   // ponytail: transbordo que falhou 3x só fica no log; o alerta independente entra no T9 (Telegram)
  }
}

if (import.meta.main) {
  const { default: pg } = await import('pg');
  const { pgDb } = await import('./db.ts');
  const { loadConfig } = await import('./agent/config.ts');
  const { llmEnv, openaiChat } = await import('./agent/llm.ts');
  const { chatwootClient } = await import('./chatwoot.ts');
  const { ensureTenant } = await import('./conversation.ts');

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  pool.on('error', (e) => console.error(JSON.stringify({ msg: 'pg pool error', err: e.message })));
  const db = pgDb(pool), { config, hash } = loadConfig(), llm = llmEnv();
  // regra 10: agente live só com provedor aprovado para produção
  const live = Object.entries(config.agentes).filter(([, a]) => a.status === 'live').map(([k]) => k);
  if (live.length && !llm.approved) throw new Error(`agentes live (${live.join(', ')}) exigem LLM_APPROVED_FOR_PRODUCTION=true`);

  const log = {
    info: (o: object, msg: string) => console.log(JSON.stringify({ level: 'info', msg, ...o })),
    error: (o: object, msg: string) => console.error(JSON.stringify({ level: 'error', msg, ...o })),
  };
  const deps: WorkerDeps = {
    db, cfg: config, hash, log, tenantId: await ensureTenant(db.q, config.chatwoot_account_id),
    cw: chatwootClient(process.env.CHATWOOT_URL ?? 'http://chatwoot:3000', config.chatwoot_account_id, process.env.CHATWOOT_BOT_TOKEN ?? '', process.env.CHATWOOT_ADMIN_TOKEN ?? ''),
    chat: llm.baseUrl && llm.model ? openaiChat(llm.baseUrl, llm.model, process.env.LLM_API_KEY) : undefined,
    llm: { provider: llm.baseUrl ? new URL(llm.baseUrl).host : 'nenhum', model: llm.model || 'nenhum' },
  };
  let running = true;
  for (const s of ['SIGTERM', 'SIGINT'] as const) process.once(s, () => { running = false; });
  log.info({ tenant: deps.tenantId, config: hash }, 'worker no ar');
  while (running) {
    const jobs = await claim(db).catch((e) => (log.error({ err: e.message }, 'claim falhou'), []));
    await Promise.all(jobs.map((t) => runJob(deps, t)));
    if (!jobs.length) await sleep(1000);
  }
  await pool.end();
}
