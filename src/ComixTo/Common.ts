export const API_BASE = "https://comix.to/api/v2";
export const DOMAIN = "https://comix.to";

export interface APIResponse<T> {
  status: number;
  result: T;
}

export interface APIMangaItem {
  manga_id: number;
  hash_id: string;
  title: string;
  alt_titles: string[];
  synopsis: string;
  slug: string;
  poster: {
    small: string;
    medium: string;
    large: string;
  };
  status: string;
  latest_chapter: number;
  chapter_updated_at: number;
  created_at: number;
  rated_avg: number;
  is_nsfw: boolean;
  author?: { title: string }[];
  artist?: { title: string }[];
  term_ids: number[];
}

export interface APIMangaResult {
  items: APIMangaItem[];
  pagination?: {
    last_page: number;
  };
}

export interface APIChapterItem {
  chapter_id: number;
  manga_id: number;
  number: number;
  name: string;
  language: string;
  volume: number;
  created_at: number;
  updated_at: number;
  scanlation_group?: { name: string };
}

export interface APIChapterResult {
  items: APIChapterItem[];
  pagination: {
    last_page: number;
    current_page: number;
  };
}

export interface APIPagesResult {
  manga_id: number;
  images: { url: string }[];
}

export interface APIGenreItem {
  term_id: number;
  title: string;
  slug: string;
  type: string;
}

export interface APIGenreResult {
  items: APIGenreItem[];
}

// Static Filter Definitions
export const CONTENT_TYPES = [
  { id: "manga", label: "Manga" },
  { id: "manhwa", label: "Manhwa" },
  { id: "manhua", label: "Manhua" },
  { id: "other", label: "Other" },
];

export const PUBLICATION_STATUS = [
  { id: "finished", label: "Finished" },
  { id: "releasing", label: "Releasing" },
  { id: "on_hiatus", label: "On Hiatus" },
  { id: "discontinued", label: "Discontinued" },
  { id: "not_yet_released", label: "Not Yet Released" },
];

/*
export const TRENDING_OPTIONS = [
  { id: "7", label: "1 Week" },
  { id: "30", label: "1 Month" },
  { id: "90", label: "3 Months" },
  { id: "180", label: "6 Months" },
  { id: "365", label: "1 Year" },
];
*/
