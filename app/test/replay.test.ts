import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { amostra20, linhas, paraCsv, type Conversa } from '../src/replay.ts';

const conversa: Conversa = JSON.parse(readFileSync(new URL('../evals/ficticio/conversa.json', import.meta.url), 'utf8'));

test('replay: corta na divergência, pontua o handoff e 20%', () => {
  assert.equal(conversa.ficticio, true);
  const rows = linhas(conversa, 3, amostra20(conversa.turnos.map((t) => t.i)));
  assert.deepEqual(rows.map((r) => r.turno), [1, 2, 3]);
  assert.equal(rows.some((r) => r.motivo === 'handoff'), false, 'corte antes do handoff');

  const tudo = linhas(conversa, null, amostra20([1, 2, 3, 4, 5]));
  assert.equal(tudo.find((r) => r.turno === 4)!.pontuar, true);
  assert.equal(tudo.find((r) => r.turno === 1)!.motivo, 'amostra');
  assert.match(paraCsv(tudo), /^conversa,turno/);
  assert.ok(paraCsv(tudo).includes('"Vou te passar para o Lorenzo."'));
});
