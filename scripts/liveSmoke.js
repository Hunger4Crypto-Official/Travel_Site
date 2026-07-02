// Live smoke test: hits each configured provider once against the REAL API and
// prints the normalized result, so a provider mapping can be proven the moment
// real credentials and network egress are available. Unconfigured/unreachable
// providers are reported and skipped; the script never throws.
//
//   npm run smoke:live
//
// Requires outbound egress to each provider host and any needed credentials
// (AMADEUS_CLIENT_ID/SECRET, HOTELBEDS_*, AERODATABOX_RAPIDAPI_KEY,
// TRAVELPAYOUTS_TOKEN). No-key providers (OpenSky, ADS-B, airport dataset) run
// without credentials but still need egress.
import { loadDotEnv } from '../src/config/dotenv.js';
import { loadConfig } from '../src/config/env.js';
import { createProviders } from '../src/providers/index.js';

loadDotEnv({ path: new URL('../.env', import.meta.url).pathname });

function futureDate(daysAhead) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return d.toISOString().slice(0, 10);
}

const sampleQueries = {
  flights: { from: 'LAX', to: 'JFK', date: futureDate(30) },
  hotels: { city: 'Las Vegas', cityCode: 'LAS', checkin: futureDate(30), checkout: futureDate(33), adults: '2' },
  cars: { city: 'Miami', date: futureDate(30) },
  airports: { code: 'LAX' },
  tracking: { icao24: '4b1814' }
};

const types = ['flights', 'hotels', 'cars', 'airports', 'tracking'];

function describe(offer) {
  if (!offer) return 'no offers';
  const price = offer.price?.total ?? offer.price?.amount;
  const money = price ? `${price} ${offer.price?.currency || ''}` : 'n/a';
  const estimate = offer.price?.estimated ? ' (estimated)' : '';
  return `${money}${estimate} — ${offer.title || offer.id}`;
}

async function run() {
  const config = loadConfig();
  const providers = createProviders(config);

  console.log(`Live smoke test — ${providers.length} provider(s) registered\n`);

  for (const provider of providers) {
    const ready = provider.ready;
    const supported = types.filter((type) => provider.supports(type));
    if (!ready) {
      console.log(`• ${provider.name}: SKIP (not configured)`);
      continue;
    }
    for (const type of supported) {
      const label = `• ${provider.name} [${type}]`;
      try {
        const offers = await provider.search(type, sampleQueries[type]);
        console.log(`${label}: OK ${offers.length} offer(s) — ${describe(offers[0])}`);
      } catch (err) {
        console.log(`${label}: ERROR ${err.message}`);
      }
    }
  }

  console.log('\nDone. ERROR lines usually mean a blocked host (network egress) or invalid credentials.');
}

run();
