// Motor de conversa ponta a ponta: webhook → onEvent → timer → worker, com Postgres em memória (PGlite),
// Chatwoot fake (guarda as mensagens) e LLM fake (respostas roteirizadas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate, type Db, type Query } from '../src/db.ts';
import { loadConfig, type Config } from '../src/agent/config.ts';
import { onEvent, ensureTenant } from '../src/conversation.ts';
import { claim, runJob, inHours, type WorkerDeps } from '../src/worker.ts';
import { validName, parseOut, buildMessages } from '../src/agent/prompt.ts';
import { HttpError, type Chatwoot, type CwMsg } from '../src/chatwoot.ts';
import type { Msg } from '../src/agent/llm.ts';

const CONV = 50, CONTACT = 900;
let nextId = 1000;

function fakeCw() {
  const msgs: CwMsg[] = [], calls: string[] = [];
  let failSend = 0;
  const cw: Chatwoot = {
    async send(conv, content, sendId, file) {
      calls.push(`send:${file ? 'midia' : 'texto'}`);
      if (failSend) { failSend--; throw new HttpError(503); }
      const m: CwMsg = { id: nextId++, content, message_type: 1, sender_type: 'AgentBot', content_attributes: { brain_send_id: sendId }, attachments: file ? [{ file_type: 'image' }] : [] };
      msgs.push(m);
      return m.id;
    },
    messages: async () => msgs.slice(),
    note: async (_c, content) => { calls.push('note'); msgs.push({ id: nextId++, content, message_type: 1, private: true, sender_type: 'User' }); },
    assign: async (_c, to) => { calls.push(`assign:${to.user_id ?? 'team' + to.team_id}`); },
    addLabels: async (_c, l) => { calls.push(`labels:${l.join(',')}`); },
    open: async () => { calls.push('open'); },
    urgent: async () => { calls.push('urgent'); },
  };
  return { cw, msgs, calls, failNextSends: (n: number) => (failSend = n) };
}

const out = (o: Partial<{ resposta: string; decisao: string; motivo: string | null; campos: object; sinal_compra: boolean; enviar_produtos: string[] }>) =>
  JSON.stringify({ resposta: 'Certo!', decisao: 'responder', motivo: null, campos: {}, sinal_compra: false, enviar_produtos: [], ...o });

async function setup(opts: { replies?: (string | Error)[]; cfg?: (c: Config) => void } = {}) {
  const pg = new PGlite();
  const run = async (sql: string) => (await pg.exec(sql)).at(-1)?.rows ?? [];
  await migrate(run);
  const q: Query = async (sql, p) => (await pg.query(sql, p as any[])).rows as any[];
  // PGlite é uma conexão só: transação serializada por uma fila simples
  let chain = Promise.resolve();
  const db: Db = {
    q,
    tx: (fn) => {
      const r = chain.then(async () => { await q('BEGIN'); try { const v = await fn(q); await q('COMMIT'); return v; } catch (e) { await q('ROLLBACK'); throw e; } });
      chain = r.then(() => {}, () => {});
      return r;
    },
  };
  const { config, hash } = loadConfig();
  config.debounce_s = 0;
  config.agentes.vendas.horario.dias = {};   // sempre aberto
  opts.cfg?.(config);
  const tenantId = await ensureTenant(q, config.chatwoot_account_id);
  const fake = fakeCw();
  const prompts: Msg[][] = [];
  const replies = [...(opts.replies ?? [])];
  const deps: WorkerDeps = {
    db, cfg: config, hash, tenantId, cw: fake.cw, llm: { provider: 'fake', model: 'fake' }, mediaWaitMs: 300,
    chat: async (m) => { prompts.push(m); const r = replies.shift() ?? out({}); if (r instanceof Error) throw r; return r; },
  };

  const customer = async (content: string, extra: Partial<CwMsg> & { name?: string } = {}) => {
    const m: CwMsg = { id: nextId++, content, message_type: 0, sender_type: 'Contact', sender: { type: 'contact', name: extra.name ?? 'Mateus Souza' }, ...extra };
    fake.msgs.push(m);
    return onEvent({ db, cfg: config, tenantId }, { event: 'message_created', account: { id: 1 }, id: m.id, content, message_type: 'incoming', private: false,
      sender: { type: 'contact', id: CONTACT, name: m.sender!.name }, conversation: { id: CONV, inbox_id: 1 }, attachments: m.attachments ?? [], content_attributes: m.content_attributes });
  };
  const human = async (content: string, isPrivate = false) => {
    const m: CwMsg = { id: nextId++, content, message_type: 1, private: isPrivate, sender_type: 'User' };
    fake.msgs.push(m);
    return onEvent({ db, cfg: config, tenantId }, { event: 'message_created', account: { id: 1 }, id: m.id, content, message_type: 'outgoing', private: isPrivate,
      sender: { type: 'user', id: 2 }, conversation: { id: CONV, inbox_id: 1 } });
  };
  const drain = async () => {   // roda timers até esvaziar (ignora backoff)
    const results: string[] = [];
    for (let i = 0; i < 10; i++) {
      await q(`UPDATE timers SET locked_until = NULL WHERE done_at IS NULL`);
      const jobs = await claim(db);
      if (!jobs.length) break;
      for (const t of jobs) results.push(await runJob(deps, t));
    }
    return results;
  };
  const state = async () => (await q(`SELECT * FROM conversation_state WHERE chatwoot_conversation_id = $1`, [CONV]))[0];
  const handoffs = () => q(`SELECT motivo FROM handoff_events ORDER BY id`);
  const outgoing = () => fake.msgs.filter((m) => m.message_type === 1 && !m.private);
  return { db, q, deps, config, fake, prompts, customer, human, drain, state, handoffs, outgoing };
}

