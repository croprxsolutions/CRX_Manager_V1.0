// The order page's toast after the sales tax box changes (set_order_sales_tax's answer).
// Split drafts the save path can't edit keep their tax, and can't post while that differs from the box (20270124140000) (drafts_kept).
export function salesTaxToast(
  on: boolean,
  draftsUpdated: number,
  draftsKept: string[],
  hasPosted: boolean,
): ['success' | 'info', string] {
  const state = `Sales tax ${on ? 'on' : 'off'}`;
  const updated = `${draftsUpdated} draft invoice${draftsUpdated === 1 ? '' : 's'} updated`;
  if (draftsKept.length) {
    const one = draftsKept.length === 1;
    return ['info', `${state}${draftsUpdated ? ` (${updated})` : ''}. Split draft${one ? '' : 's'} ${draftsKept.join(', ')} can't be edited, so ${one ? 'it keeps its' : 'they keep their'} tax and can't be posted while that differs from the box: void and redraft the group, or set the box back.`];
  }
  if (draftsUpdated) return ['success', `${state} (${updated})`];
  return ['info', `${state}. New invoices for this sale will${on ? '' : ' not'} be taxed${hasPosted ? '; posted invoices keep their tax' : ''}.`];
}
