import { db, commissionConfigTable } from "@workspace/db";
import { toNum } from "./money";

export type Commission = {
  renterFeePct: number;
  ownerFeePct: number;
  cancellationFeePct: number;
  deliveryThresholdPct: number;
  rigOfflineTerminateMins: number;
};

export async function getCommission(): Promise<Commission> {
  const [row] = await db
    .select()
    .from(commissionConfigTable)
    .limit(1);

  if (!row) {
    const [created] = await db
      .insert(commissionConfigTable)
      .values({
        renterFeePct: "3",
        ownerFeePct: "5",
        cancellationFeePct: "0",
        deliveryThresholdPct: "95",
        rigOfflineTerminateMins: 30,
      })
      .returning();
    return {
      renterFeePct: toNum(created?.renterFeePct),
      ownerFeePct: toNum(created?.ownerFeePct),
      cancellationFeePct: toNum(created?.cancellationFeePct),
      deliveryThresholdPct: toNum(created?.deliveryThresholdPct),
      rigOfflineTerminateMins: created?.rigOfflineTerminateMins ?? 30,
    };
  }

  return {
    renterFeePct: toNum(row.renterFeePct),
    ownerFeePct: toNum(row.ownerFeePct),
    cancellationFeePct: toNum(row.cancellationFeePct),
    deliveryThresholdPct: toNum(row.deliveryThresholdPct),
    rigOfflineTerminateMins: row.rigOfflineTerminateMins ?? 30,
  };
}
