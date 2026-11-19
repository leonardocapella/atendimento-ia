// Replay dry-run (T7). Não chama LLM nem Chatwoot: lê a conversa, corta na divergência
// e marca o que o Lorenzo pontua (turno do handoff + 20% aleatórios). Saída: CSV.
import { readFileSync } from 'node:fs';

export type Turno = { i: number; quem: string; texto: string; handoff?: boolean };
export type Conversa = { id: string; turno_handoff_humano: number; turnos: Turno[]; ficticio?: boolean };

export type Linha = { conversa: string; turno: number; quem: string; pontuar: boolean; motivo: string; texto: string };

export function linhas(c: Conversa, divergiuEm: number | null, amostra: Set<number>): Linha[] {
  const corte = divergiuEm ?? Infinity;
  return c.turnos.filter((t) => t.i <= corte).map((t) => {
    const handoff = t.i === c.turno_handoff_humano;
    const pontuar = handoff || amostra.has(t.i);
    return { conversa: c.id, turno: t.i, quem: t.quem, pontuar, motivo: handoff ? 'handoff' : amostra.has(t.i) ? 'amostra' : '', texto: t.texto };
  });
}

// 20% estável: sem Math.random, para o CSV não mudar entre execuções.
export function amostra20(turnos: number[]): Set<number> {
  return new Set(turnos.filter((_, i) => i % 5 === 0));
}

const celula = (s: string) => `"${s.replace(/"/g, '""')}"`;
export function paraCsv(rows: Linha[]): string {
  const head = 'conversa,turno,quem,pontuar,motivo,texto';
  return [head, ...rows.map((r) => [r.conversa, r.turno, r.quem, r.pontuar ? 'sim' : 'nao', r.motivo, celula(r.texto)].join(','))].join('\n') + '\n';
}

if (import.meta.main) {
  const c: Conversa = JSON.parse(readFileSync(new URL('../evals/ficticio/conversa.json', import.meta.url), 'utf8'));
  const divergiu = process.argv.includes('--divergiu') ? Number(process.argv[process.argv.indexOf('--divergiu') + 1]) : null;
  process.stdout.write(paraCsv(linhas(c, divergiu, amostra20(c.turnos.map((t) => t.i)))));
}
