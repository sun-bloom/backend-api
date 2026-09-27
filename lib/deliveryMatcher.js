// lib/deliveryMatcher.js
// Authoritative Delivery Region & Shipping Fee Resolver
// PINCODE-PRIMARY: Delivery provider availability is verified by pincode against configured regions.

// Default standard delivery regions when DB regions are empty
const DEFAULT_CONFIGURED_REGIONS = [
  {
    id: 'region-tiruppur-hub',
    regionName: 'Tiruppur Hub',
    state: 'Tamil Nadu',
    city: 'Tiruppur',
    pincodeStart: '641601',
    pincodeEnd: '641608',
    shippingCharge: 50,
    isActive: true,
    isEnabled: true,
  },
  {
    id: 'region-chennai-hub',
    regionName: 'Chennai Central',
    state: 'Tamil Nadu',
    city: 'Chennai',
    pincodeStart: '600001',
    pincodeEnd: '600028',
    shippingCharge: 70,
    isActive: true,
    isEnabled: true,
  },
  {
    id: 'region-coimbatore-hub',
    regionName: 'Coimbatore Hub',
    state: 'Tamil Nadu',
    city: 'Coimbatore',
    pincodeStart: '641001',
    pincodeEnd: '641045',
    shippingCharge: 50,
    isActive: true,
    isEnabled: true,
  },
];

/**
 * Matches a customer pincode against configured ACTIVE delivery regions.
 *
 * Matching Logic (pincode-primary):
 *   1. Exact pincode match (r.pincode === customerPin)
 *   2. Numeric pincode range (pincodeStart <= customerPin <= pincodeEnd)
 *
 * @param {Array}  regions - DeliveryRegion rows from DB (must include isActive)
 * @param {string} pincode - 6-digit customer postal pincode
 * @returns {Object|null} The matching enabled region, or null if no provider is configured
 */
function matchDeliveryRegion(regions, pincode) {
  const cleanPin = String(pincode || '').trim().replace(/\D/g, '');
  const numPin = cleanPin.length === 6 ? parseInt(cleanPin, 10) : null;

  if (numPin === null) return null;

  const targetRegions = Array.isArray(regions) && regions.length > 0
    ? regions
    : DEFAULT_CONFIGURED_REGIONS;

  // Only consider active/enabled regions
  const activeRegions = targetRegions.filter(
    (r) => r.isActive !== false && r.isEnabled !== false
  );

  const matched = activeRegions.find((r) => {
    // 1. Exact pincode match
    if (r.pincode && String(r.pincode).trim() === cleanPin) {
      return true;
    }

    // 2. Pincode range match
    const start = r.pincodeStart
      ? parseInt(String(r.pincodeStart).trim(), 10)
      : null;
    const end = r.pincodeEnd
      ? parseInt(String(r.pincodeEnd).trim(), 10)
      : null;

    if (
      start !== null &&
      end !== null &&
      !isNaN(start) &&
      !isNaN(end) &&
      start > 0 &&
      end >= start
    ) {
      return numPin >= start && numPin <= end;
    }

    return false;
  });

  return matched || null;
}

/**
 * Calculates authoritative shipping charge.
 *
 * @param {number}      subtotal         - Server-calculated order subtotal
 * @param {Object}      deliverySettings - Row with freeShippingThreshold
 * @param {Object|null} matchedRegion    - Result from matchDeliveryRegion
 * @returns {{ shippingCharge: number, isFreeShipping: boolean, isSupported: boolean, matchedRegion: Object|null }}
 */
function calculateShipping(subtotal, deliverySettings, matchedRegion) {
  const threshold = Number(deliverySettings?.freeShippingThreshold ?? 1500);

  if (!matchedRegion) {
    return {
      shippingCharge: 0,
      isFreeShipping: false,
      isSupported: false,
      matchedRegion: null,
    };
  }

  if (Number(subtotal) >= threshold) {
    return {
      shippingCharge: 0,
      isFreeShipping: true,
      isSupported: true,
      matchedRegion,
    };
  }

  const charge = Number(matchedRegion.shippingCharge ?? 50);
  return {
    shippingCharge: charge,
    isFreeShipping: false,
    isSupported: true,
    matchedRegion,
  };
}

module.exports = {
  matchDeliveryRegion,
  calculateShipping,
  DEFAULT_CONFIGURED_REGIONS,
};
