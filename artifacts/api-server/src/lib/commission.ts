import { db, commissionConfigTable } from "@workspace/db";
import { toNum } from "./money";

export type Commission = { renterFeePct: number; ownerFeePct: number };

export async function getCommission(): Promise<Commission> {
  const [row] = await db
    .select()
    .from(commissionConfigTable)
    .limit(1);

  if (!row) {
    const [created] = await db
      .insert(commissionConfigTable)
      .values({ renterFeePct: "3", ownerFeePct: "5" })
      .returning();
    return {
      renterFeePct: toNum(created?.renterFeePct),
      ownerFeePct: toNum(created?.ownerFeePct),
    };
  }

  return {
    renterFeePct: toNum(row.renterFeePct),
    ownerFeePct: toNum(row.ownerFeePct),
  };
}
