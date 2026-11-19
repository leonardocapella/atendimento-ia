// Motor de conversa ponta a ponta: webhook → onEvent → timer → worker, com Postgres em memória (PGlite),
// Chatwoot fake (guarda as mensagens) e LLM fake (respostas roteirizadas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate, type Db, type Query } from '../src/db.ts';
import { loadConfig, type Config } from '../src/agent/config.ts';
import { onEvent, ensureTenant } from '../src/conversation.ts';
import { claim, intencaoClara, readCapped, runJob, type WorkerDeps } from '../src/worker.ts';
import { inHours, nextOpen } from '../src/hours.ts';
import { validName, parseOut, buildMessages, capFrases, guardReply, fullSystem, primeiraFala } from '../src/agent/prompt.ts';
import { HttpError, labelList, parseEvent, type Chatwoot, type CwMsg } from '../src/chatwoot.ts';
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
  const conv = { db, cfg: config, tenantId } as { db: Db; cfg: Config; tenantId: number; iaLigada?: () => boolean; pausarNoTransbordo?: boolean };
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
    return onEvent(conv, { event: 'message_created', account: { id: 1 }, id: m.id, content, message_type: 'incoming', private: false,
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
  // "avança o relógio": puxa para trás os prazos e datas em vez de mexer no now() do Postgres
  const advance = async (min: number) => {
    const i = `${min} minutes`;
    await q(`UPDATE timers SET due_at = due_at - $1::interval, done_at = done_at - $1::interval`, [i]);
    await q(`UPDATE handoff_events SET handoff_em = handoff_em - $1::interval`, [i]);
  };
  const state = async () => (await q(`SELECT * FROM conversation_state WHERE chatwoot_conversation_id = $1`, [CONV]))[0];
  const handoffs = () => q(`SELECT motivo FROM handoff_events ORDER BY id`);
  const outgoing = () => fake.msgs.filter((m) => m.message_type === 1 && !m.private);
  return { advance, db, q, deps, conv, config, fake, prompts, customer, human, drain, state, handoffs, outgoing };
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

test('EV2: fala humana não pausa; a etiqueta ia-pausada pausa e removida retoma', async () => {
  const s = await setup();
  await s.customer('oi');
  assert.equal(await s.human('nota interna', true), 'ignorado');
  assert.equal(await s.human('Oi, aqui é o Lorenzo'), 'humano');
  assert.equal((await s.state()).ia_pausada, false);
  const labels = (ls: string[], k: string) => onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId },
    { event: 'conversation_updated', account: { id: 1 }, id: CONV, labels: ls, updated_at: k });
  assert.equal(await labels(['ia-pausada'], '1'), 'pausada');
  assert.equal((await s.state()).ia_pausada, true);
  assert.equal(await s.customer('e aí?'), 'pausada');
  assert.equal(await labels(['lead-quente'], '2'), 'retomada');
  assert.equal((await s.state()).ia_pausada, false);
  assert.equal(await s.customer('voltei'), 'agendada');
});

test('EV2b: etiqueta ia-pausada durante a geração descarta a resposta', async () => {
  const s = await setup();
  await s.customer('oi');
  s.deps.chat = async () => {
    await onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId },
      { event: 'conversation_updated', account: { id: 1 }, id: CONV, labels: ['ia-pausada'], updated_at: '1' });
    return out({});
  };
  await s.drain();
  assert.equal(s.outgoing().length, 0);
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
  assert.equal((await s.state()).ia_pausada, false);
  assert.equal((await s.q(`SELECT estagio FROM leads`))[0].estagio, 'quente');
  const texts = s.outgoing().map((m) => m.content);
  assert.equal(texts.length, 1);
  assert.match(texts[0]!, /Lorenzo/);
  for (const c of ['open', 'assign:2', 'urgent', 'note']) assert.ok(s.fake.calls.includes(c), c);
  assert.ok(s.fake.calls.some((c) => c.includes('lead-quente')));
  assert.ok(!s.fake.calls.some((c) => c.includes('ia-pausada')));
  assert.match(s.fake.msgs.find((m) => m.private)!.content!, /cidade: Curitiba/);

  // a Malu segue; um segundo transbordo não abre
  await s.customer('e aí?'); await s.drain();
  assert.equal((await s.handoffs()).length, 1);
  assert.ok(s.prompts.length >= 2);
  // 1ª resposta humana: para o SLA e vai para em_negociacao
  await s.human('Oi, sou o Lorenzo');
  assert.ok((await s.q(`SELECT primeira_resposta_em FROM handoff_events`))[0].primeira_resposta_em);
  assert.equal((await s.q(`SELECT estagio FROM leads`))[0].estagio, 'em_negociacao');
});