test('EV1: 3 mensagens em sequência + webhook duplicado = 1 resposta', async () => {
  const s = await setup();
  await s.customer('Olá'); await s.customer('vim pelo anúncio');
  const last = await s.customer('quero orçamento de armário');
  assert.equal(last, 'agendada');
  // o mesmo evento reenviado pelo Chatwoot
  const lastMsg = s.fake.msgs.at(-1)!;
  const dup = await onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId }, { event: 'message_created', account: { id: 1 }, id: lastMsg.id, content: 'x', message_type: 'incoming', sender: { type: 'contact', id: CONTACT }, conversation: { id: CONV, inbox_id: 1 } });
  assert.equal(dup, 'duplicado');
  await s.drain();
  assert.equal(s.outgoing().length, 1);
  assert.equal(s.prompts.length, 1);
  assert.ok((await s.state()).apresentou_em, 'marcou que já se apresentou');
});

test('EV2: humano responde = IA pausa e descarta a resposta da fila; nota privada não pausa', async () => {
  const s = await setup();
  await s.customer('oi');
  assert.equal(await s.human('nota interna', true), 'ignorado');
  assert.equal((await s.state()).ia_pausada, false);
  assert.equal(await s.human('Oi, aqui é o Lorenzo'), 'pausada');
  await s.drain();
  assert.equal(s.prompts.length, 0);
  assert.equal(s.outgoing().length, 1);   // só a do humano
  assert.equal(await s.customer('e aí?'), 'pausada');
});

test('EV2b: humano escreve durante a geração = resposta descartada antes do envio', async () => {
  const s = await setup();
  await s.customer('oi');
  s.deps.chat = async () => { await s.human('deixa comigo'); return out({}); };
  await s.drain();
  assert.equal(s.outgoing().length, 1);   // só a do humano
});

test('regra 1b: mensagem da própria IA não pausa', async () => {
  const s = await setup();
  const r = await onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId }, { event: 'message_created', account: { id: 1 }, id: 77, content: 'x', message_type: 'outgoing', private: false, sender: { type: 'agent_bot' }, conversation: { id: CONV } });
  assert.equal(r, 'ignorado');
});

test('EV3: validador de nome', () => {
  for (const n of ['TF', '😀', 'Loja XYZ ME', 'J.', 'ABC Store', '123']) assert.equal(validName(n), null, n);
  assert.equal(validName('Mateus'), 'Mateus');
  assert.equal(validName('MARIA silva'), 'Maria');
});

test('EV3b: nome inválido não vai para o prompt', async () => {
  const s = await setup();
  await s.customer('oi', { name: 'TF' } as any);
  await s.drain();
  const sys = s.prompts[0][0].content as string;
  assert.match(sys, /Nome do cliente desconhecido/);
  assert.doesNotMatch(sys, /Nome do cliente: TF/);
});

