import { airports } from '../providers/data/airports.js';

// City name -> representative IATA code, built from the bundled airport dataset.
const cityToCode = new Map();
for (const airport of airports) {
  if (airport.city && airport.iata) {
    const key = airport.city.trim().toLowerCase();
    if (!cityToCode.has(key)) cityToCode.set(key, airport.iata.toUpperCase());
  }
}

// Resolves a free-text city (or a code passed through) to a 3-letter location
// code usable by real hotel/flight providers. Returns null when unknown.
export function resolveCityCode(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^[A-Za-z]{3}$/.test(trimmed)) return trimmed.toUpperCase();
  return cityToCode.get(trimmed.toLowerCase()) || null;
}

export function knownCityCount() {
  return cityToCode.size;
}