test('prévia: preço não transfere; transferir com pergunta vira resposta; nome do perfil entra; sinal exige intenção', async () => {
  assert.equal(intencaoClara('Quanto fica mais ou menos o preço?'), false);
  assert.equal(intencaoClara('As medidas são 2,80 m. Preciso para janeiro.'), false);
  assert.equal(intencaoClara('Pode mandar a proposta, quero fechar'), true);

  const longo = 'Frase um. Frase dois. Frase três. Frase quatro?';
  assert.equal(capFrases(longo).split(/(?<=[.!?])\s+/).length, 3);
  assert.match(capFrases(longo), /quatro\?$/);
  assert.equal(capFrases('Uma. Duas.'), 'Uma. Duas.');

  const cortado = guardReply({ resposta: 'Vou te passar. Qual a cidade?', decisao: 'transferir', motivo: 'pedido_cliente', campos: {}, sinal_compra: true, enviar_produtos: [] });
  assert.equal(cortado.decisao, 'responder');
  assert.equal(cortado.motivo, null);
  const ok = guardReply({ resposta: 'Vou te passar para o consultor.', decisao: 'transferir', motivo: 'pedido_cliente', campos: {}, sinal_compra: false, enviar_produtos: [] });
  assert.equal(ok.decisao, 'transferir');

  const s = await setup({ replies: [out({ decisao: 'transferir', motivo: 'pedido_cliente', sinal_compra: true, resposta: 'Entendi. Vou te passar. Qual a cidade?', campos: { interesse: 'armário', medidas: '2,80 m', prazo: 'janeiro' } })] });
  await s.customer('Preciso para janeiro. Quanto fica mais ou menos o preço?', { name: 'Carla Mendes' });
  await s.drain();
  assert.deepEqual(await s.handoffs(), []);
  assert.equal((await s.state()).ia_pausada, false);
  const sys = s.prompts[0][0].content as string;
  assert.match(sys, /Nome do cliente: Carla/);
  assert.match(sys, /Pedido de preço não é transbordo/);
  assert.match(sys, /No máximo 3 frases/);
  const lead = (await s.q(`SELECT qualificacao, sinal_compra FROM leads`))[0];
  assert.equal(lead.qualificacao.nome, 'Carla');
  assert.equal(lead.sinal_compra, false);
  assert.equal((s.outgoing().at(-1)!.content!.match(/\?/g) ?? []).length, 1);

  const sysCfg = fullSystem(s.config.agentes.vendas, { nome: 'Carla', apresentou: false, foraDoHorario: false, campos: {}, produtos: [] });
  assert.match(sysCfg, /não pergunte como chamar/i);
});

test('primeira fala: cliente já disse o móvel = apresentação e próxima pergunta, nunca como posso te ajudar', async () => {
  const ruim = 'Olá, Lorenzo! Eu sou a Malu, da EBM. Como posso te ajudar?';
  assert.equal(primeiraFala(ruim, 'Opa, qro comprar um armário', 'Você tem as medidas do ambiente?'),
    'Olá, Lorenzo! Eu sou a Malu, da EBM. Você tem as medidas do ambiente?');
  assert.equal(primeiraFala('Oi! Como posso te ajudar?', 'Oi', 'Qual móvel você procura?'), 'Oi! Como posso te ajudar?');

  const s = await setup({ replies: [out({ resposta: ruim, campos: { interesse: 'armário' } })] });
  await s.customer('Opa, qro comprar um armário', { name: 'Lorenzo' });
  await s.drain();
  const text = s.outgoing().at(-1)!.content!;
  assert.doesNotMatch(text, /como posso te ajudar/i);
  assert.match(text, /Malu/);
  assert.match(text, /medidas do ambiente/);
  assert.match(s.prompts[0][0].content as string, /já disse o que quer/);
  assert.deepEqual(await s.handoffs(), []);
});

