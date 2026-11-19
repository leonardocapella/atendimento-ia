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
