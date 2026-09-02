import {
  withOpenClawStateLease,
  type OpenClawStateLeaseContext,
} from "../../state/openclaw-state-lease.js";
import { withSkillCollectionReviewClaim } from "./collection-review-state.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import type { SkillProposalRecord } from "./types.js";

const TARGET_LEASE_MS = 60_000;
const TARGET_LEASE_WAIT_MS = 5_000;

/** The global collection lock aliases the review lease so every tree writer shares one owner. */
export async function withSkillCollectionLock<T>(
  fn: (lease: OpenClawStateLeaseContext) => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  ensureSkillWorkshopSchema(options);
  return await withSkillCollectionReviewClaim(fn, databaseOptions(options));
}

export async function withSkillProposalTargetLock<T>(
  record: SkillProposalRecord,
  fn: () => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  ensureSkillWorkshopSchema(options);
  return await withOpenClawStateLease(
    {
      scope: "skill-workshop-target",
      key: hashSkillProposalContent(record.target.skillFile),
      database: { scope: "shared", options: databaseOptions(options) },
      leaseMs: TARGET_LEASE_MS,
      waitMs: TARGET_LEASE_WAIT_MS,
      leaseLabel: "Skill Workshop target lease",
      operationLabel: "skill-workshop.target-lease",
    },
    async () => await fn(),
  );
}

export async function withSkillProposalCommitLock<T>(
  record: SkillProposalRecord,
  fn: () => Promise<T>,
  options: SkillWorkshopStoreOptions = {},
): Promise<T> {
  ensureSkillWorkshopSchema(options);
  return await withSkillCollectionLock(
    async () => await withSkillProposalTargetLock(record, fn, options),
    options,
  );
}
