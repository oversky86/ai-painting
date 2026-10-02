import type { BusinessStatus } from "./business-status.server";
import type {
  ModificationRequestWithNotes,
  PortraitVersionRow,
} from "./supplier-store.server";

/**
 * Valid history is v1, r1, v2, r2, v3 (rN = request against vN). The order's
 * status says whether the history ends on a version or on a request; anything
 * past that end is left over from a rolled-back transition and is ignored.
 */
export type PortraitProgress = {
  versions: PortraitVersionRow[];
  requests: ModificationRequestWithNotes[];
  /** Latest valid version number (0 before the first upload). */
  versionCount: number;
  modificationCount: number;
  /** Version number the supplier uploads next. */
  nextVersion: number;
  staleVersionIds: string[];
  staleRequestIds: string[];
};

const AWAITING_UPLOAD = new Set<BusinessStatus>(["order_placed", "supplier_modification"]);

function latestPerVersion(requests: ModificationRequestWithNotes[]) {
  const byVersion = new Map<number, ModificationRequestWithNotes>();
  for (const request of requests) {
    const existing = byVersion.get(request.against_version);
    if (!existing || existing.created_at <= request.created_at) {
      byVersion.set(request.against_version, request);
    }
  }
  return [...byVersion.values()].sort((a, b) => a.against_version - b.against_version);
}

export function resolvePortraitProgress(
  status: BusinessStatus,
  versions: PortraitVersionRow[],
  requests: ModificationRequestWithNotes[],
): PortraitProgress {
  const sortedVersions = [...versions].sort((a, b) => a.version_number - b.version_number);
  const deduped = latestPerVersion(requests);

  let validVersions: PortraitVersionRow[];
  let validRequests: ModificationRequestWithNotes[];
  if (AWAITING_UPLOAD.has(status)) {
    validRequests = deduped;
    validVersions = sortedVersions.filter((v) => v.version_number <= validRequests.length);
  } else {
    validVersions = sortedVersions;
    const latest = validVersions[validVersions.length - 1]?.version_number || 0;
    validRequests = deduped.filter((r) => r.against_version < latest);
  }

  const validVersionIds = new Set(validVersions.map((v) => v.id));
  const validRequestIds = new Set(validRequests.map((r) => r.id));
  const versionCount = validVersions[validVersions.length - 1]?.version_number || 0;

  return {
    versions: validVersions,
    requests: validRequests,
    versionCount,
    modificationCount: validRequests.length,
    nextVersion: AWAITING_UPLOAD.has(status) ? validRequests.length + 1 : versionCount + 1,
    staleVersionIds: sortedVersions.filter((v) => !validVersionIds.has(v.id)).map((v) => v.id),
    staleRequestIds: requests.filter((r) => !validRequestIds.has(r.id)).map((r) => r.id),
  };
}
