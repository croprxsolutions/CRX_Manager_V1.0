export type LabelField = 'rei_hours' | 'phi_days';

export interface LabelCorrectionRow {
  product_id: string;
  product_name: string;
  rei_hours: string;
  phi_days: string;
}

export interface ProductLabelValues {
  rei_hours: number | null;
  phi_days: number | null;
}

export interface LabelCorrection {
  rowIndex: number;
  product_name: string;
  field: LabelField;
  jobValue: string;
  productValue: number;
}

const LABEL_FIELDS: LabelField[] = ['rei_hours', 'phi_days'];

export function findLabelCorrections(
  rows: LabelCorrectionRow[],
  labelsById: Map<string, ProductLabelValues>,
): LabelCorrection[] {
  const corrections: LabelCorrection[] = [];

  rows.forEach((row, rowIndex) => {
    if (!row.product_id) return;
    const product = labelsById.get(row.product_id);
    if (!product) return;

    for (const field of LABEL_FIELDS) {
      const productValue = product[field];
      if (productValue === null || !Number.isFinite(productValue)) continue;
      const jobValue = row[field].trim();
      if (!jobValue) continue;
      if (jobValue !== String(productValue)) {
        corrections.push({ rowIndex, product_name: row.product_name, field, jobValue, productValue });
      }
    }
  });

  return corrections;
}

export function applyLabelCorrections<T extends LabelCorrectionRow>(
  rows: T[],
  corrections: LabelCorrection[],
): T[] {
  const next = [...rows];
  for (const { rowIndex, field, productValue } of corrections) {
    next[rowIndex] = { ...next[rowIndex], [field]: String(productValue) };
  }
  return next;
}
