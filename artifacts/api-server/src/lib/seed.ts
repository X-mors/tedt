import { sql } from "drizzle-orm";
import {
  db,
  algorithmsTable,
  commissionConfigTable,
  usersTable,
  rigsTable,
} from "@workspace/db";
import { logger } from "./logger";

/**
 * Idempotent first-boot database seeding.
 * Inserts default algorithms, commission config, and demo rigs when the
 * tables are empty. Safe to call on every server start.
 */
export async function seedDatabase(): Promise<void> {
  const [algoCount] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(algorithmsTable);

  if (Number(algoCount?.c ?? 0) === 0) {
    logger.info("Seeding default algorithms");
    await db.insert(algorithmsTable).values([
      { name: "SHA-256", slug: "sha256", unit: "TH/s", basePricePerUnitPerHour: "0.012" },
      { name: "Scrypt", slug: "scrypt", unit: "GH/s", basePricePerUnitPerHour: "0.0008" },
      { name: "Ethash", slug: "ethash", unit: "MH/s", basePricePerUnitPerHour: "0.00018" },
      { name: "RandomX", slug: "randomx", unit: "kH/s", basePricePerUnitPerHour: "0.00045" },
      { name: "kHeavyHash", slug: "kheavyhash", unit: "GH/s", basePricePerUnitPerHour: "0.0011" },
    ]);
  }

  const [commCount] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(commissionConfigTable);

  if (Number(commCount?.c ?? 0) === 0) {
    logger.info("Seeding default commission config (3% renter / 5% owner)");
    await db.insert(commissionConfigTable).values({
      renterFeePct: "3",
      ownerFeePct: "5",
    });
  }

  const [userCount] = await db
    .select({ c: sql<string>`COUNT(*)` })
    .from(usersTable);

  if (Number(userCount?.c ?? 0) === 0) {
    logger.info("Seeding demo users and rigs");

    const [owner1, owner2] = await db
      .insert(usersTable)
      .values([
        {
          clerkUserId: "seed_owner_alpha",
          email: "alpha@rigmarket.demo",
          displayName: "Alpha Hashworks",
          role: "owner",
          balanceUsd: "0",
        },
        {
          clerkUserId: "seed_owner_beta",
          email: "beta@rigmarket.demo",
          displayName: "Beta Compute Co",
          role: "owner",
          balanceUsd: "0",
        },
      ])
      .returning({ id: usersTable.id });

    const algos = await db.select().from(algorithmsTable);
    const sha = algos.find((a) => a.slug === "sha256");
    const scrypt = algos.find((a) => a.slug === "scrypt");
    const ethash = algos.find((a) => a.slug === "ethash");
    const randomx = algos.find((a) => a.slug === "randomx");
    const kheavy = algos.find((a) => a.slug === "kheavyhash");

    if (owner1 && owner2 && sha && scrypt && ethash && randomx) {
      await db.insert(rigsTable).values([
        {
          ownerId: owner1.id,
          algorithmId: sha.id,
          name: "Antminer S21 Cluster",
          description: "Datacenter-grade S21 farm. Immersion-cooled, 99.4% uptime past quarter.",
          hashrate: "200",
          minRentalHours: 1,
          maxRentalHours: 168,
          region: "US-East",
          status: "available",
          approvalStatus: "approved",
          stratumHost: "owner-pool.example.com",
          stratumPort: 3333,
          stratumUser: "alpha.rig01",
          stratumPassword: "x",
        },
        {
          ownerId: owner1.id,
          algorithmId: ethash.id,
          name: "RTX 4090 Stack",
          description: "16x RTX 4090 cards on a custom rack. Perfect for short Ethash bursts.",
          hashrate: "2080",
          minRentalHours: 1,
          maxRentalHours: 72,
          region: "EU-West",
          status: "available",
          approvalStatus: "approved",
          stratumHost: "owner-pool.example.com",
          stratumPort: 3334,
          stratumUser: "alpha.rig02",
          stratumPassword: "x",
        },
        {
          ownerId: owner2.id,
          algorithmId: scrypt.id,
          name: "Goldshell Scrypt Bank",
          description: "8x Goldshell LT6 units in parallel. Stable Scrypt power, instant boot.",
          hashrate: "29",
          minRentalHours: 1,
          maxRentalHours: 168,
          region: "Asia-East",
          status: "available",
          approvalStatus: "approved",
          stratumHost: "owner-pool.example.com",
          stratumPort: 3335,
          stratumUser: "beta.rig01",
          stratumPassword: "x",
        },
        {
          ownerId: owner2.id,
          algorithmId: randomx.id,
          name: "EPYC RandomX Pod",
          description: "Dual EPYC 9654 server tuned for RandomX. Quiet, cool, consistent.",
          hashrate: "320",
          minRentalHours: 1,
          maxRentalHours: 168,
          region: "US-West",
          status: "available",
          approvalStatus: "approved",
          stratumHost: "owner-pool.example.com",
          stratumPort: 3336,
          stratumUser: "beta.rig02",
          stratumPassword: "x",
        },
        ...(kheavy
          ? [
              {
                ownerId: owner1.id,
                algorithmId: kheavy.id,
                name: "Kaspa Heatwave 12",
                description: "12-unit IceRiver KS5L pod. Fast warmup, reliable Kaspa hashpower.",
                hashrate: "144",
                minRentalHours: 1,
                maxRentalHours: 168,
                region: "US-East",
                status: "available" as const,
                approvalStatus: "approved" as const,
                stratumHost: "owner-pool.example.com",
                stratumPort: 3337,
                stratumUser: "alpha.rig03",
                stratumPassword: "x",
              },
            ]
          : []),
      ]);
    }
  }
}
