import { assertRpcResult, hasRpcCode, RpcErrorCodes, supabaseUntyped } from './db';
import { sanitizeError } from './errorSanitizer';
import type { BrandSignalWord, ProductBrand } from '../types';

/**
 * Same shapes the database and the EPA lookup accept: a Section 3 number (524-475) or a distributor
 * number (100-1234-5905), each part non-zero-led and at most 6, 5 and 6 digits.
 */
export const EPA_REGISTRATION_PATTERN = /^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$/;

export function epaLabelSearchUrl(epaRegistration: string | null | undefined): string | null {
  const registration = epaRegistration?.trim();
  if (!registration || !EPA_REGISTRATION_PATTERN.test(registration)) return null;

  // EPA holds labels under the basic registration; a three-part number opens an empty page (checked 2026-11-01 against EPA's site).
  const [companyNumber, productNumber] = registration.split('-');
  return `https://ordspub.epa.gov/ords/pesticides/f?p=PPLS:102:::NO::P102_REG_NUM:${companyNumber}-${productNumber}`;
}

export interface ProductBrandInput {
  productId: string;
  /** Set when the size is grouped: the brand is saved on the parent's list instead. */
  parentId?: string | null;
  /** Omit to add a new brand. */
  brandId?: string;
  /** The row_version the editor read; required when brandId is set. */
  expectedRowVersion?: number;
  brandName: string;
  epaRegistration: string;
  manufacturer: string;
  isCurrentlySourced: boolean;
  isRup: boolean | null;
  signalWord: BrandSignalWord | null;
}

/** A product's brand list: its parent's list once the size is grouped (PAR-2), otherwise its own. */
export interface ProductBrandList {
  parentId: string | null;
  parentName: string | null;
  brands: ProductBrand[];
}

interface ProductBrandsReply {
  source: 'product' | 'parent';
  parent_id: string | null;
  parent_name: string | null;
  brands: (Omit<ProductBrand, 'product_id'> & { product_id?: string })[];
}

export async function getProductBrands(productId: string): Promise<ProductBrandList> {
  // Untyped client: get_product_brands (20261123120000) is not in the generated types yet.
  const { data, error } = await supabaseUntyped.rpc('get_product_brands', { p_product_id: productId });
  if (error) throw error;
  const reply = assertRpcResult<ProductBrandsReply>(data, 'get_product_brands');
  return {
    parentId: reply.source === 'parent' ? reply.parent_id : null,
    parentName: reply.source === 'parent' ? reply.parent_name : null,
    // A parent's brand rows carry parent_id, not product_id; the screen shows them on this size.
    brands: (reply.brands ?? []).map((brand) => ({ ...brand, product_id: productId })),
  };
}

export async function listProductBrands(productId: string): Promise<ProductBrand[]> {
  return (await getProductBrands(productId)).brands;
}

export async function saveProductBrand(input: ProductBrandInput, idempotencyKey: string): Promise<ProductBrand> {
  const fields = {
    p_brand_id: input.brandId ?? null,
    p_expected_row_version: input.expectedRowVersion ?? null,
    p_brand_name: input.brandName.trim(),
    p_epa_registration: input.epaRegistration.trim() || null,
    p_manufacturer: input.manufacturer.trim() || null,
    p_is_currently_sourced: input.isCurrentlySourced,
    p_is_rup: input.isRup,
    p_signal_word: input.signalWord,
    p_idempotency_key: idempotencyKey,
  };
  // A size moved to another parent since the screen loaded must not edit its old parent's brands.
  // upsert_parent_brand refuses that in SQL (p_product_id must still be a member); this early re-read
  // also catches a size that left or joined a parent, which would otherwise hit the wrong RPC.
  const current = await getProductBrands(input.productId);
  if (current.parentId !== (input.parentId ?? null)) {
    throw new Error(`${RpcErrorCodes.PRODUCT_BRANDS_PARENT_CHANGED}: this size's brand list moved since it loaded`);
  }
  if (input.parentId) {
    const { data, error } = await supabaseUntyped.rpc('upsert_parent_brand', {
      p_parent_id: input.parentId,
      p_product_id: input.productId,
      ...fields,
    });
    if (error) throw error;
    return { ...assertRpcResult<ProductBrand>(data, 'upsert_parent_brand'), product_id: input.productId };
  }
  // Untyped client: the generated Args type marks the nullable parameters non-null.
  const { data, error } = await supabaseUntyped.rpc('upsert_product_brand', { p_product_id: input.productId, ...fields });
  if (error) throw error;
  return assertRpcResult<ProductBrand>(data, 'upsert_product_brand');
}

/** Plain-English message for a failed brand save. */
export function productBrandErrorMessage(error: unknown): string {
  if (hasRpcCode(error, RpcErrorCodes.BRAND_NAME_TAKEN)) return 'This product already lists a brand with that name.';
  if (hasRpcCode(error, RpcErrorCodes.BRAND_CHANGED)) return 'Someone else changed this brand. The list has been reloaded; open it again to edit.';
  if (hasRpcCode(error, RpcErrorCodes.EPA_REGISTRATION_INVALID)) return 'That is not an EPA registration number (like 524-475 or 100-1234-5905).';
  if (hasRpcCode(error, RpcErrorCodes.BRAND_NAME_REQUIRED)) return 'Enter the brand name.';
  if (hasRpcCode(error, RpcErrorCodes.BRAND_TEXT_TOO_LONG)) return 'Brand and manufacturer names are limited to 200 characters.';
  if (hasRpcCode(error, RpcErrorCodes.BRAND_NOT_FOUND) || hasRpcCode(error, RpcErrorCodes.PRODUCT_NOT_FOUND)) {
    return 'This brand or product no longer exists. Reload the page.';
  }
  if (hasRpcCode(error, RpcErrorCodes.PRODUCT_BRANDS_PARENT_CHANGED) || hasRpcCode(error, RpcErrorCodes.PRODUCT_BRANDS_BELONG_TO_PARENT)) {
    return 'This size joined or moved to a different parent since the page loaded, so nothing was saved. The list has been reloaded; open it again to edit.';
  }
  if (hasRpcCode(error, RpcErrorCodes.PRODUCT_PARENT_GROUPING_NOT_OPEN)) {
    return 'Shared parent brands can be changed once grouping is switched on. Nothing was saved.';
  }
  if (hasRpcCode(error, RpcErrorCodes.NOT_AUTHORIZED)) return 'Only an admin can change a product’s brands.';
  if (hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_INTENT_MISMATCH)) {
    return 'This save conflicts with an earlier attempt. Close the form, reload the page and try again.';
  }
  return sanitizeError(error);
}

/**
 * Brand names written inside a product's name, e.g. "Roundup 5.4# Generic (Ag Saver 5.4, Slam 5.4) - 2.5 Gal"
 * → ["Ag Saver 5.4", "Slam 5.4"]. Only suggestions: some parentheses hold notes, not brands, so an admin
 * confirms each one (and types its EPA number) before it is saved. Names already listed are left out.
 */
export function suggestBrandNamesFromProductName(productName: string, existingNames: string[] = []): string[] {
  const taken = new Set(existingNames.map((name) => name.trim().toLowerCase()));
  const suggestions: string[] = [];
  for (const match of productName.matchAll(/\(([^()]*)\)/g)) {
    for (const part of match[1].split(/,|\//)) {
      const name = part.trim();
      const key = name.toLowerCase();
      if (name && !taken.has(key)) {
        taken.add(key);
        suggestions.push(name);
      }
    }
  }
  return suggestions;
}
