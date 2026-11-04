import { supabase } from './db';
import { Sentry } from './sentry';
import { toastOutsideReact } from '../components/ui/Toast';
import { DEFAULT_COMPANY_INFO, loadCompanyInfo, type CompanyInfo } from './companyInfo';

export const COMPANY_INFO_FALLBACK_MESSAGE =
  "Couldn't load your Settings company details, so this PDF uses the built-in name, address and phone. Check it before sending.";

/**
 * The Settings company details for a PDF drawn in the browser. A failed read prints
 * the companyInfo.ts defaults rather than blocking the print, with a warning toast so the
 * user checks it before sending; send-email refuses instead.
 */
export async function loadCompanyInfoForPdf(): Promise<CompanyInfo> {
  try {
    return await loadCompanyInfo(supabase);
  } catch (err) {
    Sentry.captureException(err, { tags: { source: 'read', action: 'company_info_pdf' } });
    toastOutsideReact('warning', COMPANY_INFO_FALLBACK_MESSAGE);
    return DEFAULT_COMPANY_INFO;
  }
}
