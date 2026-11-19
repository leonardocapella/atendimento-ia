// Provedor via .env (D3): qualquer API compatível com OpenAI (9router, Ollama /v1, Groq, Gemini /openai).
// ponytail: sem adaptador Anthropic nativo. Fallback só no 429; outro erro continua no principal.
export type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type Msg = { role: 'system' | 'user' | 'assistant'; content: string | Part[] };
export type Chat = (messages: Msg[], opts?: { json?: boolean; temperature?: number }) => Promise<string>;
export type LlmTarget = { baseUrl: string; model: string; apiKey?: string };

export class LlmError extends Error {
  status: number;
  constructor(status: number) { super(`LLM respondeu ${status}`); this.status = status; }
}

export const llmEnv = (env = process.env) => ({
  baseUrl: env.LLM_BASE_URL ?? '',
  model: env.LLM_MODEL ?? '',
  approved: env.LLM_APPROVED_FOR_PRODUCTION === 'true',
});

export function llmTargets(env = process.env): LlmTarget[] {
  const out: LlmTarget[] = [];
  if (env.LLM_BASE_URL && env.LLM_MODEL) out.push({ baseUrl: env.LLM_BASE_URL, model: env.LLM_MODEL, apiKey: env.LLM_API_KEY });
  if (env.LLM_FALLBACK_BASE_URL && env.LLM_FALLBACK_MODEL)
    out.push({ baseUrl: env.LLM_FALLBACK_BASE_URL, model: env.LLM_FALLBACK_MODEL, apiKey: env.LLM_FALLBACK_API_KEY });
  return out;
}

export function openaiChat(baseUrl: string, model: string, apiKey = '', timeoutMs = 30_000, fetchFn: typeof fetch = fetch): Chat {
  return async (messages, opts) => {
    const r = await fetchFn(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify({ model, messages, temperature: opts?.temperature ?? 0.3, ...(opts?.json && { response_format: { type: 'json_object' } }) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // só o status: o corpo do erro pode ecoar o prompt (conteúdo do cliente)
    if (!r.ok) throw new LlmError(r.status);
    const text = (await r.json())?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('LLM sem texto na resposta');
    return text;
  };
}

// 429 no principal tenta o próximo. 500 não tenta: é falha, não cota.
export function withFallback(targets: LlmTarget[], timeoutMs = 30_000, fetchFn: typeof fetch = fetch): Chat | undefined {
  const chats = targets.filter((t) => t.baseUrl && t.model).map((t) => openaiChat(t.baseUrl, t.model, t.apiKey ?? '', timeoutMs, fetchFn));
  if (!chats.length) return undefined;
  return async (messages, opts) => {
    let last: unknown;
    for (let i = 0; i < chats.length; i++) {
      try { return await chats[i](messages, opts); }
      catch (e) {
        last = e;
        if (!(e instanceof LlmError && e.status === 429 && i < chats.length - 1)) throw e;
      }
    }
    throw last;
  };
}
