// Provedor via .env (D3): qualquer API compatível com OpenAI (9router, Ollama /v1, Groq, Gemini /openai).
// ponytail: sem adaptador Anthropic nativo e sem fallback; entram quando o modelo de produção (D2) for escolhido.
export type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type Msg = { role: 'system' | 'user' | 'assistant'; content: string | Part[] };
export type Chat = (messages: Msg[], opts?: { json?: boolean; temperature?: number }) => Promise<string>;

export const llmEnv = () => ({
  baseUrl: process.env.LLM_BASE_URL ?? '',
  model: process.env.LLM_MODEL ?? '',
  approved: process.env.LLM_APPROVED_FOR_PRODUCTION === 'true',
});

export function openaiChat(baseUrl: string, model: string, apiKey = '', timeoutMs = 30_000): Chat {
  return async (messages, opts) => {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
      body: JSON.stringify({ model, messages, temperature: opts?.temperature ?? 0.3, ...(opts?.json && { response_format: { type: 'json_object' } }) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    // só o status: o corpo do erro pode ecoar o prompt (conteúdo do cliente)
    if (!r.ok) throw new Error(`LLM respondeu ${r.status}`);
    const text = (await r.json())?.choices?.[0]?.message?.content;
    if (typeof text !== 'string') throw new Error('LLM sem texto na resposta');
    return text;
  };
}
