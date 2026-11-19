// Único módulo que conhece o formato do Chatwoot: parse dos webhooks para eventos de domínio + cliente HTTP.
// Regra 1b (OV-F6): mensagem pública sai pelo token do agent bot; o token de admin só faz nota, atribuição, labels e status.

export type Author = 'cliente' | 'ia' | 'humano' | null;   // null = atividade, template, nota privada
export type CwMsg = {
  id: number; content: string | null; message_type: number | string; private?: boolean;
  sender_type?: string; sender?: { type?: string; name?: string };
  attachments?: { file_type: string; data_url?: string }[];
  content_attributes?: { in_reply_to?: number; brain_send_id?: string } | null;
};

export function authorOf(m: CwMsg): Author {
  if (m.private) return null;
  const t = String(m.message_type), st = (m.sender_type ?? m.sender?.type ?? '').toLowerCase();
  if (t === '0' || t === 'incoming') return 'cliente';
  if (t !== '1' && t !== 'outgoing') return null;          // activity / template
  return st === 'agentbot' || st === 'agent_bot' ? 'ia' : st === 'user' ? 'humano' : null;
}

export type Ev =
  | { kind: 'msg'; key: string; account?: number; conv: number; inbox?: number; id: number; author: Author;
      contactId?: number; senderName?: string; text: string; files: string[] }
  | { kind: 'msg_status'; key: string; account?: number; id: number; delivered: boolean; failed: boolean }
  | { kind: 'conv_status'; key: string; account?: number; conv: number; status: string }
  | { kind: 'labels'; key: string; account?: number; conv: number; labels: string[] };

// conversation_updated traz a lista atual, ou changed_attributes.labels = [antes, depois].
export function labelList(b: any): string[] | null {
  if (Array.isArray(b?.labels)) return b.labels.map(String);
  const ch = b?.changed_attributes?.labels;
  if (Array.isArray(ch?.[1])) return ch[1].map(String);
  if (Array.isArray(ch?.current_value)) return ch.current_value.map(String);
  return null;
}

export function parseEvent(b: any): Ev | null {
  const account = b?.account?.id ?? b?.account_id;
  if (b?.event === 'message_created' && b.conversation?.id) {
    const m = b as CwMsg;
    return {
      kind: 'msg', key: `msg:${b.id}`, account, conv: b.conversation.id, inbox: b.inbox?.id ?? b.conversation.inbox_id, id: b.id,
      author: authorOf(m), contactId: b.sender?.type === 'contact' ? b.sender.id : b.conversation.contact_inbox?.contact_id,
      senderName: b.sender?.name, text: (b.content ?? '').trim(), files: (b.attachments ?? []).map((a: any) => a.file_type),
    };
  }
  if (b?.event === 'message_updated' && b.id) {
    const delivered = Boolean(b.source_id), failed = b.status === 'failed';
    return { kind: 'msg_status', key: `upd:${b.id}:${b.status}:${delivered}`, account, id: b.id, delivered, failed };
  }
  if ((b?.event === 'conversation_status_changed' || b?.event === 'conversation_updated') && b.id && b.status)
    return { kind: 'conv_status', key: `conv:${b.id}:${b.status}:${b.updated_at ?? ''}`, account, conv: b.id, status: b.status };
  if (b?.event === 'conversation_updated' && b.id) {
    const labels = labelList(b);
    if (labels) return { kind: 'labels', key: `lbl:${b.id}:${[...labels].sort().join(',')}:${b.updated_at ?? ''}`, account, conv: b.id, labels };
  }
  return null;
}

export class HttpError extends Error {
  status: number;
  constructor(status: number) { super(`Chatwoot respondeu ${status}`); this.status = status; }
  get retryable() { return this.status >= 500 || this.status === 429; }
}

export type Chatwoot = {
  send(conv: number, content: string, sendId: string, file?: { url: string; name: string }): Promise<number>;
  messages(conv: number): Promise<CwMsg[]>;
  note(conv: number, content: string): Promise<void>;
  assign(conv: number, to: { user_id?: number; team_id?: number }): Promise<void>;
  addLabels(conv: number, labels: string[]): Promise<void>;
  open(conv: number): Promise<void>;
  urgent(conv: number): Promise<void>;
};

export function chatwootClient(base: string, account: number, botToken: string, adminToken: string): Chatwoot {
  const url = (p: string) => `${base}/api/v1/accounts/${account}/conversations/${p}`;
  const call = async (token: string, path: string, init: RequestInit = {}) => {
    const isForm = init.body instanceof FormData;
    const r = await fetch(url(path), {
      ...init, signal: AbortSignal.timeout(15_000),
      headers: { api_access_token: token, ...(!isForm && init.body && { 'content-type': 'application/json' }) },
    });
    if (!r.ok) throw new HttpError(r.status);
    return r.json().catch(() => ({}));
  };
  const post = (token: string, path: string, body: unknown) => call(token, path, { method: 'POST', body: JSON.stringify(body) });

  return {
    async send(conv, content, sendId, file) {
      let body: BodyInit;
      if (file) {
        const img = await fetch(file.url, { signal: AbortSignal.timeout(15_000) });
        if (!img.ok) throw new HttpError(img.status);
        const f = new FormData();
        f.append('content', content);
        f.append('message_type', 'outgoing');
        f.append('content_attributes', JSON.stringify({ brain_send_id: sendId }));
        f.append('attachments[]', await img.blob(), file.name);
        body = f;
      } else body = JSON.stringify({ content, message_type: 'outgoing', private: false, content_attributes: { brain_send_id: sendId } });
      return (await call(botToken, `${conv}/messages`, { method: 'POST', body })).id;
    },
    messages: async (conv) => (await call(adminToken, `${conv}/messages`)).payload ?? [],
    note: async (conv, content) => { await post(adminToken, `${conv}/messages`, { content, message_type: 'outgoing', private: true }); },
    assign: async (conv, to) => { await post(adminToken, `${conv}/assignments`, to.user_id ? { assignee_id: to.user_id } : { team_id: to.team_id }); },
    async addLabels(conv, labels) {   // o POST substitui a lista: soma às atuais
      const cur: string[] = (await call(adminToken, `${conv}/labels`)).payload ?? [];
      await post(adminToken, `${conv}/labels`, { labels: [...new Set([...cur, ...labels])] });
    },
    open: async (conv) => { await post(adminToken, `${conv}/toggle_status`, { status: 'open' }); },
    urgent: async (conv) => { await post(adminToken, `${conv}/toggle_priority`, { priority: 'urgent' }); },
  };
}
