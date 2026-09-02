import { SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX } from "./skill-collection-review-monitor.js";

/** Declaration-key namespaces reserved for jobs the gateway converges itself. */
const SYSTEM_OWNED_DECLARATION_PREFIXES = [SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX];

export function systemOwnedDeclarationKeyNamespace(
  declarationKey: string | undefined,
): string | undefined {
  return SYSTEM_OWNED_DECLARATION_PREFIXES.find((prefix) => declarationKey?.startsWith(prefix));
}
