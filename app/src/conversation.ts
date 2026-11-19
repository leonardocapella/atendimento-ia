// Dono de conversation_state (R2). Recebe eventos do Chatwoot e decide: pausar, transferir na hora ou agendar resposta.
// Tudo numa transação: dedupe (regra 3) + mudança de estado + timer.
import { parseEvent } from './chatwoot.ts';
import type { Config } from './agent/config.ts';
import type { Db, Query } from './db.ts';

export type ConvDeps = { db: Db; cfg: Config; tenantId: number };
const HOT = ['quente', 'em_negociacao', 'ganho'];
const norm = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export async function ensureTenant(q: Query, accountId: number): Promise<number> {
  const [t] = await q(`INSERT INTO tenants (chatwoot_account_id, nome) VALUES ($1, 'EBM') ON CONFLICT (chatwoot_account_id) DO UPDATE SET nome = tenants.nome RETURNING id`, [accountId]);
  return t.id;
}

export function pickAgent(cfg: Config, inbox?: number): string | null {
  const e = Object.entries(cfg.agentes);
  return (e.find(([, a]) => inbox != null && a.inbox_ids.includes(inbox)) ?? e.find(([, a]) => a.inbox_ids.length === 0))?.[0] ?? null;
}

// Transbordo dispara uma vez: se já há um aberto, não cria outro. Os efeitos no Chatwoot rodam no worker (timer 'handoff').
export async function startHandoff(q: Query, t: {
  tenant: number; conv: number; motivo: string; justificativa?: string; msg?: string;
  destino: { user_id?: number; team_id?: number }; snapshot?: Record<string, unknown>; labels?: string[];
}): Promise<number | null> {
  const open = await q(`SELECT 1 FROM handoff_events WHERE tenant_id = $1 AND chatwoot_conversation_id = $2 AND primeira_resposta_em IS NULL`, [t.tenant, t.conv]);
  if (open.length) return null;
  const [h] = await q(
    `INSERT INTO handoff_events (tenant_id, chatwoot_conversation_id, motivo, justificativa, para_user_id, para_team_id, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [t.tenant, t.conv, t.motivo, t.justificativa ?? null, t.destino.user_id ?? null, t.destino.team_id ?? null,
     JSON.stringify({ ...t.snapshot, _msg: t.msg ?? null, _labels: t.labels ?? [] })]);
  await q(`UPDATE conversation_state SET ia_pausada = true, pausa_motivo = $3 WHERE tenant_id = $1 AND chatwoot_conversation_id = $2`, [t.tenant, t.conv, t.motivo]);
  await q(`UPDATE timers SET done_at = now() WHERE tenant_id = $1 AND kind = 'reply' AND ref_id = $2 AND done_at IS NULL`, [t.tenant, t.conv]);
  await q(`INSERT INTO timers (tenant_id, kind, ref_id, due_at) VALUES ($1, 'handoff', $2, now())`, [t.tenant, h.id]);
  if (t.motivo === 'lead_quente')
    await q(`UPDATE leads SET estagio = 'quente' FROM conversation_state s WHERE s.tenant_id = $1 AND s.chatwoot_conversation_id = $2 AND leads.tenant_id = $1 AND leads.id = s.lead_id`, [t.tenant, t.conv]);
  return h.id;
}

export async function onEvent(d: ConvDeps, body: unknown): Promise<string> {
  const ev = parseEvent(body);
  if (!ev || (ev.account != null && ev.account !== d.cfg.chatwoot_account_id)) return 'ignorado';
  const T = d.tenantId;

  return d.db.tx(async (q) => {
    if (!(await q(`INSERT INTO webhook_events (source, external_id) VALUES ('chatwoot', $1) ON CONFLICT DO NOTHING RETURNING 1`, [ev.key])).length)
      return 'duplicado';

    if (ev.kind === 'msg_status') {   // OV-F1: entregue só com source_id (wamid)
      await q(`UPDATE outbound_sends SET status = CASE WHEN $3 THEN 'failed' ELSE 'delivered' END
               WHERE tenant_id = $1 AND chatwoot_message_id = $2 AND status IN ('pending', 'sent') AND ($3 OR $4)`,
        [T, ev.id, ev.failed, ev.delivered]);
      return 'status';
    }

    if (ev.kind === 'conv_status') {   // regra 7: resolvida volta com IA ativa, salvo lead quente ou sempre-humano
      if (ev.status !== 'resolved') return 'ignorado';
      await q(`UPDATE conversation_state s SET pausa_motivo = NULL, audios_pedidos = 0, ia_pausada = coalesce(
                 (SELECT l.estagio = ANY($3) OR l.sempre_humano FROM leads l WHERE l.tenant_id = s.tenant_id AND l.id = s.lead_id), false)
               WHERE s.tenant_id = $1 AND s.chatwoot_conversation_id = $2`, [T, ev.conv, HOT]);
      return 'resolvida';
    }

    // regra 1: só humano público pausa; bot, nota privada, template e atividade não.
    if (ev.author === 'ia' || ev.author === null) return 'ignorado';
    const agentKey = pickAgent(d.cfg, ev.inbox);
    if (!agentKey) return 'sem agente';

    if (ev.author === 'humano') {
      await q(`INSERT INTO conversation_state (tenant_id, chatwoot_conversation_id, agent_key, ia_pausada, pausa_motivo) VALUES ($1, $2, $3, true, 'humano')
               ON CONFLICT (tenant_id, chatwoot_conversation_id) DO UPDATE SET ia_pausada = true, pausa_motivo = coalesce(conversation_state.pausa_motivo, 'humano')`, [T, ev.conv, agentKey]);
      await q(`UPDATE timers SET done_at = now() WHERE tenant_id = $1 AND kind = 'reply' AND ref_id = $2 AND done_at IS NULL`, [T, ev.conv]);
      // 1ª resposta humana para o SLA de todo transbordo aberto (T5 cuida dos alertas)
      const hs = await q(`UPDATE handoff_events SET primeira_resposta_em = now() WHERE tenant_id = $1 AND chatwoot_conversation_id = $2 AND primeira_resposta_em IS NULL RETURNING id`, [T, ev.conv]);
      if (hs.length) {
        await q(`UPDATE timers SET done_at = now() WHERE tenant_id = $1 AND kind IN ('sla1', 'sla2', 'msg_espera') AND ref_id = ANY($2) AND done_at IS NULL`, [T, hs.map((h) => h.id)]);
        await q(`UPDATE leads SET estagio = 'em_negociacao' FROM conversation_state s WHERE s.tenant_id = $1 AND s.chatwoot_conversation_id = $2
                 AND leads.tenant_id = $1 AND leads.id = s.lead_id AND leads.estagio = 'quente'`, [T, ev.conv]);
      }
      return 'pausada';
    }

    // cliente
    if (ev.contactId == null) return 'sem contato';
    const [lead] = await q(`INSERT INTO leads (tenant_id, chatwoot_contact_id) VALUES ($1, $2)
                            ON CONFLICT (tenant_id, chatwoot_contact_id) DO UPDATE SET chatwoot_contact_id = excluded.chatwoot_contact_id
                            RETURNING id, sempre_humano`, [T, ev.contactId]);
    const onlyAudio = !ev.text && ev.files.length > 0 && ev.files.every((f) => f === 'audio');
    const [st] = await q(`INSERT INTO conversation_state (tenant_id, chatwoot_conversation_id, lead_id, agent_key, last_msg_at, last_customer_msg_at, audios_pedidos)
                          VALUES ($1, $2, $3, $4, now(), now(), $5)
                          ON CONFLICT (tenant_id, chatwoot_conversation_id) DO UPDATE SET lead_id = excluded.lead_id, last_msg_at = now(), last_customer_msg_at = now(),
                            audios_pedidos = conversation_state.audios_pedidos + $5
                          RETURNING ia_pausada, agent_key, audios_pedidos`, [T, ev.conv, lead.id, agentKey, onlyAudio ? 1 : 0]);
    if (st.ia_pausada) return 'pausada';   // T5: mensagem de espera

    const agent = d.cfg.agentes[st.agent_key] ?? d.cfg.agentes[agentKey];
    const tb = agent.regras.transbordo;
    const handoff = (motivo: string, justificativa: string) =>
      startHandoff(q, { tenant: T, conv: ev.conv, motivo, justificativa, msg: tb.msg_falha, destino: tb.destino });

    // atalhos sem LLM (regra 2)
    if (lead.sempre_humano) return (await handoff('pedido_cliente', 'contato sempre-humano'), 'transbordo');
    const texto = norm(ev.text);
    if (tb.frases_pedido.some((f) => texto.includes(norm(f)))) return (await handoff('pedido_cliente', 'frase de pedido'), 'transbordo');
    if (onlyAudio && st.audios_pedidos >= 2) return (await handoff('midia_nao_suportada', 'cliente insistiu em áudio'), 'transbordo');

    // debounce (OV-F12): cada mensagem empurra o prazo da resposta
    await q(`INSERT INTO timers (tenant_id, kind, ref_id, due_at) VALUES ($1, 'reply', $2, now() + make_interval(secs => $3))
             ON CONFLICT (tenant_id, kind, ref_id) WHERE done_at IS NULL DO UPDATE SET due_at = excluded.due_at, tentativas = 0`, [T, ev.conv, d.cfg.debounce_s]);
    return 'agendada';
  });
}
