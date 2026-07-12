// Twice-daily Oahu rental listing import — run by
// .github/workflows/fetch-rentals.yml (Node 20+, needs global fetch).
//
// Pulls from RentCast (developers.rentcast.io), a legitimate rental-listing
// aggregator API — not a scraper against Zillow/Realtor/Redfin, which block
// that and whose ToS this deliberately avoids testing. Filters to the
// family's actual search criteria, best-effort-tags pet-friendliness and a
// couple of preferred amenities, then batch-upserts into the existing
// Rentals sheet via Code.gs's importListings action (see Code.gs).
//
// Craigslist Honolulu was investigated and dropped for this project: its
// search results now require JavaScript (backed by an internal API, not
// static HTML), and Craigslist has a history of suing scrapers (3Taps,
// PadMapper) — reverse-engineering that API sits closer to circumventing
// their intended access than the "legitimate, ToS-compliant" bar this
// project is held to. Their sitemaps (a crawler-sanctioned discovery path)
// are a possible legitimate fast-follow, not attempted here.

const DRY_RUN = process.env.DRY_RUN === '1';
const RENTCAST_API_KEY = requireEnv('RENTCAST_API_KEY');
// Only needed to actually write — DRY_RUN=1 lets you sanity-check RentCast
// output/filtering without an Apps Script deployment wired up yet.
const RENTALS_API_BASE = DRY_RUN ? '' : requireEnv('RENTALS_API_BASE'); // Apps Script /exec URL
const RENTALS_IMPORT_KEY = DRY_RUN ? '' : requireEnv('RENTALS_IMPORT_KEY'); // must match Code.gs Script Property IMPORT_KEY

// Search criteria (hard filters — anything failing these is dropped
// regardless of what RentCast returns).
const MAX_PRICE = 6000;
const MIN_BEDS = 3;
const MIN_BATHS = 2;
const ALLOWED_PROPERTY_TYPES = ['Single Family', 'Townhouse']; // Condo/Apartment excluded

// Oahu search anchor: a central point (near Wahiawa) + radius wide enough
// to cover the whole island (~44mi long) in a single RentCast call, to stay
// well inside the free tier (1 call/run vs. paying per property-type call).
const SEARCH_LAT = 21.4700;
const SEARCH_LNG = -158.0000;
const SEARCH_RADIUS_MILES = 30;

// Best-effort keyword tagging — leaves a flag false rather than guessing
// wrong when a description is ambiguous or absent (RentCast has no
// structured pet-policy/amenity fields; this is all it can offer).
const PET_CAT_HINTS = [/\bcats?\s*(ok|okay|allowed|welcome|friendly)\b/i, /\bcats?\s*(and|&)\s*dogs?\s*(ok|okay|allowed|welcome)\b/i];
const PET_DOG_HINTS = [/\bdogs?\s*(ok|okay|allowed|welcome|friendly)\b/i, /\bdogs?\s*(and|&)\s*cats?\s*(ok|okay|allowed|welcome)\b/i];
const NO_PETS_HINTS = [/\bno\s+pets?\b/i, /\bpets?\s+not\s+allowed\b/i, /\bsorry,?\s+no\s+pets?\b/i];
const YARD_HINTS = [/\b(fenced|enclosed|private)\s+yard\b/i, /\byard\b/i];
const AC_HINTS = [/\bair\s*condition/i, /\bcentral\s+air\b/i, /\ba\/?c\b/i];

async function main() {
  console.log(`Fetching RentCast rental listings around Oahu (lat=${SEARCH_LAT}, lng=${SEARCH_LNG}, radius=${SEARCH_RADIUS_MILES}mi)...`);
  let raw = [];
  try {
    raw = await fetchAllRentCastListings();
  } catch (err) {
    console.error('RentCast fetch failed — aborting this run (nothing imported):', err.message);
    process.exitCode = 1;
    return;
  }
  console.log(`RentCast returned ${raw.length} raw listings before filtering.`);

  const normalized = raw.map(normalizeRentCastListing);
  const filtered = normalized.filter(passesHardFilter);
  console.log(`${filtered.length} listings pass the hard filter (<=$${MAX_PRICE}, >=${MIN_BEDS}bd, >=${MIN_BATHS}ba, ${ALLOWED_PROPERTY_TYPES.join('/')} only).`);

  const deduped = dedupeByAddress(filtered);
  if (deduped.length !== filtered.length) {
    console.log(`Deduped ${filtered.length - deduped.length} listing(s) sharing a normalized address.`);
  }

  const tagged = deduped.map(tagListing);

  if (DRY_RUN) {
    console.log('DRY_RUN=1 — skipping import, printing normalized listings:');
    console.log(JSON.stringify(tagged, null, 2));
    return;
  }

  if (!tagged.length) {
    console.log('Nothing to import this run.');
    return;
  }

  const result = await importListings(tagged);
  if (result.error) {
    console.error('Import failed:', result.error);
    process.exitCode = 1;
    return;
  }
  console.log(`Imported: ${result.imported.added} added, ${result.imported.updated} updated. Sheet now has ${result.listings.length} total listing(s).`);
}