test('fora do escopo não transfere: a Malu explica e segue', async () => {
  const s = await setup({ replies: [out({ decisao: 'transferir', motivo: 'pergunta_fora_do_escopo', resposta: 'A EBM faz armários sob medida para casa, em Brasília e região. Para o carro, não fazemos. Quer um armário de quarto?' })] });
  await s.customer('Vocês fazem armário para carro?');
  await s.drain();
  assert.deepEqual(await s.handoffs(), []);
  assert.equal((await s.state()).ia_pausada, false);
  assert.match(s.outgoing().at(-1)!.content!, /casa/);
  assert.match(s.prompts[0][0].content as string, /armário para carro/);
});

test('IA_ATIVA desliga todas as conversas sem reiniciar', async () => {
  const s = await setup();
  s.conv.iaLigada = () => false;
  assert.equal(await s.customer('oi'), 'ia desligada');
  await s.drain();
  assert.equal(s.prompts.length, 0);
});

test('tirar ia-pausada retoma e o handoff do lead quente não recoloca', async () => {
  const campos = { interesse: 'armário', prazo: '2026-12-01', cidade: 'Curitiba' };
  const s = await setup({ replies: [out({ campos, sinal_compra: true, resposta: 'passo' }), out({ resposta: 'Sigo aqui.' })] });
  s.deps.pausarNoTransbordo = true;
  await s.customer('quero fechar o armário para dezembro em Curitiba');
  await s.drain();
  assert.equal((await s.state()).ia_pausada, true);
  assert.ok(s.fake.calls.some((c) => c.includes('ia-pausada')));

  const n = s.fake.calls.length;
  assert.equal(await onEvent(s.conv, { event: 'conversation_updated', account: { id: 1 }, id: CONV, status: 'open',
    labels: ['lead-quente'], changed_attributes: [{ labels: { previous_value: ['ia-pausada', 'lead-quente'], current_value: ['lead-quente'] } }], updated_at: 'tira' }), 'retomada');
  assert.equal((await s.state()).ia_pausada, false);
  assert.ok((await s.state()).ia_retomada_em);
  assert.ok((await s.q(`SELECT encerrado_em FROM handoff_events`))[0].encerrado_em);

  await s.q(`UPDATE timers SET due_at = now(), locked_until = NULL, done_at = NULL WHERE kind = 'handoff'`);
  await s.drain();
  assert.ok(!s.fake.calls.slice(n).some((c) => c.includes('ia-pausada')));
  await s.customer('e o prazo?'); await s.drain();
  assert.equal((await s.handoffs()).length, 1);
  assert.match(s.outgoing().at(-1)!.content!, /Sigo aqui/);
});

test('webhook do Chatwoot: lista de etiquetas ganha do status', () => {
  const body = { event: 'conversation_updated', id: 9, status: 'open', updated_at: '1',
    changed_attributes: [{ labels: { previous_value: ['ia-pausada'], current_value: [] } }] };
  assert.deepEqual(labelList(body), []);
  assert.equal(parseEvent(body)?.kind, 'labels');
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

test('regra 7: resolver não tira a pausa da etiqueta ia-pausada', async () => {
  const s = await setup();
  await s.customer('oi');
  await onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId },
    { event: 'conversation_updated', account: { id: 1 }, id: CONV, labels: ['ia-pausada'], updated_at: '0' });
  const resolve = () => onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId },
    { event: 'conversation_status_changed', account: { id: 1 }, id: CONV, status: 'resolved', updated_at: '1' });
  await resolve();
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

// ---- T5: SLA, mensagem de espera, reativação ----
const notes = (s: Awaited<ReturnType<typeof setup>>) => s.fake.msgs.filter((m) => m.private).map((m) => m.content!);

