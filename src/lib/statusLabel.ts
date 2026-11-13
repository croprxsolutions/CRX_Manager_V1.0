/** A database status as a title-case pill label: "partially_fulfilled" -> "Partially Fulfilled". */
export const statusLabel = (s: string) => s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
