import type { URI } from '@fctp/protocol';

export type AdmissionMode = 'allowlist' | 'denylist';

export interface AdmissionList {
  mode: AdmissionMode;
  allowlist: URI[];
  denylist: URI[];
}

export interface AdmissionPolicy {
  trustedRegistry: AdmissionList;
  acceptedRegistry: AdmissionList;
  acceptedTerritory: AdmissionList;
  vesselBuildingRegistry: AdmissionList;
}

export const DEFAULT_ADMISSION: AdmissionPolicy = {
  trustedRegistry: { mode: 'allowlist', allowlist: [], denylist: [] },
  acceptedRegistry: { mode: 'denylist', allowlist: [], denylist: [] },
  acceptedTerritory: { mode: 'allowlist', allowlist: [], denylist: [] },
  vesselBuildingRegistry: { mode: 'allowlist', allowlist: [], denylist: [] }
};

export const ADMISSION_FIELDS = ['trustedRegistry', 'acceptedRegistry', 'acceptedTerritory', 'vesselBuildingRegistry'] as const;

export function isAdmissionList(value: unknown): value is AdmissionList {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (item.mode !== 'allowlist' && item.mode !== 'denylist') return false;
  return [item.allowlist, item.denylist].every((entries) => Array.isArray(entries) &&
    entries.every((entry) => typeof entry === 'string' && URL.canParse(entry)));
}

export function admissionPermits(list: AdmissionList, value: URI): boolean {
  return list.mode === 'allowlist' ? list.allowlist.includes(value) : !list.denylist.includes(value);
}

export function entryAdmissionAllows(policy: AdmissionPolicy, registry: URI, evidenceTerritory?: URI): { allowed: boolean; reason?: string } {
  if (evidenceTerritory === undefined) {
    return admissionPermits(policy.trustedRegistry, registry)
      ? { allowed: true }
      : { allowed: false, reason: 'trusted-registry-not-accepted' };
  }
  if (!admissionPermits(policy.acceptedRegistry, registry)) return { allowed: false, reason: 'accepted-registry-not-accepted' };
  if (!admissionPermits(policy.acceptedTerritory, evidenceTerritory)) return { allowed: false, reason: 'accepted-territory-not-accepted' };
  return { allowed: true };
}
