import {
  Source,
  MangaProviding,
  ChapterProviding,
  SearchResultsProviding,
  HomePageSectionsProviding,
  SourceInfo,
  ContentRating,
  BadgeColor,
  SourceIntents,
  Request,
  Response,
  SourceManga,
  Chapter,
  ChapterDetails,
  HomeSection,
  PagedResults,
  SearchRequest,
  TagSection,
  HomeSectionType,
  DUISection,
} from "@paperback/types";

import { Parser } from "./Parser";
import { fetchSigned, signUrl } from "./ComixHash";
import { emit } from "./Telemetry";
import { debugLog, DEBUG } from "./DebugLog";
import {
  API_BASE,
  DOMAIN,
  APIResponse,
  APIMangaResult,
  APIChapterResult,
  APIPagesResult,
  APIGenreResult,
  CONTENT_TYPES,
  PUBLICATION_STATUS,
  ORDER_OPTIONS,
  normalizeString,
} from "./Common";
import {
    keepAlive,
    resetSettings,
    contentSettings,
    groupSettings,
    tagFilterSettings,
    getContentRatingMax,
    getTrendingLimit,
    getUploadersFiltering,
    getUploadersWhitelisted,
    getStrictNameMatching,
    getUploaders,
    getTagFilterEnabled,
    getTagBlacklist,
    getTagWhitelistMode,
    getTagAndMode,
    getTypeFilter,
    getCachedTags,
} from "./Settings";

import { readEncHeaders, decryptComixImageByParams, readScrambleHeaders, computeDescrambleLookup } from './ComixDescramble';
import { computeDescrambleLookupB } from './ComixTileB';

