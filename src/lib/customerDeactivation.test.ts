import { describe, expect, it } from 'vitest';
import { sanitizeError } from './errorSanitizer';
import { namesCutFarm } from './customerDeactivation';

// #2114: the database cuts a farm name over 60 characters to its first 59 and "…".
const start = 'Riverside Agricultural Holdings Partnership of the Lower Val';
const refusal = (name: string) => sanitizeError(new Error(
  `CUSTOMER_HAS_OPEN_WORK: nothing was deactivated. ${name} still has 1 open order(s). Finish or cancel that work, bill it, credit its returns and use up or refund its prepay first`));

describe('namesCutFarm', () => {
  it('names every selected farm sharing the cut name', () => {
    const a = `${start}ley North`, b = `${start}ley South`;
    expect(start).toHaveLength(60);
    const message = refusal(`${a.slice(0, 59)}…`);
    expect(namesCutFarm(message, [{ farm_name: a }, { farm_name: b }, { farm_name: 'Other Farm' }]))
      .toBe(`${message} Selected farms starting with that name: ${a}; ${b}.`);
  });

  it('leaves the message alone when the name is not cut or only one farm matches', () => {
    const short = refusal('Short Farm');
    expect(namesCutFarm(short, [{ farm_name: 'Short Farm' }, { farm_name: 'Short Farm 2' }])).toBe(short);
    const a = `${start}ley North`;
    const cut = refusal(`${a.slice(0, 59)}…`);
    expect(namesCutFarm(cut, [{ farm_name: a }, { farm_name: 'Other Farm' }])).toBe(cut);
  });
});

describe('namesCutFarm counts characters as the database does', () => {
  it('matches a cut name holding an emoji (one character, two UTF-16 units)', () => {
    const emojiStart = `🌽${start.slice(1)}`;
    const a = `${emojiStart}ley North`, b = `${emojiStart}ley South`;
    const message = refusal(`${[...a].slice(0, 59).join('')}…`);
    expect(namesCutFarm(message, [{ farm_name: a }, { farm_name: b }]))
      .toBe(`${message} Selected farms starting with that name: ${a}; ${b}.`);
  });
});
