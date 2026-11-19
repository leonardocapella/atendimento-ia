// Ping do monitor externo (T10). healthchecks.io grátis: URL vazia = não pinga.
export async function ping(url: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (!url) return false;
  try {
    const r = await fetchFn(url, { method: 'GET', signal: AbortSignal.timeout(8_000) });
    return r.ok;
  } catch { return false; }
}
