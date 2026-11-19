// Alerta fora do Chatwoot (T9). Sem TELEGRAM_BOT_TOKEN o envio vira no-op: nada pago, nada inventado.
export type Alert = (text: string) => Promise<void>;

export function telegramAlert(token: string, chatId: string, fetchFn: typeof fetch = fetch): Alert {
  return async (text) => {
    const r = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`Telegram respondeu ${r.status}`);
  };
}

export function alertFromEnv(env = process.env, fetchFn: typeof fetch = fetch): Alert | null {
  const token = env.TELEGRAM_BOT_TOKEN ?? '', chat = env.TELEGRAM_CHAT_ID ?? '';
  if (!token || !chat) return null;
  return telegramAlert(token, chat, fetchFn);
}
