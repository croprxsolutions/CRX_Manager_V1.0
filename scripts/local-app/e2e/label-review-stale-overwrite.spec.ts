import { expect, test } from '@playwright/test';

// A product page left open must not save its old label values over a newer Label Review commit.
test('saving an open product page keeps a newer Label Review commit', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  const db = async <T>(fn: string, arg: unknown): Promise<T> => page.evaluate(async ({ fn, arg }) => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const steps: Record<string, (a: never) => Promise<unknown>> = {
      insert: async (name: string) => {
        const { data, error } = await supabase.from('products').insert({
          product_name: name, category: 'Herbicide', use_timings: [], epa_registration: '100-1',
          signal_word: 'Caution', rei_hours: 12, phi_days: 30, max_label_rate: 16, max_label_rate_unit: 'fl oz/acre',
        }).select('id').single();
        if (error || !data) throw new Error(error?.message ?? 'Product insert returned no row');
        return data.id;
      },
      // The same two calls Label Review makes: draft the new label values, then commit them.
      labelReview: async (id: string) => {
        const draft = await supabase.rpc('create_label_draft', {
          p_product_id: id, p_signal_word: 'Warning', p_rei_hours: 24, p_phi_days: 45, p_epa_registration: '100-2',
          p_max_label_rate: 32, p_max_label_rate_unit: 'fl oz/acre', p_source_note: 'invented label',
        });
        if (draft.error) throw new Error(draft.error.message);
        const commit = await supabase.rpc('commit_label_draft', {
          p_draft_id: draft.data, p_decision: 'accepted', p_force_overwrite: true,
        });
        if (commit.error) throw new Error(commit.error.message);
        return commit.data;
      },
      read: async (id: string) => {
        const { data, error } = await supabase.from('products')
          .select('signal_word, rei_hours, phi_days, epa_registration, max_label_rate, max_label_rate_unit, use_timings')
          .eq('id', id).single();
        if (error) throw new Error(error.message);
        return data;
      },
    };
    return steps[fn](arg as never);
  }, { fn, arg }) as Promise<T>;

  const id = await db<string>('insert', `Label stale ${Date.now()} (invented)`);
  await page.goto(`/products/${id}`);
  await expect(page.getByTestId('product-max-label-rate')).toHaveText('16 fl oz/acre');

  // An admin commits new label values in Label Review while this page is still open.
  await db('labelReview', id);

  await page.getByRole('group', { name: 'Use Timing' }).getByRole('checkbox', { name: 'Pre-Emerge Corn' }).check();
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect(page.getByText(/product updated/i).first()).toBeVisible();

  expect(await db('read', id)).toEqual({
    signal_word: 'Warning', rei_hours: 24, phi_days: 45, epa_registration: '100-2',
    max_label_rate: 32, max_label_rate_unit: 'fl oz/acre', use_timings: ['pre_emerge_corn'],
  });
  await page.reload();
  await expect(page.getByTestId('product-max-label-rate')).toHaveText('32 fl oz/acre');
});
