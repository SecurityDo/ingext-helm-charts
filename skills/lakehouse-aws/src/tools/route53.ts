import { run } from "./shell";

export async function listHostedZones() {
  const result = await run("aws", ["route53", "list-hosted-zones", "--output", "json"]);
  if (!result.ok) {
    return { ok: false, error: result.stderr };
  }
  try {
    return { ok: true, data: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: "Failed to parse Route53 response" };
  }
}

/**
 * Check if the user controls a domain via Route53
 */
export async function findHostedZoneForDomain(domain: string) {
  const result = await listHostedZones();
  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const zones = result.data?.HostedZones || [];
  
  // Look for exact match or parent domain
  // e.g., for "ingext.io", look for "ingext.io." (Route53 adds trailing dot)
  const normalizedDomain = domain.endsWith(".") ? domain : `${domain}.`;
  
  for (const zone of zones) {
    const zoneName = zone.Name || "";
    if (zoneName === normalizedDomain) {
      return {
        ok: true,
        zoneId: zone.Id,
        zoneName: zone.Name,
        isPrivate: zone.Config?.PrivateZone || false,
      };
    }
  }

  return { ok: true, zoneId: null, zoneName: null, isPrivate: false };
}
