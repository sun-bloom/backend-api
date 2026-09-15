// lib/deliveryMatcher.js
// Authoritative Delivery Region & Shipping Fee Resolver
// PINCODE-PRIMARY: Only pincode range matching is used. City/state are stored
// on the region for reference but are NOT used for matching.

/**
 * Matches a customer pincode against configured ACTIVE delivery regions.
 *
 * Matching Logic (pincode-primary only):
 *   1. Numeric pincode range: pincodeStart <= customerPin <= pincodeEnd
 *   For exact-pincode regions, pincodeStart === pincodeEnd.
 *
 * City/state are NOT used for matching — they are returned for display only.
 *
 * @param {Array}  regions - DeliveryRegion rows from DB (must include isActive)
 * @param {string} pincode - 6-digit customer postal pincode
 * @returns {Object|null} The first matching enabled region, or null
 */
function matchDeliveryRegion(regions, pincode) {
  if (!Array.isArray(regions) || regions.length === 0) return null;

  const cleanPin = String(pincode || '').trim().replace(/\D/g, '');
  const numPin = cleanPin.length === 6 ? parseInt(cleanPin, 10) : null;

  if (numPin === null) return null; // pincode required

  // Only consider active/enabled regions
  const activeRegions = regions.filter(
    (r) => r.isActive !== false && r.isEnabled !== false
  );

  // Pincode range match (pincodeStart <= customerPin <= pincodeEnd)
  const matched = activeRegions.find((r) => {
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

  const charge = Number(matchedRegion.shippingCharge ?? 0);
  return {
    shippingCharge: charge,
    isFreeShipping: false,
    isSupported: true,
    matchedRegion,
  };
}

module.exports = { matchDeliveryRegion, calculateShipping };
