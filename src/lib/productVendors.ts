import { assertRpcResult, hasRpcCode, RpcErrorCodes, supabase } from './db';
import { sanitizeError } from './errorSanitizer';
import type { ProductVendor } from '../types';

/** The product's vendors, preferred first; cost fields are null unless the caller is an admin. */
export async function listProductVendors(productId: string): Promise<ProductVendor[]> {
  const { data, error } = await supabase.rpc('get_product_vendors', { p_product_id: productId });
  if (error) throw error;
  const vendors = assertRpcResult<ProductVendor[]>(data, 'get_product_vendors');
  if (!Array.isArray(vendors)) throw new Error('get_product_vendors returned an unexpected result');
  return vendors;
}

/** Links a vendor to the product (vendor only, item details not yet known) and, if asked, makes it preferred. */
export async function linkProductVendor(
  productId: string, vendorId: string, makePreferred: boolean, performedBy: string, idempotencyKey: string,
): Promise<void> {
  const { data, error } = await supabase.rpc('link_product_vendor', {
    p_product_id: productId,
    p_vendor_id: vendorId,
    p_make_preferred: makePreferred,
    p_performed_by: performedBy,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  assertRpcResult(data, 'link_product_vendor');
}

/** Removes a non-preferred vendor from the product. */
export async function unlinkProductVendor(linkId: string, performedBy: string, idempotencyKey: string): Promise<void> {
  const { data, error } = await supabase.rpc('unlink_product_vendor', {
    p_link_id: linkId,
    p_performed_by: performedBy,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  assertRpcResult(data, 'unlink_product_vendor');
}

/** Plain-English message for a failed vendor change. */
export function productVendorErrorMessage(error: unknown): string {
  if (hasRpcCode(error, RpcErrorCodes.PREFERRED_VENDOR_REQUIRED)) {
    return 'This is the preferred vendor. Make another vendor preferred first, then remove this one.';
  }
  if (hasRpcCode(error, RpcErrorCodes.PRODUCT_VENDOR_FOLLOWS_PREFERRED_VENDOR)) {
    return 'The vendor comes from the preferred vendor. Change it in the Vendors section of the product page.';
  }
  if (hasRpcCode(error, RpcErrorCodes.VENDOR_IS_PREFERRED)) {
    return 'Products still use this vendor as their preferred vendor. Choose another preferred vendor for them first.';
  }
  if (hasRpcCode(error, RpcErrorCodes.ADMIN_REQUIRED)) return 'Only an admin can change a product’s vendors.';
  if (hasRpcCode(error, RpcErrorCodes.SUPPLIER_LINK_NOT_FOUND) || hasRpcCode(error, RpcErrorCodes.VENDOR_NOT_FOUND)
    || hasRpcCode(error, RpcErrorCodes.PRODUCT_NOT_FOUND)) {
    return 'This vendor or product no longer exists. Reload the page.';
  }
  if (hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_INTENT_MISMATCH) || hasRpcCode(error, RpcErrorCodes.IDEMPOTENCY_PAYLOAD_MISMATCH)) {
    return 'This change conflicts with an earlier attempt. Reload the page and try again.';
  }
  return sanitizeError(error);
}