test('SLA: estouro 1 lembra destino e gestor; estouro 2 passa ao backup; cada um uma vez', async () => {
  const s = await setup({ cfg: (c) => { c.agentes.vendas.regras.transbordo.backup_team_id = 3; } });
  await s.q(`INSERT INTO users_map (tenant_id, chatwoot_user_id, role) VALUES ($1, 2, 'atendente'), ($1, 8, 'gestor')`, [s.deps.tenantId]);
  await s.customer('falar com atendente'); await s.drain();
  assert.equal(notes(s).length, 1);   // só a nota do transbordo

  await s.advance(10); await s.drain();
  assert.match(notes(s).at(-1)!, /SLA estourado \(10 min/);
  assert.match(notes(s).at(-1)!, /user\/2\/.*user\/8\//);
  assert.ok(s.fake.calls.includes('labels:sla-estourado'));
  assert.ok(!s.fake.calls.includes('assign:team3'));

  await s.advance(20); await s.drain();
  assert.ok(s.fake.calls.includes('assign:team3'));
  assert.match(notes(s).at(-1)!, /30 min.*time de backup/);
  await s.advance(60); await s.drain();
  assert.equal(notes(s).length, 3);
  assert.equal((await s.q(`SELECT sla_estouros FROM handoff_events`))[0].sla_estouros, 2);
});

test('SLA: alerta WhatsApp sai uma vez por estouro e não depende do Chatwoot', async () => {
  const s = await setup();
  const avisos: string[] = [];
  s.deps.alert = async (t) => { avisos.push(t); };
  await s.customer('falar com atendente'); await s.drain();
  await s.advance(10); await s.drain();
  assert.equal(avisos.length, 1);
  assert.match(avisos[0], /SLA 1/);
  await s.advance(60); await s.drain();
  assert.equal(avisos.length, 2);
});

test('regra 7: resolvida encerra o handoff; SLA para e um transbordo novo é possível', async () => {
  const s = await setup();
  await s.customer('falar com atendente'); await s.drain();
  const resolve = () => onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId }, { event: 'conversation_status_changed', account: { id: 1 }, id: CONV, status: 'resolved', updated_at: '9' });
  await resolve();
  assert.ok((await s.q(`SELECT encerrado_em FROM handoff_events`))[0].encerrado_em);
  assert.equal((await s.q(`SELECT count(*)::int n FROM timers WHERE kind IN ('sla1','sla2','handoff') AND done_at IS NULL`))[0].n, 0);
  await s.advance(60); await s.drain();
  assert.equal(notes(s).filter((n) => /SLA/.test(n)).length, 0);
  await s.customer('oi de novo');
  await s.customer('falar com atendente'); await s.drain();
  assert.equal((await s.handoffs()).length, 2);
});

test('SLA: nota que falha não marca estouro; retry avisa uma vez', async () => {
  const s = await setup();
  await s.customer('falar com atendente'); await s.drain();
  const orig = s.deps.cw.note.bind(s.deps.cw);
  s.deps.cw.note = async () => { throw new HttpError(503); };
  await s.advance(10);
  await s.drain();
  assert.equal((await s.q(`SELECT sla_estouros FROM handoff_events`))[0].sla_estouros, 0);
  s.deps.cw.note = orig;
  await s.q(`UPDATE timers SET due_at = now(), locked_until = NULL, done_at = NULL WHERE kind = 'sla1'`);
  await s.drain();
  assert.equal(notes(s).filter((n) => /SLA/.test(n)).length, 1);
  assert.equal((await s.q(`SELECT sla_estouros FROM handoff_events`))[0].sla_estouros, 1);
});

test('envio: crash depois do POST não reenvia nem perde a mensagem', async () => {
  const s = await setup();
  await s.customer('oi');
  const real = s.deps.cw.send.bind(s.deps.cw);
  let posts = 0;
  s.deps.cw.send = async (...a) => { posts++; const id = await real(...a); if (posts === 1) throw new HttpError(503); return id; };
  await s.drain();
  assert.equal(posts, 1);
  assert.equal(s.outgoing().length, 1);
  await s.q(`UPDATE timers SET due_at = now(), locked_until = NULL, done_at = NULL, tentativas = 0 WHERE kind = 'reply'`);
  await s.drain();
  assert.equal(posts, 1, 'retry acha o brain_send_id e não posta de novo');
  assert.equal(s.outgoing().length, 1);
  assert.equal((await s.q(`SELECT status FROM outbound_sends WHERE kind = 'reply'`))[0].status, 'sent');
});

test('readCapped: para acima do teto', async () => {
  const big = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(100)); c.enqueue(new Uint8Array(100)); c.close(); } });
  assert.equal(await readCapped(big, 150), null);
  const ok = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1, 2, 3])); c.close(); } });
  assert.equal((await readCapped(ok, 150))!.length, 3);
});

test('SLA: para na 1ª resposta humana pública; nota privada e mensagem da IA não param', async () => {
  const s = await setup();
  await s.customer('falar com atendente'); await s.drain();
  await s.human('vou ver', true);   // nota privada
  await s.advance(10); await s.drain();
  assert.equal(notes(s).filter((n) => /SLA/.test(n)).length, 1, 'nota privada não para o SLA');

  const s2 = await setup();
  await s2.customer('falar com atendente'); await s2.drain();
  await s2.human('Oi, aqui é o Lorenzo');
  await s2.advance(60); await s2.drain();
  assert.equal(notes(s2).filter((n) => /SLA/.test(n)).length, 0);
});

