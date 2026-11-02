import { expect, test } from '@playwright/test';

test('a saved signal word change shows the signed-in staff member after reload', async ({ page }) => {
  await page.goto('/login');
  await page.fill('#email', process.env.LOCAL_TEST_EMAIL!);
  await page.fill('#password', process.env.LOCAL_TEST_PASSWORD!);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).not.toHaveURL(/login/);

  const { id, name } = await page.evaluate(async (productName) => {
    const { supabase } = await import(/* @vite-ignore */ '/src/lib/db.ts');
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError || !auth.user) throw new Error('Local test sign-in failed');
    const { data: profile, error: profileError } = await supabase.from('profile_public_view')
      .select('full_name').eq('id', auth.user.id).single();
    if (profileError || !profile?.full_name) throw new Error('Local test profile name missing');
    const { data: product, error } = await supabase.from('products')
      .insert({ product_name: productName, product_form: 'liquid', signal_word: 'Caution' })
      .select('id').single();
    if (error || !product) throw new Error(error?.message ?? 'Local test product insert failed');
    return { id: product.id, name: profile.full_name };
  }, `History ${Date.now()} (invented)`);

  await page.goto(`/products/${id}`);
  const signalWord = page.locator('label').filter({ hasText: 'Signal Word' }).first().locator('..').locator('select');
  await expect(signalWord).toHaveValue('Caution');
  await signalWord.selectOption('Warning');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Product updated')).toBeVisible();
  const history = page.getByRole('list', { name: 'Product changes, newest first' });
  await expect(history.locator('p').filter({ hasText: 'Signal word: Caution → Warning' })).toBeVisible();
  await expect(history.getByText(name).first()).toBeVisible();
  await page.reload();
  await expect(history.locator('p').filter({ hasText: 'Signal word: Caution → Warning' })).toBeVisible();
  await expect(history.getByText(name).first()).toBeVisible();
});
