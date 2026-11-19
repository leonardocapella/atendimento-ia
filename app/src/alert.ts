// Alerta fora do Chatwoot (T9): WhatsApp do gestor pela mesma Evolution do QR.
// Sem instância ou número, não envia. Não fala com cliente.
export type Alert = (text: string) => Promise<void>;

export function whatsappAlert(base: string, apiKey: string, instance: string, number: string, fetchFn: typeof fetch = fetch): Alert {
  const root = base.replace(/\/$/, '');
  return async (text) => {
    const r = await fetchFn(`${root}/message/sendText/${instance}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: apiKey },
      body: JSON.stringify({ number, text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Evolution respondeu ${r.status}`);
  };
}

export function alertFromEnv(env = process.env, fetchFn: typeof fetch = fetch): Alert | null {
  const base = env.EVOLUTION_URL ?? '', key = env.EVOLUTION_API_KEY ?? '', instance = env.EVOLUTION_INSTANCE ?? '';
  const number = (env.GESTOR_WHATSAPP ?? '').replace(/\D/g, '');
  if (!base || !key || !/^[A-Za-z0-9_-]{1,64}$/.test(instance) || !/^\d{10,15}$/.test(number)) return null;
  return whatsappAlert(base, key, instance, number, fetchFn);
}
