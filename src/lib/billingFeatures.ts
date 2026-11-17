import { appEnv, type AppEnv } from './appEnv';

/**
 * Sales tax (M4a, with the tax rep fix) and standing discounts (M4b) ship switched off on live until commission
 * ships (Mason, 16 Nov). Their controls show on staging and local only. Turn them on everywhere with commission by
 * returning true here.
 */
export function billingM4Enabled(env: AppEnv = appEnv()): boolean {
  return env !== 'production';
}
