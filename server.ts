import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { TV_RESTAURANTS_DB } from "./src/restaurantsData";
import { GoogleGenAI, Type } from "@google/genai";

dotenv.config();

// Haversine formula to calculate distance in km
function getDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// In-memory cache for Gemini API restaurant lookups to defend against quota exhaustion
interface CacheEntry {
  timestamp: number;
  data: any[];
}
const geminiSearchCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes cache duration

// Search real TV restaurants dynamically using Gemini API
async function searchRestaurantsWithGemini(
  lat: number,
  lng: number,
  locationName: string,
  userApiKey?: string
): Promise<any[]> {
  const apiKey = userApiKey || process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.log("No Gemini API key available for dynamic search.");
    return [];
  }

  // Key by coordinate rounded to 3 decimal places (~110 meters) to cover pans/slight movements
  const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const cached = geminiSearchCache.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    console.log(`[Cache Hit] Returning cached Gemini results for coord ${cacheKey} (${locationName})`);
    return cached.data;
  }

  const ai = new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  const prompt = `You are an expert culinary guide specializing in South Korea's TV-featured and famous media-featured restaurants (e.g. 유명 방송 맛집 from shows/creators like 풍자 또간집, 백종원의 3대천왕, 전현무계획, 쯔양, 남겨서뭐하니, 성시경의 먹을텐데, 생활의 달인, 흑백요리사, 수요미식회, 식객 허영만의 백반기행, 맛있는 녀석들, 줄 서는 식당, 생생정보통, 놀라운 토요일, 최자로드, 유 퀴즈 온 더 블럭, 전지적 참견 시점, 백종원의 골목식당, 신상출시 편스토랑, 토요일은 밥이 좋아, 오늘 뭐 먹지?, 어쩌다 사장, 한국인의 밥상, 한끼줍쇼, 밥블레스유, 테이스티 로드, 홍석천 이원일, VJ특공대, 김사원세끼, 김영철의 동네 한 바퀴, 식신로드, 나 혼자 산다).

Find real, officially featured restaurants in Korea that correspond to the following search profile:
- Search Center point: ${locationName}
- Coordinates: Latitude ${lat}, Longitude ${lng}
- Distance constraint: Strictly within a 2.0 km radius of this center coordinate.

Strict Rules of Integrity:
1. Search thoroughly across ALL SEASONS and year ranges of the TV shows listed above (e.g. '전현무계획 시즌1', '전현무계획 시즌2', '줄 서는 식당 2', '식신로드 시즌1/시즌2/시즌3/시즌4', '테이스티 로드 전 시즌', '어쩌다 사장 1/2/3', '밥블레스유 2020', '맛있는 녀석들' different eras, etc.).
2. Return ONLY real, verifiable restaurants that actually exist and have been featured on Korean culinary TV programs or Creator channels.
3. DO NOT fabricate or simulate any fake names, addresses, or phone numbers.
4. DO NOT change/shift addresses of existing restaurants to make them fit near the target coordinates. If there are no such restaurants within 2.0 km, return an empty array [].
5. Remove any speculative or inaccurate ratings or reviews, keep information highly precise. If telephone is inaccurate or not 100% known, represent as empty string "".
6. Calculate the coordinates accurately so they reside exactly at that actual restaurant's real geolocation, and check that the distance to [${lat}, ${lng}] is indeed <= 2.0 km.

The result must be a JSON array. Each object in the array must strictly match this schema:
- id: A unique string starting with "gemini_" (e.g. "gemini_mapo_sundae_19")
- name: The name of the restaurant (Korean)
- category: Type of food (e.g. "한식", "중식", "우동/돈까스", "일식", "양식")
- tvShow: The main TV show it appeared on WITH specific season suffix where applicable (e.g. "전현무계획 시즌2", "줄 서는 식당 2", "식신로드 시즌3", "성시경의 먹을텐데", "생활의 달인")
- tvEpisode: Extra info like winning place or episode name (e.g. "마포구편 1위", "해장국 편", "5회 방영")
- menu: Major dishes and prices (Korean, e.g. "얼큰순대국(9,000원)")
- address: Real Korean road-name address (e.g. "서울 마포구 망원로 22")
- latitude: Double (latitude coordinate)
- longitude: Double (longitude coordinate)
- description: Brief delicious summary (Korean, 2-3 sentences)
- tel: Phone number if accurate (optional/nullable, e.g. "02-123-4567"), or empty string if not 100% accurate.
- rating: Double (between 1.0 and 5.0, representing real user sentiment)
- featuredReason: Korean summary of why it's famous.`;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              name: { type: Type.STRING },
              category: { type: Type.STRING },
              tvShow: { type: Type.STRING },
              tvEpisode: { type: Type.STRING },
              menu: { type: Type.STRING },
              address: { type: Type.STRING },
              latitude: { type: Type.NUMBER },
              longitude: { type: Type.NUMBER },
              description: { type: Type.STRING },
              tel: { type: Type.STRING },
              rating: { type: Type.NUMBER },
              featuredReason: { type: Type.STRING },
            },
            required: [
              "id",
              "name",
              "category",
              "tvShow",
              "menu",
              "address",
              "latitude",
              "longitude",
              "description",
              "rating",
              "featuredReason"
            ]
          }
        }
      }
    });

    const text = response.text;
    if (text) {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) {
        // Double check distance to satisfy "within 2km"
        const filtered = parsed.filter(item => {
          const dist = getDistance(lat, lng, item.latitude, item.longitude);
          return dist <= 2.0;
        });

        // Store success result in cache
        const cacheKey = `${lat.toFixed(3)},${lng.toFixed(3)}`;
        geminiSearchCache.set(cacheKey, {
          timestamp: Date.now(),
          data: filtered
        });

        return filtered;
      }
    }
    return [];
  } catch (error: any) {
    const errMsg = error?.message || String(error);
    if (errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("RESOURCE_EXHAUSTED")) {
      console.log("[Server Info]: Gemini API Quota Limit encountered.");
      throw new Error("QUOTA_LIMIT");
    } else {
      console.log("[Server Info]: Gemini API dynamic search ended.");
      throw new Error(errMsg.slice(0, 100));
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Route for health-check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", mode: process.env.NODE_ENV || "development", count: TV_RESTAURANTS_DB.length });
  });

  // API Route to fetch TV restaurants
  app.post("/api/restaurants", async (req, res) => {
    console.log("Received local restaurant search request:", req.body);
    const { query, latitude, longitude, geminiApiKey } = req.body;

    try {
      let targetLat = latitude ? parseFloat(latitude) : null;
      let targetLng = longitude ? parseFloat(longitude) : null;
      let locationName = query || "현재 지정한 중심 위치 주변";

      // If only query text was provided and no GPS coords, try geocoding to find coordinates
      if (query && (!targetLat || !targetLng)) {
        const cleanQuery = query.trim();
        
        // Attempt Nominatim geocoding to find region center coordinates
        try {
          const geoRes = await fetch(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
              cleanQuery
            )}&format=json&limit=1&accept-language=ko&countrycodes=kr`,
            { headers: { "User-Agent": "OnAirEatsApp/1.0" } }
          );
          const geoData = await geoRes.json();
          if (geoData && geoData.length > 0) {
            targetLat = parseFloat(geoData[0].lat);
            targetLng = parseFloat(geoData[0].lon);
            const displayNameParts = geoData[0].display_name.split(",");
            locationName = displayNameParts.reverse().slice(1).join(" ").trim() || query;
            console.log(`Server geocoded '${cleanQuery}' -> lat: ${targetLat}, lon: ${targetLng}, resolved name: ${locationName}`);
          }
        } catch (err) {
          console.error("Geocoding failed inside server route:", err);
        }
      }

      // If still no center could be resolved, fallback to Mapo/Mangwon center coord
      if (!targetLat || !targetLng) {
        targetLat = 37.5562;
        targetLng = 126.9015;
        locationName = "서울 마포구 망원동";
      }

      // 1. Filter real restaurants within 2km from local database
      const localList = TV_RESTAURANTS_DB.filter(r => getDistance(targetLat!, targetLng!, r.latitude, r.longitude) <= 2.0);
      let list = [...localList];

      // 2. dynamically search using Gemini API if active
      const finalApiKey = geminiApiKey || process.env.GEMINI_API_KEY;
      let isGeminiActive = false;
      let geminiError = null;

      if (finalApiKey) {
        isGeminiActive = true;
        console.log("Triggering dynamic Gemini API search block...");
        try {
          const geminiFound = await searchRestaurantsWithGemini(targetLat, targetLng, locationName, finalApiKey);
          
          if (geminiFound && geminiFound.length > 0) {
            const localNames = new Set(localList.map(r => r.name.replace(/\s+/g, "")));
            
            const uniqueGemini = geminiFound.filter(r => {
              const cleanGeminiName = r.name.replace(/\s+/g, "");
              return !localNames.has(cleanGeminiName);
            });

            // Mark as Gemini dynamic results
            uniqueGemini.forEach(r => {
              r.isGemini = true;
            });

            list = [...list, ...uniqueGemini];
            console.log(`Merged ${uniqueGemini.length} unique Gemini-found restaurants. Total active: ${list.length}`);
          }
        } catch (gem_err: any) {
          const errMsg = gem_err?.message || String(gem_err);
          const isQuota = errMsg.includes("429") || errMsg.includes("quota") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("QUOTA_LIMIT");
          console.log(`[Server Info] Gemini dynamic search was skipped safely due to: ${isQuota ? "Quota limit" : "General limit"}`);
          geminiError = isQuota ? "QUOTA_LIMIT" : errMsg.slice(0, 100);
        }
      }

      console.log(`Successfully returned ${list.length} real restaurants for location: ${locationName} around coordinates: [${targetLat}, ${targetLng}]`);

      res.json({
        status: "ok",
        locationName: locationName,
        centerLat: targetLat,
        centerLng: targetLng,
        restaurants: list,
        isGeminiActive: isGeminiActive,
        geminiError: geminiError
      });

    } catch (error: any) {
      console.error("API error inside server:", error);
      const defaultLat = 37.5562;
      const defaultLng = 126.9015;
      const matchedFallback = TV_RESTAURANTS_DB.filter(r => getDistance(defaultLat, defaultLng, r.latitude, r.longitude) <= 2.0);
      res.json({
        status: "ok",
        locationName: "서울 마포구 망원동",
        centerLat: defaultLat,
        centerLng: defaultLng,
        restaurants: matchedFallback,
        isGeminiActive: false
      });
    }
  });

  // Vite middleware for development or serving static files in production
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer();
