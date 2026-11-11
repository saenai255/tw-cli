// Blacksmith farming preset: the early blacksmith products and the job that drops each best per energy on
// en32 (live work/index values, 2026-11-07). Item ids are bag base ids; job ids are stable game data. Wood
// is also dropped by Rafting wood (46, more XP) and Felling trees (27, less per energy); the preset picks the
// product rate, and the farm picker can add the others to a custom list.
export interface FarmProduct {
  name: string;
  itemId: number;
  jobId: number;
}

export const BLACKSMITH_PRODUCTS: readonly FarmProduct[] = [
  { name: 'Granite blocks', itemId: 716, jobId: 25 },
  { name: 'Hammer', itemId: 747, jobId: 23 },
  { name: 'Iron rod', itemId: 790, jobId: 85 },
  { name: 'Wood', itemId: 711, jobId: 55 },
  { name: 'Cotton', itemId: 704, jobId: 5 },
  { name: 'Wool', itemId: 707, jobId: 10 },
  { name: 'Leather', itemId: 712, jobId: 17 },
  { name: 'Coal', itemId: 721, jobId: 40 },
];

/** The preset jobs in round-robin order (the product order above). */
export const BLACKSMITH_JOBS: readonly number[] = BLACKSMITH_PRODUCTS.map((product) => product.jobId);

/** The preset product a job farms, for the plan reason and the picker. */
export function farmProduct(jobId: number): FarmProduct | undefined {
  return BLACKSMITH_PRODUCTS.find((product) => product.jobId === jobId);
}
