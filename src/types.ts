export interface Restaurant {
  id: string;
  name: string;
  category: string;
  tvShow: string;
  tvEpisode: string;
  menu: string;
  address: string;
  latitude: number;
  longitude: number;
  description: string;
  tel?: string;
  rating: number;
  featuredReason: string;
  isSynthesized?: boolean;
  isGemini?: boolean;
}

export interface GeocodeResult {
  place_id: number;
  licence: string;
  osm_type: string;
  osm_id: number;
  boundingbox: string[];
  lat: string;
  lon: string;
  display_name: string;
  class: string;
  type: string;
  importance: number;
}
