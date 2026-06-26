Travel API Aggregator
✈️ Overview
The Travel API Aggregator unifies multiple free‑tier and public travel APIs into a single backend service. It provides:

Global flight search

Hotel search

Car rentals

Airport data

Flight tracking

Distance & routing

IATA/ICAO lookup

The goal is to offer developers a consistent interface for building travel apps, booking engines, dashboards, or research tools.

🧩 Architecture
Components
API Gateway — Routes requests to the correct provider

Provider Modules — Individual wrappers for each external API

Caching Layer — Reduces API calls and improves performance

Rate‑Limit Guard — Protects API keys from overuse

Unified Response Formatter — Ensures consistent JSON output

🔑 API Keys Required
Requires Signup
Skyscanner (SkyScraper)

Priceline

Travelpayouts

Kiwi Tequila API

AeroDataBox

AviationStack

Booking.com

Expedia Rapid

Hotelbeds

Trueway Routing / Places

Public / No Key
OpenSky Network

IATA/ICAO public lists

Public airport datasets

🔗 API Provider Links
Flight Search & Pricing
Skyscanner (SkyScraper): https://rapidapi.com/apidojo/api/skyscanner-api (rapidapi.com in Bing)

Travelpayouts: https://www.travelpayouts.com/developers/api

Kiwi Tequila: https://tequila.kiwi.com/portal/login

Thunderbit Flight API: https://thunderbit.com/flight-api

Priceline: https://rapidapi.com/apidojo/api/priceline-com (rapidapi.com in Bing)

Flight Tracking & Aviation Data
AeroDataBox: https://rapidapi.com/aerodatabox/api/aerodatabox (rapidapi.com in Bing)

AviationStack: https://aviationstack.com

OpenSky Network: https://opensky-network.org/api

FlightAPI.io: https://flightapi.io

FlightAware AeroAPI: https://flightaware.com/aeroapi

Hotels
Booking.com: https://rapidapi.com/apidojo/api/booking (rapidapi.com in Bing)

Expedia Rapid: https://developers.expediagroup.com/rapid

Hotelbeds: https://developer.hotelbeds.com

Hotels API (Api Dojo): https://rapidapi.com/apidojo/api/hotels4 (rapidapi.com in Bing)

Car Rentals
Priceline Cars: https://rapidapi.com/apidojo/api/priceline-com (rapidapi.com in Bing)

Expedia Cars: https://developers.expediagroup.com/rapid

Travelpayouts Cars: https://www.travelpayouts.com/developers/api

Airport, Distance & Routing
Great Circle Mapper: https://www.gcmap.com/api

Airport Info API: https://rapidapi.com/Active-api/api/airport-info (rapidapi.com in Bing)

Trueway Routing: https://rapidapi.com/trueway/api/trueway-routing (rapidapi.com in Bing)

Trueway Places: https://rapidapi.com/trueway/api/trueway-places (rapidapi.com in Bing)

Google Distance Matrix: https://developers.google.com/maps/documentation/distance-matrix (developers.google.com in Bing)

IATA / ICAO Codes
IATA Codes: https://www.iata.org/en/publications/directories/code-search (iata.org in Bing)

ICAO Codes: https://www.icao.int/publications/pages/doc7910.aspx (icao.int in Bing)

📦 Installation
bash
git clone https://github.com/yourname/travel-api-aggregator
cd travel-api-aggregator
npm install
⚙️ Environment Variables
Create a .env file:

bash
SKYSCANNER_KEY=
KIWI_KEY=
PRICELINE_KEY=
AERODATABOX_KEY=
AVIATIONSTACK_KEY=
BOOKING_KEY=
EXPEDIA_KEY=
HOTELBEDS_KEY=
TRUEWAY_KEY=
Public APIs (OpenSky, IATA/ICAO) require no keys.

🚀 Usage
Flight Search
bash
GET /flights/search?from=LAX&to=JFK&date=2024-07-01
Hotel Search
bash
GET /hotels/search?city=Las%20Vegas&checkin=2024-07-01&checkout=2024-07-05
Car Rentals
bash
GET /cars/search?city=Miami&date=2024-07-01
Airport Info
bash
GET /airport/info?code=LAX
Flight Tracking
bash
GET /flights/live?icao24=abc123
📚 Unified Response Format
json
{
  "status": "success",
  "source": "provider_name",
  "data": { }
}
🧱 Project Structure
Code
/src
  /providers
    skyscanner.js
    kiwi.js
    priceline.js
    aerodatabox.js
    aviationstack.js
    booking.js
    expedia.js
    hotelbeds.js
    trueway.js
  /routes
    flights.js
    hotels.js
    cars.js
    airports.js
    tracking.js
  /utils
    cache.js
    rateLimit.js
    formatter.js
server.js
README.md
.env
🛡️ Rate Limiting
The aggregator includes:

Burst protection

Retry logic

Automatic fallback to secondary providers

🧪 Testing
bash
npm test
