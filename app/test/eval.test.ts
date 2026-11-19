import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prontoParaPublicar, runEval, veto } from '../src/eval.ts';
import { parseOut } from '../src/agent/prompt.ts';

const json = (o: object) => JSON.stringify({ resposta: 'Oi, eu sou a Malu.', decisao: 'responder', motivo: null, campos: {}, sinal_compra: false, enviar_produtos: [], ...o });

test('veto: duas apresentações, TF, mídia da IA, enviei sem confirmação, Sim transfere', () => {
  const base = parseOut(json({}));
  assert.equal(veto({ id: 'EV1', tipo: 'llm', cliente: '' }, base), null);
  assert.equal(veto({ id: 'EV1', tipo: 'llm', cliente: '' }, parseOut(json({ resposta: 'Eu sou a Malu. Eu sou o Júnior.' }))), 'duas apresentações');
  assert.equal(veto({ id: 'EV3', tipo: 'llm', cliente: '' }, parseOut(json({ resposta: 'Oi TF, tudo bem?' }))), 'usou nome de perfil TF');
  assert.equal(veto({ id: 'EV4', tipo: 'llm', cliente: '' }, parseOut(json({ resposta: 'Você me enviou um armário cinza.' }))), 'tratou mídia da IA como do cliente');
  assert.equal(veto({ id: 'EV5', tipo: 'llm', cliente: '', sem_confirmacao: true }, parseOut(json({ resposta: 'Enviei as fotos.' }))), 'afirmou envio sem confirmação');
  assert.equal(veto({ id: 'EV6', tipo: 'llm', cliente: '' }, parseOut(json({ decisao: 'transferir', motivo: 'pedido_cliente' }))), '"Sim" não transfere');
});

test('runEval: 3/3 no veto; sem LLM não publica', async () => {
  const ruim = await runEval(async (msgs) => {
    const last = msgs.at(-1)?.content;
    return last === 'Sim' ? json({ decisao: 'transferir', motivo: 'pedido_cliente' }) : json({});
  }, 3);
  assert.equal(ruim.resultados.find((r) => r.id === 'EV6')!.ok, false);
  assert.equal(prontoParaPublicar(ruim, true), false);

  const bom = await runEval(async () => json({}), 3);
  assert.ok(bom.resultados.every((r) => r.ok));
  assert.equal(prontoParaPublicar(bom, true), true);
  assert.equal(prontoParaPublicar(bom, false), false);

  const pulado = await runEval(null);
  assert.equal(pulado.llmRodou, false);
  assert.equal(prontoParaPublicar(pulado, true), false);
  assert.ok(pulado.resultados.find((r) => r.id === 'EV2')!.motivo.includes('motor'));
});
