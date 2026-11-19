// Webhook Chatwoot -> app. F0: valida segredo e registra só METADADOS (sem conteúdo do cliente)
// para os spikes R4 (mensagem humana chega?), OV-F1 (status/source_id de mídia) e OV-F6 (sender de cada token).
import { timingSafeEqual } from 'node:crypto';

export function secretOk(given: string, expected: string): boolean {
  if (!expected) return false; // sem WEBHOOK_SECRET configurado, recusa tudo
  const a = Buffer.from(given), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Extrai só o que os spikes precisam; nunca content, nome, telefone ou anexos.
export function eventMeta(body: any) {
  return {
    event: body?.event ?? null,
    message_id: body?.id ?? null,
    conversation_id: body?.conversation?.id ?? null,
    message_type: body?.message_type ?? null,
    private: body?.private ?? null,
    sender_type: body?.sender?.type ?? null,
    status: body?.status ?? null,
    has_source_id: Boolean(body?.source_id),
    has_attachments: Array.isArray(body?.attachments) && body.attachments.length > 0,
  };
}
