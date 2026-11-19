import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretOk, eventMeta } from '../src/hooks.ts';

test('secretOk: recusa vazio, errado e tamanho diferente; aceita igual', () => {
  assert.equal(secretOk('x', ''), false);
  assert.equal(secretOk('abc', 'abd'), false);
  assert.equal(secretOk('ab', 'abc'), false);
  assert.equal(secretOk('abc', 'abc'), true);
});

test('eventMeta: nunca vaza conteúdo, nome ou telefone', () => {
  const m = eventMeta({
    event: 'message_created', id: 7, content: 'meu cpf 123', message_type: 'incoming', private: false,
    sender: { type: 'contact', name: 'Mateus', phone_number: '+5561999999999' },
    conversation: { id: 3 }, attachments: [{ data_url: 'x' }],
  });
  assert.deepEqual(m, {
    event: 'message_created', message_id: 7, conversation_id: 3, message_type: 'incoming',
    private: false, sender_type: 'contact', status: null, has_source_id: false, has_attachments: true,
  });
  assert.ok(!JSON.stringify(m).match(/cpf|Mateus|5561/));
});