test('EV4: mídia enviada pela IA aparece como [VOCÊ ENVIOU], a do cliente como [CLIENTE ENVIOU]', () => {
  const hist: CwMsg[] = [
    { id: 1, content: 'Armário cinza', message_type: 1, sender_type: 'AgentBot', attachments: [{ file_type: 'image' }] },
    { id: 2, content: '', message_type: 0, attachments: [{ file_type: 'image' }] },
    { id: 3, content: 'desse modelo vocês não fazem?', message_type: 0, content_attributes: { in_reply_to: 1 } },
  ];
  const m = buildMessages('sys', hist).slice(1).map((x) => x.content as string);
  assert.match(m[0], /\[VOCÊ ENVIOU image: Armário cinza\]/);
  assert.match(m[1], /\[CLIENTE ENVIOU image\]/);
  assert.match(m[2], /respondendo a: sua mensagem "Armário cinza" \[VOCÊ ENVIOU image/);   // RQ8
});

test('EV5: enviar_midia confirma pelo status antes de o LLM falar; sem confirmação = "sem confirmação"', async () => {
  const s = await setup({ replies: [out({ enviar_produtos: ['DEMO-001'] }), out({ resposta: 'Conseguiu ver a foto?' })] });
  await s.q(`INSERT INTO products (tenant_id, codigo, nome, imagem_url) VALUES ($1, 'DEMO-001', 'Armário A', 'http://img/a.jpg')`, [s.deps.tenantId]);
  await s.customer('pode mandar fotos?');
  await s.drain();
  assert.deepEqual(s.fake.calls.filter((c) => c.startsWith('send')), ['send:midia', 'send:texto']);
  const sys2 = s.prompts[1][0].content as string;
  assert.match(sys2, /DEMO-001 \(Armário A\): sem confirmação/);
});

test('EV6: "Sim" para ver fotos não vira transbordo; transferir sem motivo da lista é ignorado', async () => {
  const s = await setup({ replies: [out({ decisao: 'transferir', motivo: 'especialista', resposta: 'Vou encaminhar' })] });
  await s.customer('Sim');
  await s.drain();
  assert.deepEqual(await s.handoffs(), []);
  assert.equal((await s.state()).ia_pausada, false);
});

test('lead quente (critério em código): transbordo para o Lorenzo uma vez, com passagem, nota, atribuição e urgência', async () => {
  const campos = { interesse: 'armário', prazo: '2026-12-01', cidade: 'Curitiba' };
  const s = await setup({ replies: [out({ campos, sinal_compra: true, resposta: 'texto do LLM que não deve sair' })] });
  await s.customer('quero fechar o armário para dezembro em Curitiba');
  await s.drain();
  assert.deepEqual((await s.handoffs()).map((h) => h.motivo), ['lead_quente']);
  assert.equal((await s.state()).ia_pausada, true);
  assert.equal((await s.q(`SELECT estagio FROM leads`))[0].estagio, 'quente');
  const texts = s.outgoing().map((m) => m.content);
  assert.equal(texts.length, 1);
  assert.match(texts[0]!, /Lorenzo/);
  for (const c of ['open', 'assign:2', 'urgent', 'note']) assert.ok(s.fake.calls.includes(c), c);
  assert.ok(s.fake.calls.some((c) => c.includes('lead-quente')));
  assert.match(s.fake.msgs.find((m) => m.private)!.content!, /cidade: Curitiba/);

  // nova mensagem do cliente não gera outro transbordo nem resposta
  await s.customer('e aí?'); await s.drain();
  assert.equal((await s.handoffs()).length, 1);
  // 1ª resposta humana: para o SLA e vai para em_negociacao
  await s.human('Oi, sou o Lorenzo');
  assert.ok((await s.q(`SELECT primeira_resposta_em FROM handoff_events`))[0].primeira_resposta_em);
  assert.equal((await s.q(`SELECT estagio FROM leads`))[0].estagio, 'em_negociacao');
});

test('frase de pedido: transbordo imediato sem LLM', async () => {
  const s = await setup();
  assert.equal(await s.customer('Quero FALAR COM ATENDENTE por favor'), 'transbordo');
  await s.drain();
  assert.equal(s.prompts.length, 0);
  assert.deepEqual((await s.handoffs()).map((h) => h.motivo), ['pedido_cliente']);
});

test('áudio: 1º pede texto, 2º transfere (midia_nao_suportada)', async () => {
  const s = await setup();
  const audio = { attachments: [{ file_type: 'audio' }] };
  const send = (id: number) => onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId }, { event: 'message_created', account: { id: 1 }, id, content: null, message_type: 'incoming', sender: { type: 'contact', id: CONTACT }, conversation: { id: CONV, inbox_id: 1 }, attachments: [{ file_type: 'audio' }] });
  s.fake.msgs.push({ id: 5001, content: null, message_type: 0, ...audio });
  await send(5001); await s.drain();
  assert.match(s.outgoing()[0].content!, /por escrito/);
  assert.equal(s.prompts.length, 0);
  s.fake.msgs.push({ id: 5002, content: null, message_type: 0, ...audio });
  assert.equal(await send(5002), 'transbordo');
});

