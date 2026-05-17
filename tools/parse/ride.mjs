// FlashFare ride request detector + parser.
// Pure module — no I/O. Operates on a TreeSerializer dump (`{meta, nodes}`).
//
// Detection is language-agnostic: it relies on numeric/structural invariants
// (currency-prefixed price, "X min (Y km)" pickup ETA, single "X km" trip
// distance, a wide Button in the bottom half of the screen). Works in any
// locale that uses € + km + min (FR/DE/ES/IT/BE/…). The few text-based labels
// kept (FR_NOISE) are explicit and easy to extend per locale.
//
// Reference: docs/09_planning_android.md Phase 1.D recommends the regex
// invariants `(\d+[,.]\d{2})\s*€`, `(\d+)\s*min`, `(\d+[,.]\d+)\s*km`.

const STANDALONE_PRICE_RE = /^\d+[.,]\d{2}\s*€$/;
const PRICE_IN_TEXT_RE = /(\d+[.,]\d{2})\s*€/;
const PICKUP_ETA_RE = /(\d+)\s*min\s*\(\s*(\d+(?:[.,]\d+)?)\s*km\s*\)/;
const SINGLE_KM_RE = /^[^0-9]*?(\d+(?:[.,]\d+)?)\s*km[^0-9]*$/;
const KM_TOKEN_RE = /\d+(?:[.,]\d+)?\s*km/g;
const MIN_TOKEN_RE = /\d+\s*min/;
const RATING_RE = /^\d[.,]\d{2}$/;
const POSTAL_ADDRESS_RE = /,\s*\d{4,5}\s+[A-Za-zÀ-ÿ]/;

// Locale-specific noise labels Uber renders alongside the structured fields
// (e.g. "Montant net de frais" / "Net amount" / "Importe neto"). Add per-locale
// equivalents as new device locales are introduced.
const NOISE_LABELS = new Set(['Montant net de frais']);

function nodeTexts(parsed) {
  return (parsed.nodes || [])
    .map((n) => n.text)
    .filter((t) => typeof t === 'string' && t.length > 0);
}

function rootBounds(parsed) {
  const root = parsed.nodes?.[0];
  const b = root?.bounds;
  if (!Array.isArray(b) || b.length < 4) return { width: 720, height: 1600 };
  return { width: b[2], height: b[3] };
}

function findBottomButton(parsed) {
  const { width, height } = rootBounds(parsed);
  return (parsed.nodes || []).find((n) => {
    if (n.class !== 'android.widget.Button') return false;
    const b = n.bounds;
    if (!Array.isArray(b) || b.length < 4) return false;
    const top = b[1];
    const w = b[2] - b[0];
    return top > height / 2 && w > width / 2;
  });
}

export function detect(parsed) {
  const ts = nodeTexts(parsed);
  const hasBottomButton = !!findBottomButton(parsed);
  const hasPrice = ts.some((t) => PRICE_IN_TEXT_RE.test(t));
  const hasPickupEta = ts.some((t) => PICKUP_ETA_RE.test(t));
  const kmCount = ts.reduce(
    (acc, t) => acc + (t.match(KM_TOKEN_RE)?.length || 0),
    0
  );
  const hasMultipleKm = kmCount >= 2; // pickup km + trip km
  return [hasBottomButton, hasPrice, hasPickupEta, hasMultipleKm].filter(Boolean).length >= 3;
}

function parsePrice(ts) {
  const standalone = ts.find((t) => STANDALONE_PRICE_RE.test(t));
  if (standalone) {
    return parseFloat(standalone.replace(/[€\s]/g, '').replace(',', '.'));
  }
  // Fallback: largest price-shaped match anywhere in the texts.
  const all = ts
    .flatMap((t) => Array.from(t.matchAll(/(\d+[.,]\d{2})\s*€/g)))
    .map((m) => parseFloat(m[1].replace(',', '.')));
  return all.length > 0 ? Math.max(...all) : null;
}

function parsePickupEta(ts) {
  for (const t of ts) {
    const m = PICKUP_ETA_RE.exec(t);
    if (m) {
      return {
        minutes: Number(m[1]),
        distanceKm: parseFloat(m[2].replace(',', '.'))
      };
    }
  }
  return null;
}

function parseTripDistance(ts) {
  for (const t of ts) {
    if (PICKUP_ETA_RE.test(t)) continue;
    const m = SINGLE_KM_RE.exec(t);
    if (m) return parseFloat(m[1].replace(',', '.'));
  }
  return null;
}

function parseRating(ts, priceText) {
  return (
    ts
      .filter((t) => RATING_RE.test(t) && t !== priceText)
      .map((t) => parseFloat(t.replace(',', '.')))[0] ?? null
  );
}

function parseVehicleType(ts, action) {
  return (
    ts.find((t) => {
      if (t === action) return false;
      if (t.length >= 40 || t.length < 2) return false;
      if (PRICE_IN_TEXT_RE.test(t)) return false;
      if (PICKUP_ETA_RE.test(t)) return false;
      if (RATING_RE.test(t)) return false;
      if (POSTAL_ADDRESS_RE.test(t)) return false;
      if (KM_TOKEN_RE.test(t)) return false;
      if (MIN_TOKEN_RE.test(t)) return false;
      if (NOISE_LABELS.has(t)) return false;
      return true;
    }) || null
  );
}

function isStructured(t, ctx) {
  return (
    t === ctx.action ||
    STANDALONE_PRICE_RE.test(t) ||
    PICKUP_ETA_RE.test(t) ||
    RATING_RE.test(t) ||
    POSTAL_ADDRESS_RE.test(t) ||
    SINGLE_KM_RE.test(t) ||
    t === ctx.vehicleType
  );
}

export function parse(parsed) {
  if (!detect(parsed)) return null;
  const ts = nodeTexts(parsed);

  const button = findBottomButton(parsed);
  const action = button?.text || null;
  const price = parsePrice(ts);
  const vehicleType = parseVehicleType(ts, action);
  const pickupEta = parsePickupEta(ts);
  const tripDistanceKm = parseTripDistance(ts);
  const driverRating = parseRating(ts);
  const addresses = ts.filter((t) => POSTAL_ADDRESS_RE.test(t));
  const pickupAddress = addresses[0] || null;
  const dropoffAddress = addresses[1] || null;

  const ctx = { action, vehicleType };
  const tags = ts.filter((t) => !isStructured(t, ctx) && !NOISE_LABELS.has(t));

  return {
    action,
    vehicleType,
    price,
    tags,
    driverRating,
    pickupEta,
    pickupAddress,
    tripDistanceKm,
    dropoffAddress
  };
}

export function signature(ride) {
  return [
    ride.vehicleType || '',
    ride.price != null ? ride.price.toFixed(2) : '',
    ride.tripDistanceKm != null ? ride.tripDistanceKm.toFixed(1) : '',
    ride.pickupAddress || '',
    ride.dropoffAddress || ''
  ].join('|');
}
