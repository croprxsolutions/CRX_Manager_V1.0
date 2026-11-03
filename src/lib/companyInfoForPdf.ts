import { supabase } from './db';
import { Sentry } from './sentry';
import { DEFAULT_COMPANY_INFO, loadCompanyInfo, type CompanyInfo } from './companyInfo';

/**
 * The Settings company details for a PDF drawn in the browser. A failed read prints
 * the companyInfo.ts defaults rather than blocking the print; send-email refuses instead.
 */
export async function loadCompanyInfoForPdf(): Promise<CompanyInfo> {
  try {
    return await loadCompanyInfo(supabase);
  } catch (err) {
    Sentry.captureException(err, { tags: { source: 'read', action: 'company_info_pdf' } });
    return DEFAULT_COMPANY_INFO;
  }
}
