import { expect, it } from 'vitest';

it('deliberately fails to prove a failed shard turns the required check red', () => {
  expect(1).toBe(2);
});