// Heuristic: is this URL a chapter-page image request (vs. an /api/v1 call)?
// Used only to scope debug logging to image traffic.
function isImageRequestUrl(url: string): boolean {
  if (!url) return false;
  return /\.(webp|png|jpe?g|avif)(\?|#|$)/i.test(url) || /wowpic\d*\.|\/s?i+\d*\//i.test(url);
}

export const ComixToInfo: SourceInfo = {
  version: "1.9.14",
  name: "ComixTo",
  icon: "icon.png",
  author: "acepilot147",
  authorWebsite: "https://acepilot147.github.io/pb-extensions/0.8",
  description: "Comix.to Extension with advanced filters. Fork of AthK extensions for Paperback 0.8 (edited by acepilot147)",
  contentRating: ContentRating.EVERYONE,
  websiteBaseURL: DOMAIN,
  sourceTags: [
    {
      text: "English",
      type: BadgeColor.GREY,
    },
  ],
  intents:
    SourceIntents.MANGA_CHAPTERS |
    SourceIntents.HOMEPAGE_SECTIONS |
    SourceIntents.CLOUDFLARE_BYPASS_REQUIRED |
    SourceIntents.SETTINGS_UI,
};

export class ComixTo
  extends Source
  implements
    MangaProviding,
    ChapterProviding,
    SearchResultsProviding,
    HomePageSectionsProviding
{
  parser = new Parser();
  stateManager = App.createSourceStateManager();
requestManager = App.createRequestManager({
  requestsPerSecond: 4,
  requestTimeout: 15000,
  interceptor: {
    interceptRequest: async (request: Request): Promise<Request> => {
      request.headers = {
        ...(request.headers ?? {}),
        "Referer": `${DOMAIN}/`,
        "User-Agent": await this.requestManager.getDefaultUserAgent()
      };
      if (DEBUG && isImageRequestUrl(request.url)) {
        debugLog("img_req", { url: request.url, headerKeys: Object.keys(request.headers ?? {}), origin: (request.headers as any)?.["Origin"] ?? (request.headers as any)?.["origin"] ?? null });
      }
      return request;
    },
    interceptResponse: async (response: Response): Promise<Response> => {
      if (!response.rawData) return response;

      // Tile-scramble pages (X-Scramble-Seed/X-Scramble-Grid) are a cols×rows tile
      // shuffle. Rebuild the clean image on a canvas by placing each scrambled tile
      // at its clean position. X-Scramble-Algo:3 (current, 5x5) uses the GF(2)-affine
      // Fisher-Yates (ComixTileB); algo 2/absent uses the legacy xorshift32 inverse.
      const scr = readScrambleHeaders(response.headers);
      if (scr) {
        try {
          const srcImage = App.createPBImage({ data: response.rawData });
          const { width, height } = srcImage;
          const { cols, rows, seed, algo } = scr;
          const tw = (width / cols) | 0;
          const th = (height / rows) | 0;
          // algo 3 (current scheme) is the GF(2)-affine Fisher-Yates, cracked for
          // the 5x5 grid (ComixTileB). algo 2 / absent is the legacy xorshift32.
          const lookup =
            algo === 3 && cols === 5 && rows === 5
              ? computeDescrambleLookupB(seed)
              : computeDescrambleLookup(seed, cols * rows);
          const canvas = App.createPBCanvas();
          canvas.setSize(width, height);
          for (let i = 0; i < lookup.length; i++) {
            const cleanRow = (i / cols) | 0;
            const cleanCol = i % cols;
            const srcIdx = lookup[i]!;
            const srcRow = (srcIdx / cols) | 0;
            const srcCol = srcIdx % cols;
            canvas.drawImage(srcImage, srcCol * tw, srcRow * th, tw, th, cleanCol * tw, cleanRow * th);
          }
          // Prefer WebP so Kingfisher's WebPProcessor (keyed on the .webp URL) can
          // still decode it; fall back to PNG if WebP encoding isn't supported.
          let encoded = canvas.encode("image/webp");
          let outMime = "image/webp";
          if (!encoded) { encoded = canvas.encode("image/png"); outMime = "image/png"; }
          if (encoded) {
            (response as any).rawData = encoded;
            (response as any).mimeType = outMime;
            if (response.headers) {
              (response.headers as any)["content-type"] = outMime;
              (response.headers as any)["Content-Type"] = outMime;
            }
          }
          if (DEBUG) debugLog("img_descramble", { seed, cols, rows, algo, width, height, encoded: !!encoded });
        } catch (error: any) {
          if (DEBUG) debugLog("img_descramble_error", { error: error?.message ?? String(error) });
          console.log(`[ComixTo] descramble error: ${error?.message ?? String(error)}`);
        }
        return response;
      }

      // Otherwise: byte-encrypted page (X-Enc-Seed/X-Enc-Len, optional X-Enc-Algo).
      // comix mixes two keystreams across a chapter: algo 1 (the LCG) and algo 2
      // (a degree-32 GF(2) word-LFSR). Decrypt the first N bytes in place — the
      // result is the original valid WebP.
      const enc = readEncHeaders(response.headers);
      if (!enc) return response; // clean image (no seed / seed 0) → pass through

      try {
        // App.createByteArray returns a Uint8Array view backed by the native rawData
        // buffer, so decrypting in place mutates response.rawData directly — no
        // App.createRawData write-back (it returns null on 0.8 and fires a spurious
        // "error processing the byteArray" notification for each call).
        const bytes = App.createByteArray(response.rawData);
        const handled = decryptComixImageByParams(bytes, enc);
        if (DEBUG) {
          const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
          debugLog("img_decrypt", { seed: enc.seed, len: enc.len, algo: enc.algo, handled, total: bytes.length, riff });
        }
      } catch (error: any) {
        if (DEBUG) debugLog("img_decrypt_error", { error: error?.message ?? String(error) });
        console.log(`[ComixTo] image decrypt error: ${error?.message ?? String(error)}`);
      }

      return response;
    },
  },
});

  // -- Capabilities --

  async supportsTagExclusion(): Promise<boolean> {
    return true;
  }

  // -- Settings Menu --
  async getSourceMenu(): Promise<DUISection> {
    return keepAlive(App.createDUISection({
      id: "main",
      header: "Source Settings",
      isHidden: false,
      rows: async () => keepAlive([
        contentSettings(this.stateManager),
        groupSettings(this.stateManager),
        tagFilterSettings(this.stateManager, this.requestManager),
        resetSettings(this.stateManager)
      ]),
    }));
  }

  // Build the URL fragment that applies the user's saved tag/type filter to a /manga or
  // /manga/top request. List endpoints don't return tag arrays, so client-side filtering
  // isn't possible — all filtering is delegated to the API via genres_in[] / genres_ex[].
  // genres_mode only affects whitelist (genres_in[]); blacklist is always OR.
  // For types[], the API only supports inclusion, so blacklist mode is implemented by
  // including every CONTENT_TYPE not in the user's hide list.
  private async buildFilterParams(): Promise<string> {
    const enabled = await getTagFilterEnabled(this.stateManager);
    if (!enabled) return "";

    const [blacklist, whitelistMode, andMode, typeFilterList] = await Promise.all([
      getTagBlacklist(this.stateManager),
      getTagWhitelistMode(this.stateManager),
      getTagAndMode(this.stateManager),
      getTypeFilter(this.stateManager),
    ]);

    const parts: string[] = [];
    if (blacklist.length > 0) {
      const param = whitelistMode ? "genres_in[]" : "genres_ex[]";
      for (const id of blacklist) parts.push(`${param}=${id}`);
      if (whitelistMode) parts.push(`genres_mode=${andMode ? "and" : "or"}`);
    }
    if (typeFilterList.length > 0) {
      const include = whitelistMode
        ? typeFilterList
        : CONTENT_TYPES.map(t => t.id).filter(t => !typeFilterList.includes(t));
      for (const t of include) parts.push(`types[]=${t}`);
    }
    return parts.length ? "&" + parts.join("&") : "";
  }

  getMangaShareUrl(mangaId: string): string {
    return `${DOMAIN}/title/${mangaId}`;
  }

  private async fetchTimed(label: string, url: string): Promise<import("@paperback/types").Response> {
    const path = url.replace(/^https?:\/\/[^/]+/, "").replace(/^\/api\/v1/, "").split("?")[0]!;
    const t0 = Date.now();
    const request = App.createRequest({ url, method: "GET" });
    const fetchStart = Date.now();
    const response = await this.requestManager.schedule(request, 1);
    const fetchMs = Date.now() - fetchStart;
    emit({ label, path, status: response.status, bytes: (response.data ?? "").length, signMs: 0, fetchMs, parseMs: 0, decryptMs: 0, totalMs: Date.now() - t0 });
    return response;
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const response = await this.fetchTimed("manga_details", signUrl(`${API_BASE}/manga/${mangaId}?includes[]=author&includes[]=artist`));
    this.checkResponseError(response);

    const json = JSON.parse(response.data ?? "{}");
    if (json.status !== "ok") throw new Error(`Failed to fetch manga details (API ${json.status}: ${json.message ?? "no message"})`);

    return this.parser.parseMangaDetails(json.result, mangaId);
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const fetchPage = (page: number) => fetchSigned<APIChapterResult>(
      this.requestManager,
      `${API_BASE}/manga/${mangaId}/chapters?page=${page}&limit=100&order[number]=desc`,
    );

    const firstResult = await fetchPage(1);
    const lastPage = firstResult.meta?.lastPage ?? 1;

    const restResults = lastPage > 1
      ? await Promise.all(Array.from({ length: lastPage - 1 }, (_, i) => fetchPage(i + 2)))
      : [];

    const chapters: any[] = [
      ...firstResult.items,
      ...restResults.flatMap(r => r.items),
    ];

    const [isFiltering, isWhitelist, isStrict, savedGroups] = await Promise.all([
      getUploadersFiltering(this.stateManager),
      getUploadersWhitelisted(this.stateManager),
      getStrictNameMatching(this.stateManager),
      getUploaders(this.stateManager)
    ]);

    const parsed = this.parser.parseChapters(chapters, isFiltering, isWhitelist, isStrict, savedGroups);
    return parsed;
  }

  async getChapterDetails(
    mangaId: string,
    chapterId: string,
  ): Promise<ChapterDetails> {
    const result = await fetchSigned<APIPagesResult>(
      this.requestManager,
      `${API_BASE}/chapters/${chapterId}`,
    );
    return this.parser.parseChapterDetails(result, mangaId, chapterId);
  }

  async getHomePageSections(
    sectionCallback: (section: HomeSection) => void,
  ): Promise<void> {
    const limitArray = await getTrendingLimit(this.stateManager);
    const days = limitArray[0] ?? "30";
    const maxRating = await getContentRatingMax(this.stateManager);
    const filterParams = await this.buildFilterParams();

    const sections = [
      App.createHomeSection({
        id: "trending",
        title: "Most Recent Popular",
        containsMoreItems: true,
        type: HomeSectionType.featured,
      }),
      App.createHomeSection({
        id: "latest",
        title: "Latest Updates",
        containsMoreItems: true,
        type: HomeSectionType.singleRowNormal,
      }),
      App.createHomeSection({
        id: "new",
        title: "Recently Added",
        containsMoreItems: true,
        type: HomeSectionType.singleRowNormal,
      }),
      App.createHomeSection({
        id: "follows_new",
        title: "Most Follows · New Comics",
        containsMoreItems: true,
        type: HomeSectionType.singleRowLarge,
      }),
      App.createHomeSection({
        id: "follows",
        title: "Most Followed",
        containsMoreItems: true,
        type: HomeSectionType.singleRowLarge,
      }),
    ];

    const promises: Promise<void>[] = [];

    // 0: "Most Recent Popular" — /manga/top with inclusive content_rating filter
    promises.push(
      this.fetchHomeData(
        `${API_BASE}/manga/top?type=trending&days=${days}&limit=15&content_rating=${maxRating}${filterParams}`,
        "home_trending",
        sections[0],
        sectionCallback,
      ),
    );

    // 1: "Latest Updates"
    promises.push(
      this.fetchHomeData(
        `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=15&includes[]=author${filterParams}`,
        "home_latest",
        sections[1],
        sectionCallback,
      ),
    );

    // 2: "Recently Added"
    promises.push(
      this.fetchHomeData(
        `${API_BASE}/manga?order[created_at]=desc&limit=15&includes[]=author${filterParams}`,
        "home_new",
        sections[2],
        sectionCallback,
      ),
    );

    // 3: "Most Follows · New Comics" — /manga/top with inclusive content_rating filter
    promises.push(
      this.fetchHomeData(
        `${API_BASE}/manga/top?type=follows&days=${days}&limit=15&content_rating=${maxRating}${filterParams}`,
        "home_follows_new",
        sections[3],
        sectionCallback,
      ),
    );

    // 4: "Most Followed"
    promises.push(
      this.fetchHomeData(
        `${API_BASE}/manga?order[follows_total]=desc&limit=15&includes[]=author${filterParams}`,
        "home_follows",
        sections[4],
        sectionCallback,
      ),
    );

    await Promise.all(promises);
  }

  async fetchHomeData(
    url: string,
    label: string,
    section: HomeSection,
    callback: (section: HomeSection) => void,
  ) {
    const response = await this.fetchTimed(label, signUrl(url));
    this.checkResponseError(response);
    const json = JSON.parse(response.data ?? "{}");
    const maxRating = await getContentRatingMax(this.stateManager);

    // /manga/top returns result as a flat array; /manga returns { items, meta }.
    const items = Array.isArray(json.result) ? json.result : json.result?.items;
    if (items) {
      section.items = this.parser.parseMangaList(items, maxRating);
    }
    callback(section);
  }

  async getViewMoreItems(
    homepageSectionId: string,
    metadata: any,
  ): Promise<PagedResults> {
    const page = metadata?.page ?? 1;
    const limitArray = await getTrendingLimit(this.stateManager);
    const days = limitArray[0] ?? "30";
    const maxRating = await getContentRatingMax(this.stateManager);
    const filterParams = await this.buildFilterParams();
    let url = "";
    let isTopEndpoint = false;

    switch (homepageSectionId) {
      case "trending":
        // /manga/top is a fixed top-N list with no pagination; fetch limit=50 once.
        url = `${API_BASE}/manga/top?type=trending&days=${days}&limit=50&content_rating=${maxRating}${filterParams}`;
        isTopEndpoint = true;
        break;
      case "follows_new":
        url = `${API_BASE}/manga/top?type=follows&days=${days}&limit=50&content_rating=${maxRating}${filterParams}`;
        isTopEndpoint = true;
        break;
      case "follows":
        url = `${API_BASE}/manga?order[follows_total]=desc&limit=20&page=${page}&includes[]=author${filterParams}`;
        break;
      case "latest":
        url = `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=20&page=${page}&includes[]=author${filterParams}`;
        break;
      case "new":
        url = `${API_BASE}/manga?order[created_at]=desc&limit=20&page=${page}&includes[]=author${filterParams}`;
        break;
      default:
        return App.createPagedResults({ results: [], metadata: undefined });
    }

    const response = await this.fetchTimed(`view_more_${homepageSectionId}`, signUrl(url));
    this.checkResponseError(response);
    const json = JSON.parse(response.data ?? "{}");

    const rawItems = Array.isArray(json.result) ? json.result : json.result?.items ?? [];
    const items = this.parser.parseMangaList(rawItems, maxRating);

    const nextPage = isTopEndpoint
      ? undefined  // top endpoint is a fixed list — no further pages
      : items.length > 0
        ? { page: page + 1 }
        : undefined;

    return App.createPagedResults({
      results: items,
      metadata: nextPage,
    });
  }

  // -- Advanced Search --

  async getSearchTags(): Promise<TagSection[]> {
    let genres: any[], themes: any[], formats: any[], demographics: any[];

    const cached = await getCachedTags(this.stateManager);
    if (cached) {
      ({ genre: genres, theme: themes, format: formats, demographic: demographics } = cached);
    } else {
      const fetchTags = async (type: string) => {
        try {
          // /tags/search caps at limit=50 in v1; >50 returns 422.
          const res = await this.fetchTimed("search_tags", signUrl(`${API_BASE}/tags/search?type=${type}&limit=50`));
          if (res.status < 200 || res.status >= 300) return [];
          const json = JSON.parse(res.data ?? "{}") as APIResponse<APIGenreResult>;
          return Array.isArray(json.result) ? json.result : [];
        } catch {
          return [];
        }
      };

      // v1 renamed type=theme → type=tag.
      [genres, themes, formats, demographics] = await Promise.all([
        fetchTags("genre"),
        fetchTags("tag"),
        fetchTags("format"),
        fetchTags("demographic"),
      ]);

      await this.stateManager.store('tag_cache_v1', JSON.stringify({
        genre: genres, theme: themes, format: formats, demographic: demographics, ts: Date.now(),
      }));
    }

    // Sections are always rebuilt fresh — SDK objects must not be reused across calls.
    const sections: TagSection[] = [];

    // 1. Static Filters (Top)
    sections.push(
      App.createTagSection({
        id: "type",
        label: "Content Type",
        tags: CONTENT_TYPES.map((x) =>
          App.createTag({ id: `type-${x.id}`, label: x.label }),
        ),
      }),
    );

    // 2. Order (just under Content Type)
    sections.push(
      App.createTagSection({
        id: "order",
        label: "Order (pick one, default: Best Match)",
        tags: ORDER_OPTIONS.map((x) =>
          App.createTag({ id: `order-${x.id}`, label: x.label }),
        ),
      }),
    );

    sections.push(
      App.createTagSection({
        id: "status",
        label: "Status",
        tags: PUBLICATION_STATUS.map((x) =>
          App.createTag({ id: `status-${x.id}`, label: x.label }),
        ),
      }),
    );

    // 3. Dynamic Filters (Middle)
    sections.push(
      ...this.parser.parseTagSections(genres, themes, formats, demographics),
    );

    // 4. The Hacky Logic Tag (Bottom)
    sections.push(
      App.createTagSection({
        id: "mode",
        label: "Genre Inclusion Mode (default- AND)",
        tags: [
          App.createTag({
            id: "logic-mode",
            label: "Green=AND | Red=OR",
          }),
        ],
      }),
    );

    return sections;
  }

  async getSearchResults(
    query: SearchRequest,
    metadata: any,
  ): Promise<PagedResults> {
    const page = metadata?.page ?? 1;

    const orderTag = (query.includedTags ?? []).find((t) => t.id.startsWith("order-"));
    const orderKey = orderTag ? orderTag.id.replace("order-", "") : "relevance";
    let url = `${API_BASE}/manga?order[${orderKey}]=desc&page=${page}&limit=20`;

    if (query.title) {
      // comix.to splits the keyword on `+` to do multi-term matching; `%20` is treated
      // as a literal space and breaks relevance ranking. Match what the browser sends.
      url += `&keyword=${encodeURIComponent(normalizeString(query.title)).replace(/%20/g, "+")}`;
    }

    // --- Logic Mode (only relevant when filtering by tags) ---
    // Default AND; the "logic-mode" hack tag in the excluded slot flips to OR.
    let genresMode = "and";
    if (query.excludedTags?.some((t) => t.id === "logic-mode")) {
      genresMode = "or";
    }

    const allTags = [...(query.includedTags ?? [])].filter(
      (t) => t.id !== "logic-mode" && !t.id.startsWith("order-"),
    );
    const excludedTags = [...(query.excludedTags ?? [])].filter(
      (t) => t.id !== "logic-mode",
    );

    // Tag categories (genre/tag/format/demographic) all share one ID space and go through
    // genres_in[] / genres_ex[] on the API. types[] and statuses[] are separate.
    const TAG_PREFIXES = ["genre-", "tag-", "format-", "demographic-"];
    const stripPrefix = (id: string) => id.replace(/^(genre-|tag-|format-|demographic-)/, "");
    const isTag = (id: string) => TAG_PREFIXES.some(p => id.startsWith(p));

    const includedTagIds = allTags.filter(t => isTag(t.id)).map(t => stripPrefix(t.id));
    const excludedTagIds = excludedTags.filter(t => isTag(t.id)).map(t => stripPrefix(t.id));
    const typeIds = allTags.filter(t => t.id.startsWith("type-")).map(t => t.id.replace("type-", ""));
    const statusIds = allTags.filter(t => t.id.startsWith("status-")).map(t => t.id.replace("status-", ""));

    for (const id of includedTagIds) url += `&genres_in[]=${id}`;
    for (const id of excludedTagIds) url += `&genres_ex[]=${id}`;
    for (const id of typeIds) url += `&types[]=${id}`;
    for (const id of statusIds) url += `&statuses[]=${id}`;

    // genres_mode applies only to genres_in[] (whitelist). Send it only when at least one
    // include tag exists; the API silently ignores it for genres_ex[] anyway.
    if (includedTagIds.length > 0) {
      url += `&genres_mode=${genresMode}`;
    }

    // Apply the user's saved global tag/type filter on top of the search-specific filter.
    url += await this.buildFilterParams();

    const response = await this.fetchTimed("search", signUrl(url));
    this.checkResponseError(response);

    const json = JSON.parse(
      response.data ?? "{}",
    ) as APIResponse<APIMangaResult>;
    const maxRating = await getContentRatingMax(this.stateManager);
    const items = this.parser.parseMangaList(json.result.items, maxRating);

    let nextPage = undefined;
    if (json.result.meta?.lastPage && json.result.meta.lastPage > page) {
      nextPage = { page: page + 1 };
    } else if (items.length >= 20) {
      nextPage = { page: page + 1 };
    }

    return App.createPagedResults({
      results: items,
      metadata: nextPage,
    });
  }

  async getCloudflareBypassRequestAsync(): Promise<Request> {
    return App.createRequest({
      url: DOMAIN,
      method: "GET",
      headers: {
        "Referer": `${DOMAIN}/`,
        "User-Agent": await this.requestManager.getDefaultUserAgent()
      },
    });
  }

  checkResponseError(response: Response): void {
    const data = response.data ?? "";
    // Diagnostic context is folded into thrown errors so users can include it in bug reports.
    const preview = data.substring(0, 200).replace(/\s+/g, " ");
    const headers = response.headers ?? {};
    const ct = (headers["Content-Type"] ?? headers["content-type"] ?? "?") as string;
    const server = (headers["Server"] ?? headers["server"] ?? "?") as string;
    const cfRay = (headers["Cf-Ray"] ?? headers["cf-ray"] ?? "?") as string;
    const reqUrl = (response as any).request?.url ?? "?";
    const ctx = `status=${response.status} ct=${ct} server=${server} cf-ray=${cfRay} url=${reqUrl} preview="${preview}"`;

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`HTTP ${response.status}: Unexpected response from server [${ctx}]`);
    }
    // Warn if server returned HTML instead of JSON (e.g. Cloudflare challenge slipped through)
    if (data.trimStart().startsWith("<")) {
      throw new Error(`Cloudflare challenge page returned [${ctx}]`);
    }
  }
}