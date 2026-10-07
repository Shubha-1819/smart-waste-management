const { app } = require('@azure/functions');
const { CosmosClient } = require('@azure/cosmos');

const client = new CosmosClient(process.env.COSMOS_CONNECTION_STRING);
const container = client.database("SmartWasteDB").container("Telemetry");

const DEPOT = { lat: 12.9700, lng: 77.5900, name: "Central City Depot" };

// Haversine formula to compute geodesic distances between GPS coordinates
function haversine(c1, c2) {
  const R = 6371;
  const dLat = (c2.lat - c1.lat) * Math.PI / 180;
  const dLng = (c2.lng - c1.lng) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(c1.lat*Math.PI/180) * Math.cos(c2.lat*Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// 1. Ingestion Endpoint: POST /api/telemetry
app.http('telemetry', {
  methods: ['POST'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      const data = await request.json();
      data.id = `${data.binId}-${Date.now()}`;
      data.timestamp = new Date().toISOString();

      await container.items.create(data);
      return { status: 201, jsonBody: { status: "Success", binId: data.binId } };
    } catch (err) {
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});

// 2. Optimization Endpoint: GET /api/optimizeRoute
app.http('optimizeRoute', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: async (request, context) => {
    try {
      // Query recent telemetry points from Cosmos DB
      const query = "SELECT * FROM c ORDER BY c._ts DESC";
      const { resources: allRecords } = await container.items.query(query).fetchAll();

      // Deduplicate to isolate latest reading per bin
      const latestBinsMap = {};
      for (const item of allRecords) {
        if (!latestBinsMap[item.binId]) {
          latestBinsMap[item.binId] = item;
        }
      }
      const latestBins = Object.values(latestBinsMap);

      // Route optimization: Nearest Neighbor heuristic for bins >= 80% full
      const critical = latestBins.filter(b => b.fillLevel >= 80);
      const route = [DEPOT];
      let unvisited = [...critical];
      let current = DEPOT;

      while (unvisited.length > 0) {
        let nearestIdx = 0;
        let minDistance = Infinity;
        for (let i = 0; i < unvisited.length; i++) {
          const dist = haversine(current, unvisited[i]);
          if (dist < minDistance) {
            minDistance = dist;
            nearestIdx = i;
          }
        }
        current = unvisited[nearestIdx];
        route.push(current);
        unvisited.splice(nearestIdx, 1);
      }
      if (route.length > 1) route.push(DEPOT);

      return {
        status: 200,
        headers: { "Access-Control-Allow-Origin": "*" },
        jsonBody: { route, bins: latestBins, totalCritical: critical.length }
      };
    } catch (err) {
      return { status: 500, jsonBody: { error: err.message } };
    }
  }
});