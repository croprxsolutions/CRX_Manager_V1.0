// The order page's toast after the sales tax box changes (set_order_sales_tax's answer).
// Split drafts the save path can't edit keep their tax until the group is voided and redrafted (drafts_kept).
export function salesTaxToast(
  on: boolean,
  draftsUpdated: number,
  draftsKept: number,
  hasPosted: boolean,
): ['success' | 'info', string] {
  const state = `Sales tax ${on ? 'on' : 'off'}`;
  const updated = `${draftsUpdated} draft invoice${draftsUpdated === 1 ? '' : 's'} updated`;
  if (draftsKept) {
    const one = draftsKept === 1;
    return ['info', `${state}${draftsUpdated ? ` (${updated})` : ''}. ${draftsKept} split draft${one ? '' : 's'} can't be edited and keep${one ? 's' : ''} ${one ? 'its' : 'their'} tax until the group is voided and redrafted.`];
  }
  if (draftsUpdated) return ['success', `${state} (${updated})`];
  return ['info', `${state}. New invoices for this sale will${on ? '' : ' not'} be taxed${hasPosted ? '; posted invoices keep their tax' : ''}.`];
}
