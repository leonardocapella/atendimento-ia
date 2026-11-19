// Expediente: faixas por dia da semana no fuso do agente. Usado pela IA (fora do horário) e pelo SLA do vendedor.
export type Dias = Partial<Record<'dom' | 'seg' | 'ter' | 'qua' | 'qui' | 'sex' | 'sab', [string, string][]>>;
const DIA = { Sun: 'dom', Mon: 'seg', Tue: 'ter', Wed: 'qua', Thu: 'qui', Fri: 'sex', Sat: 'sab' } as const;
const fmts = new Map<string, Intl.DateTimeFormat>();

export function inHours(dias: Dias, fuso: string, now = new Date()): boolean {
  if (!Object.keys(dias).length) return true;   // sem horário configurado = sempre aberto
  let f = fmts.get(fuso);
  if (!f) fmts.set(fuso, (f = new Intl.DateTimeFormat('en-US', { timeZone: fuso, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })));
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const hm = `${p.hour}:${p.minute}`;
  return (dias[DIA[p.weekday as keyof typeof DIA]] ?? []).some(([a, b]) => hm >= a && hm < b);
}

// Próximo minuto dentro do expediente (o próprio `from` se já estiver aberto).
// ponytail: busca minuto a minuto (até 8 dias, ~60 ms no pior caso); só roda uma vez por transbordo.
export function nextOpen(dias: Dias, fuso: string, from = new Date()): Date {
  if (inHours(dias, fuso, from)) return from;
  const t = new Date(Math.ceil(from.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 8 * 24 * 60; i++, t.setTime(t.getTime() + 60_000)) if (inHours(dias, fuso, t)) return new Date(t);
  return from;   // nenhuma faixa válida: não atrasa o SLA
}

export const quando = (d: Date, fuso: string) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(d);
