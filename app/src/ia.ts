// Liga/desliga da IA. O env trava; o arquivo é o interruptor do painel, lido a cada evento (api e worker).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const PAUSE_LABEL = 'ia-pausada';

export function pausarNoTransbordo(env = process.env): boolean {
  return env.IA_PAUSAR_NO_TRANSBORDO === 'true';
}

/** false no env trava desligada. Ausente ou true = o painel decide. */
export function iaTravadaOff(env = process.env): boolean {
  return env.IA_ATIVA === 'false';
}

export function switchPath(env = process.env): string {
  return env.IA_SWITCH_PATH ?? new URL('../data/ia-ativa.json', import.meta.url).pathname;
}

export function readSwitch(path = switchPath()): boolean | null {
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return typeof j.ativa === 'boolean' ? j.ativa : null;
  } catch { return null; }
}

export function writeSwitch(ativa: boolean, path = switchPath()) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ativa }) + '\n');
}

export function iaAtiva(env = process.env, path = switchPath(env)): boolean {
  if (iaTravadaOff(env)) return false;
  return readSwitch(path) ?? true;
}

const JID_PROIBIDO = /@(g\.us|broadcast|newsletter)\b/i;

export function jidProibido(s: string): boolean {
  return JID_PROIBIDO.test(s);
}

/** null = sem allowlist (todo número individual). Vazio também. */
export function allowlist(env = process.env): Set<string> | null {
  const raw = env.IA_ALLOWLIST?.trim();
  if (!raw) return null;
  const nums = raw.split(/[,;]+/).map((n) => n.replace(/\D/g, '')).filter((n) => n.length >= 10 && n.length <= 15);
  return nums.length ? new Set(nums) : null;
}

function textos(o: unknown, depth = 0): string[] {
  if (!o || typeof o !== 'object' || depth > 3) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (k === 'content' || k === 'messages') continue;
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object') out.push(...textos(v, depth + 1));
  }
  return out;
}

// Histórico do Chatwoot: mesma regra. Sem telefone na lista, não responde.
export function filaBloqueada(ids: string[], env = process.env): 'grupo' | 'fora da lista' | null {
  if (ids.some(jidProibido)) return 'grupo';
  const lista = allowlist(env);
  if (!lista) return null;
  const fones = ids.map((t) => t.replace(/\D/g, '')).filter((n) => n.length >= 10 && n.length <= 15);
  return fones.some((n) => lista.has(n)) ? null : 'fora da lista';
}

// Grupo, status e broadcast nunca. Allowlist definida: só esses E.164.
export function deveIgnorar(b: unknown, env = process.env): 'grupo' | 'fora da lista' | null {
  const x = b as any;
  const bag = textos(x?.sender).concat(
    textos(x?.conversation?.meta?.sender),
    textos(x?.conversation?.contact_inbox),
    textos(x?.conversation?.additional_attributes),
  );
  if (bag.some(jidProibido)) return 'grupo';
  const list = allowlist(env);
  if (!list) return null;
  const phones = bag.map((t) => t.replace(/\D/g, '')).filter((d) => d.length >= 10 && d.length <= 15);
  return phones.some((p) => list.has(p)) ? null : 'fora da lista';
}
