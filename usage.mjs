const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const text = (value) => typeof value === "string" ? value.trim() : ""

/** Map the vendor's individual buckets without inferring shared quota pools. */
export function quotaUsage(summary, { metadata = {} } = {}) {
  if (!isObject(summary) || !Array.isArray(summary.groups)) {
    throw new Error("The enterprise quota API returned an invalid groups list")
  }
  const windows = []
  for (const group of summary.groups) {
    if (!isObject(group) || (group.buckets !== undefined && !Array.isArray(group.buckets))) {
      throw new Error("The enterprise quota API returned an invalid quota group")
    }
    const groupName = text(group.displayName)
    const buckets = group.buckets ?? []
    if (!buckets.length) {
      windows.push({ name: groupName || "Quota", display: text(group.description) || "Usage unknown", aside: true })
      continue
    }
    for (const bucket of buckets) {
      if (!isObject(bucket)) throw new Error("The enterprise quota API returned an invalid quota bucket")
      const id = text(bucket.bucketId)
      const bucketName = text(bucket.displayName) || id
      const window = { name: [groupName, bucketName].filter(Boolean).join(" · ") || "Quota" }
      const fraction = bucket.remainingFraction
      if (Object.hasOwn(bucket, "remainingFraction") && typeof fraction === "number" && Number.isFinite(fraction) && fraction >= 0 && fraction <= 1) {
        // Even sub-epsilon positive fractions must not round up to exhaustion.
        window.used = fraction === 0 ? 100 : Math.min((1 - fraction) * 100, 100 - Number.EPSILON * 100)
      }
      // Exact upstream IDs also scope future models safely before the catalog loads.
      if (id && id === bucket.bucketId && !/[\s/]/.test(id)) {
        window.models = [id]
      } else {
        window.aside = true
      }
      if (!Object.hasOwn(window, "used")) window.display = "Usage unknown"
      windows.push(window)
    }
  }
  const plan = text(metadata.tierDisplayName) || text(metadata.userTier)
  return { ...(plan ? { plan } : {}), windows }
}
