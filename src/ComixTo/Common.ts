export const API_BASE = "https://comix.to/api/v2";
export const DOMAIN = "https://comix.to";

/**
 * Normalizes iOS smart quotes/apostrophes to their ASCII equivalents.
 * iOS autocorrect replaces ' with ' (U+2019), " with " / " (U+201C/U+201D),
 * which breaks search queries and string comparisons against API data.
 */
export function normalizeString(str: string): string {
  return str
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'") // smart single quotes → '
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"'); // smart double quotes → "
}

export interface APIResponse<T> {
  status: number;
  message?: string;
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
  type?: string;
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

export const ORDER_OPTIONS = [
  { id: "relevance",          label: "Best Match" },
  { id: "chapter_updated_at", label: "Updated Date" },
  { id: "created_at",         label: "Created Date" },
  { id: "views_7d",           label: "Most Views (7 Days)" },
  { id: "views_30d",          label: "Most Views (1 Month)" },
  { id: "views_90d",          label: "Most Views (3 Months)" },
  { id: "views_total",        label: "Total Views" },
  { id: "follows_total",      label: "Most Follows" },
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