test('mensagem de espera: cliente insiste depois de 15 min = 1 aviso; não pausa nem para o SLA', async () => {
  const s = await setup();
  await s.customer('falar com atendente'); await s.drain();
  await onEvent({ db: s.db, cfg: s.config, tenantId: s.deps.tenantId },
    { event: 'conversation_updated', account: { id: 1 }, id: CONV, labels: ['ia-pausada'], updated_at: 'p' });
  const antes = s.outgoing().length;
  await s.customer('alô?'); await s.drain();
  assert.equal(s.outgoing().length, antes, 'antes de 15 min, nenhum aviso');

  await s.advance(16);
  await s.customer('tem alguém?'); await s.customer('???'); await s.drain();
  assert.equal(s.outgoing().length, antes + 1);
  assert.match(s.outgoing().at(-1)!.content!, /já foi avisado/);
  assert.equal((await s.q(`SELECT primeira_resposta_em FROM handoff_events`))[0].primeira_resposta_em, null);

  await s.advance(16);
  await s.customer('e agora?'); await s.drain();
  assert.equal(s.outgoing().length, antes + 2, 'outro aviso depois de mais 15 min');
});

test('handoff fora do expediente do vendedor: SLA começa na abertura e o cliente sabe quando', async () => {
  const s = await setup();
  await s.q(`INSERT INTO users_map (tenant_id, chatwoot_user_id, role, horario) VALUES ($1, 2, 'atendente', '{"dom":[["00:00","00:01"]]}')`, [s.deps.tenantId]);
  await s.customer('falar com atendente'); await s.drain();
  const [sla1] = await s.q(`SELECT due_at FROM timers WHERE kind = 'sla1'`);
  assert.ok(new Date(sla1.due_at).getTime() - Date.now() > 3600e3, 'SLA não começa agora');
  assert.match(s.outgoing().at(-1)!.content!, /volta domingo/);
});

test('fora do horário: reativa na abertura e responde dentro da janela de 24h', async () => {
  const s = await setup({ cfg: (c) => {
    const a = c.agentes.vendas;
    a.horario.dias = { dom: [['00:00', '00:01']] };
    a.horario.responder_fora_do_horario = false;
    a.horario.msg_ausencia = 'Fechados.';
  } });
  await s.customer('oi'); await s.drain();
  assert.deepEqual(s.outgoing().map((m) => m.content), ['Fechados.']);
  // abre o expediente e vence o timer de reativação
  s.config.agentes.vendas.horario.dias = {};
  await s.q(`UPDATE timers SET due_at = now() WHERE kind = 'reativar'`);
  await s.drain();
  assert.equal(s.prompts.length, 1);
  assert.equal(s.outgoing().length, 2);
});

test('reativação fora da janela de 24h = transbordo fora_janela, sem mensagem livre', async () => {
  const s = await setup({ cfg: (c) => {
    c.agentes.vendas.horario.dias = { dom: [['00:00', '00:01']] };
    c.agentes.vendas.horario.responder_fora_do_horario = false;
    c.agentes.vendas.horario.msg_ausencia = 'Fechados.';
  } });
  await s.customer('oi'); await s.drain();
  await s.q(`UPDATE conversation_state SET last_customer_msg_at = now() - interval '25 hours'`);
  await s.q(`UPDATE timers SET due_at = now() WHERE kind = 'reativar'`);
  await s.drain();
  assert.deepEqual((await s.handoffs()).map((h) => h.motivo), ['fora_janela']);
  assert.equal(s.prompts.length, 0);
});

test('nextOpen acha a próxima abertura no fuso', () => {
  const dias = { qui: [['09:00', '18:00']] as [string, string][] };
  const d = nextOpen(dias, 'America/Sao_Paulo', new Date('2026-11-18T22:00:00Z'));   // qua 19:00 SP
  assert.equal(d.toISOString(), '2026-11-19T12:00:00.000Z');                           // qui 09:00 SP
  const aberto = new Date('2026-11-19T13:00:00Z');
  assert.equal(nextOpen(dias, 'America/Sao_Paulo', aberto), aberto);
});
