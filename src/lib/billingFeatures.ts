import { appEnv, type AppEnv } from './appEnv';

/**
 * Sales tax (M4a, with the tax rep fix) and standing discounts (M4b) ship switched off on live until commission
 * ships (Mason, 16 Nov). Their controls show on staging and local only. Turn them on everywhere with commission by
 * returning true here, and with a migration that sets billing_m4_switch.enabled = true: the database refuses ticking
 * tax or a discount above 0 while it is off (20270117140000), whatever calls it.
 */
export function billingM4Enabled(env: AppEnv = appEnv()): boolean {
  return env !== 'production';
}