test('regra 5: LLM falha 2x = transbordo falha_tecnica com mensagem ao cliente', async () => {
  const s = await setup({ replies: [new Error('LLM respondeu 500'), new Error('LLM respondeu 500')] });
  await s.customer('oi');
  await s.drain();
  assert.deepEqual((await s.handoffs()).map((h) => h.motivo), ['falha_tecnica']);
  assert.match(s.outgoing().at(-1)!.content!, /atendente/);
  assert.match((await s.q(`SELECT erro FROM ai_runs`))[0].erro, /500/);
});

test('regra 5: JSON inválido na 1ª tentativa, válido na 2ª = responde', async () => {
  const s = await setup({ replies: ['isto não é json', out({ resposta: 'Oi!' })] });
  await s.customer('oi');
  await s.drain();
  assert.equal(s.outgoing()[0].content, 'Oi!');
});

test('regra 4: 5xx no envio repete sem duplicar; esgotou = transbordo ia-falhou-envio', async () => {
  const s = await setup();
  s.fake.failNextSends(1);
  await s.customer('oi');
  await s.drain();
  assert.equal(s.outgoing().length, 1);
  assert.equal((await s.q(`SELECT count(*)::int n FROM outbound_sends WHERE kind = 'reply'`))[0].n, 1);

  const s2 = await setup();
  s2.fake.failNextSends(99);
  await s2.customer('oi');
  await s2.drain();
  assert.deepEqual((await s2.handoffs()).map((h) => h.motivo), ['falha_tecnica']);
  assert.ok(s2.fake.calls.some((c) => c.includes('ia-falhou-envio')));
});

test('regra 7: conversa resolvida volta com IA ativa, mas lead quente continua pausado', async () => {
  const s = await setup();
  await s.customer('oi'); await s.human('assumi');
  const resolve = (k: string) => onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId }, { event: 'conversation_status_changed', account: { id: 1 }, id: CONV, status: 'resolved', updated_at: k });
  await resolve('1');
  assert.equal((await s.state()).ia_pausada, false);
  await s.q(`UPDATE leads SET estagio = 'quente'`);
  await s.human('assumi de novo');
  await resolve('2');
  assert.equal((await s.state()).ia_pausada, true);
});

test('fora do horário sem resposta: 1 mensagem de ausência e label', async () => {
  const s = await setup({ cfg: (c) => {
    const a = c.agentes.vendas;
    a.horario.dias = { dom: [['00:00', '00:01']] };
    a.horario.responder_fora_do_horario = false;
    a.horario.msg_ausencia = 'Estamos fechados, respondemos amanhã.';
  } });
  await s.customer('oi'); await s.drain();
  await s.customer('alô?'); await s.drain();
  assert.deepEqual(s.outgoing().map((m) => m.content), ['Estamos fechados, respondemos amanhã.']);
  assert.ok(s.fake.calls.includes('labels:fora-horario'));
});

test('inHours respeita o fuso', () => {
  const dias = { qua: [['09:00', '18:00']] as [string, string][] };
  assert.equal(inHours(dias, 'America/Sao_Paulo', new Date('2026-11-18T13:00:00Z')), true);    // qua 10:00 em SP
  assert.equal(inHours(dias, 'America/Sao_Paulo', new Date('2026-11-18T22:00:00Z')), false);   // qua 19:00 em SP
});

test('parseOut aceita JSON em bloco de código e recusa sem resposta', () => {
  assert.equal(parseOut('```json\n' + out({ resposta: 'oi' }) + '\n```').resposta, 'oi');
  assert.throws(() => parseOut(out({ resposta: '' })));
});
