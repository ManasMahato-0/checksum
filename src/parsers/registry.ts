import type { StatementParser } from '../domain/types';
import { hdfcParser } from './hdfc';
import { sbiParser } from './sbi';

/** Add ICICI / Axis parsers here. Each implements the same interface. */
const parsers: StatementParser[] = [hdfcParser, sbiParser];

export function detectParser(content: string): StatementParser | null {
  return parsers.find((p) => p.detect(content)) ?? null;
}