async function fetchAllRentCastListings() {
  const all = [];
  let offset = 0;
  const limit = 500;
  const MAX_PAGES = 5; // safety valve — Oahu volume should never need this many
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('https://api.rentcast.io/v1/listings/rental/long-term');
    url.searchParams.set('latitude', String(SEARCH_LAT));
    url.searchParams.set('longitude', String(SEARCH_LNG));
    url.searchParams.set('radius', String(SEARCH_RADIUS_MILES));
    url.searchParams.set('status', 'Active');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));

    const res = await fetch(url, { headers: { Accept: 'application/json', 'X-Api-Key': RENTCAST_API_KEY } });
    if (!res.ok) {
      throw new Error(`RentCast HTTP ${res.status}: ${await res.text().catch(() => '')}`);
    }
    const page_ = await res.json();
    const batch = Array.isArray(page_) ? page_ : (page_.listings || []);
    all.push(...batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return all;
}

function normalizeRentCastListing(l) {
  return {
    externalId: 'rentcast:' + l.id,
    source: 'RentCast',
    address: l.formattedAddress || [l.addressLine1, l.city, l.state, l.zipCode].filter(Boolean).join(', '),
    addressLine2: l.addressLine2 || '',
    url: '', // RentCast doesn't return a public listing URL or photos
    photoUrl: '',
    price: l.price || '',
    sqft: l.squareFootage || '',
    beds: l.bedrooms || '',
    baths: l.bathrooms || '',
    propertyType: l.propertyType || '',
    // RentCast's schema has no free-text remarks/description field (confirmed
    // against their docs) — pet/yard/AC tagging below is keyword-matched
    // against this, so for RentCast listings it will always resolve to
    // false rather than guess. Manually-added listings can still get tagged
    // by pasting the source description into Notes and editing afterward.
    description: ''
  };
}

// RentCast's propertyType field is unreliable for Hawaii: verified against
// real live data that units explicitly inside a building get tagged "Single
// Family" or "Townhouse" anyway — e.g. "444 Niu St, Apt 3208B" as Townhouse,
// "242 Kaiulani Ave" (253 sqft, 0 bed) as Single Family. A non-empty
// addressLine2 is one clean signal; also confirmed some units put the unit
// marker directly in addressLine1/formattedAddress instead (e.g. "37
// Cypress Ave Apt D") with no addressLine2 at all, so both are checked.
const UNIT_MARKER_RE = /\b(apt|apartment|unit|ste|suite)\b|#\s*[a-z0-9]/i;
function isActuallyDetachedUnit(l) {
  if (l.addressLine2) return false;
  if (UNIT_MARKER_RE.test(l.address)) return false;
  return true;
}

function passesHardFilter(l) {
  const price = Number(l.price) || 0;
  const beds = Number(l.beds) || 0;
  const baths = Number(l.baths) || 0;
  if (!price || price > MAX_PRICE) return false;
  if (beds < MIN_BEDS) return false;
  if (baths < MIN_BATHS) return false;
  if (!ALLOWED_PROPERTY_TYPES.includes(l.propertyType)) return false;
  if (!isActuallyDetachedUnit(l)) return false;
  return true;
}

function normalizeAddress(addr) {
  return String(addr || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function dedupeByAddress(listings) {
  const seen = new Set();
  const out = [];
  for (const l of listings) {
    const key = normalizeAddress(l.address);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(l);
  }
  return out;
}

function matchesAny(text, patterns) {
  return patterns.some((re) => re.test(text));
}

function tagListing(l) {
  const text = String(l.description || '');
  const noPets = matchesAny(text, NO_PETS_HINTS);
  return {
    ...l,
    petCat: !noPets && matchesAny(text, PET_CAT_HINTS),
    petDog: !noPets && matchesAny(text, PET_DOG_HINTS),
    hasYard: matchesAny(text, YARD_HINTS),
    hasAC: matchesAny(text, AC_HINTS)
  };
}

async function importListings(listings) {
  const res = await fetch(RENTALS_API_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ action: 'importListings', listings, importKey: RENTALS_IMPORT_KEY })
  });
  if (!res.ok) {
    throw new Error(`importListings HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return res.json();
}

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name}. See site/SETUP.md for the GitHub Actions secrets this workflow needs.`);
    process.exit(1);
  }
  return v;
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exitCode = 1;
});
