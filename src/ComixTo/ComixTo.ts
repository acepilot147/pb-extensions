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
import { signUrl } from "./ComixHash";
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
    getIsNsfw,
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
} from "./Settings";

export const ComixToInfo: SourceInfo = {
  version: "1.4.0",
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
        return request;
      },
      interceptResponse: async (response: Response): Promise<Response> => {
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

  private async getTagFilterState(): Promise<{ filteredTermIds: Set<number>; tagWhitelistMode: boolean; typeFilter: Set<string>; tagAndMode: boolean }> {
    const enabled = await getTagFilterEnabled(this.stateManager);
    if (!enabled) {
      return { filteredTermIds: new Set(), tagWhitelistMode: false, tagAndMode: false, typeFilter: new Set() };
    }
    const [blacklist, whitelistMode, andMode, typeFilterList] = await Promise.all([
      getTagBlacklist(this.stateManager),
      getTagWhitelistMode(this.stateManager),
      getTagAndMode(this.stateManager),
      getTypeFilter(this.stateManager),
    ]);
    return {
      filteredTermIds: new Set(blacklist.map(id => parseInt(id, 10))),
      tagWhitelistMode: whitelistMode,
      tagAndMode: andMode,
      typeFilter: new Set(typeFilterList),
    };
  }

  getMangaShareUrl(mangaId: string): string {
    return `${DOMAIN}/title/${mangaId}`;
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const request = App.createRequest({
      url: signUrl(`${API_BASE}/manga/${mangaId}?includes[]=author&includes[]=artist`),
      method: "GET",
    });

    const response = await this.requestManager.schedule(request, 1);
    this.checkResponseError(response);

    const json = JSON.parse(response.data ?? "{}");
    if (json.status !== 200) throw new Error(`Failed to fetch manga details (API ${json.status}: ${json.message ?? "no message"})`);

    return this.parser.parseMangaDetails(json.result, mangaId);
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const chapters: any[] = [];
    let page = 1;
    let lastPage = 1;

    do {
      const request = App.createRequest({
        url: signUrl(`${API_BASE}/manga/${mangaId}/chapters?page=${page}&limit=100&order[number]=desc`),
        method: "GET",
      });

      const response = await this.requestManager.schedule(request, 1);
      this.checkResponseError(response);

      const json = JSON.parse(
        response.data ?? "{}",
      ) as APIResponse<APIChapterResult>;
      if (json.status !== 200) throw new Error(`Failed to fetch chapters (page ${page}) (API ${json.status}: ${json.message ?? "no message"})`);

      chapters.push(...json.result.items);

      lastPage = json.result.pagination.last_page;
      page++;
    } while (page <= lastPage);

    const [isFiltering, isWhitelist, isStrict, savedGroups] = await Promise.all([
      getUploadersFiltering(this.stateManager),
      getUploadersWhitelisted(this.stateManager),
      getStrictNameMatching(this.stateManager),
      getUploaders(this.stateManager)
    ]);

    return this.parser.parseChapters(chapters, isFiltering, isWhitelist, isStrict, savedGroups);
  }

  async getChapterDetails(
    mangaId: string,
    chapterId: string,
  ): Promise<ChapterDetails> {
    const request = App.createRequest({
      url: signUrl(`${API_BASE}/chapters/${chapterId}`),
      method: "GET",
    });

    const response = await this.requestManager.schedule(request, 1);
    this.checkResponseError(response);

    const json = JSON.parse(
      response.data ?? "{}",
    ) as APIResponse<APIPagesResult>;
    if (json.status !== 200) throw new Error(`Failed to fetch chapter pages (API ${json.status}: ${json.message ?? "no message"})`);

    return this.parser.parseChapterDetails(json.result, mangaId, chapterId);
  }

  async getHomePageSections(
    sectionCallback: (section: HomeSection) => void,
  ): Promise<void> {
    const limitArray = await getTrendingLimit(this.stateManager);
    const limit = limitArray[0] ?? "30"; // Fallback to "30" just in case

    const sections = [
      App.createHomeSection({
        id: "trending",
        title: "Popular (Trending)",
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
        id: "follows",
        title: "Most Followed",
        containsMoreItems: true,
        type: HomeSectionType.singleRowLarge,
      }),
    ];

    const promises: Promise<void>[] = [];

    // 0: "Popular (Trending)"
    promises.push(
      this.fetchHomeData(
        `${API_BASE}/top?type=trending&days=${limit}&limit=15&includes[]=author`,
        sections[0],
        sectionCallback,
      ),
    );

    // 1: "Latest Updates"
    promises.push(
      this.fetchHomeData(
        `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=15&includes[]=author`,
        sections[1],
        sectionCallback,
      ),
    );

    // 2: "Recently Added"
    promises.push(
      this.fetchHomeData(
        `${API_BASE}/manga?order[created_at]=desc&limit=15&includes[]=author`,
        sections[2],
        sectionCallback,
      ),
    );

    // 3: "Most Followed"
    promises.push(
      this.fetchHomeData(
        `${API_BASE}/manga?order[follows_total]=desc&limit=15&includes[]=author`,
        sections[3],
        sectionCallback,
      ),
    );

    await Promise.all(promises);
  }

  async fetchHomeData(
    url: string,
    section: HomeSection,
    callback: (section: HomeSection) => void,
  ) {
    const request = App.createRequest({ url: signUrl(url), method: "GET" });
    const response = await this.requestManager.schedule(request, 1);
    this.checkResponseError(response);
    const json = JSON.parse(response.data ?? "{}") as APIResponse<APIMangaResult>;

    const [showNsfw, { filteredTermIds, tagWhitelistMode, tagAndMode, typeFilter }] = await Promise.all([
      getIsNsfw(this.stateManager),
      this.getTagFilterState(),
    ]);

    if (json.result && json.result.items) {
      section.items = this.parser.parseMangaList(json.result.items, showNsfw, filteredTermIds, tagWhitelistMode, typeFilter, tagAndMode);
    }
    callback(section);
  }

  async getViewMoreItems(
    homepageSectionId: string,
    metadata: any,
  ): Promise<PagedResults> {
    const page = metadata?.page ?? 1;
    const limitArray = await getTrendingLimit(this.stateManager);
    const limit = limitArray[0] ?? "30";
    let url = "";

    // Added &includes[]=author to all requests
    switch (homepageSectionId) {
      case "trending":
        url = `${API_BASE}/top?type=trending&days=${limit}&limit=20&page=${page}&includes[]=author`;
        break;
      case "follows":
        // Updated to match homepage change
        url = `${API_BASE}/manga?order[follows_total]=desc&limit=20&page=${page}&includes[]=author`;
        break;
      case "latest":
        url = `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=20&page=${page}&includes[]=author`;
        break;
      case "new":
        url = `${API_BASE}/manga?order[created_at]=desc&limit=20&page=${page}&includes[]=author`;
        break;
      default:
        return App.createPagedResults({ results: [], metadata: undefined });
    }

    const request = App.createRequest({ url: signUrl(url), method: "GET" });
    const response = await this.requestManager.schedule(request, 1);
    this.checkResponseError(response);
    const json = JSON.parse(
      response.data ?? "{}",
    ) as APIResponse<APIMangaResult>;

    const [showNsfw, { filteredTermIds, tagWhitelistMode, tagAndMode, typeFilter }] = await Promise.all([
      getIsNsfw(this.stateManager),
      this.getTagFilterState(),
    ]);
    const items = this.parser.parseMangaList(json.result.items, showNsfw, filteredTermIds, tagWhitelistMode, typeFilter, tagAndMode);
    const hasNext = items.length > 0;

    return App.createPagedResults({
      results: items,
      metadata: hasNext ? { page: page + 1 } : undefined,
    });
  }

  // -- Advanced Search --

  async getSearchTags(): Promise<TagSection[]> {
    const fetchTags = async (type: string) => {
      const req = App.createRequest({
        url: signUrl(`${API_BASE}/terms?type=${type}&limit=100`),
        method: "GET",
      });
      const res = await this.requestManager.schedule(req, 1);
      this.checkResponseError(res);
      const json = JSON.parse(res.data ?? "{}") as APIResponse<APIGenreResult>;
      return json.result?.items ?? [];
    };

    const [genres, themes, formats, demographics] = await Promise.all([
      fetchTags("genre"),
      fetchTags("theme"),
      fetchTags("format"),
      fetchTags("demographic"),
    ]);

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

    // --- Order ---
    const orderTag = (query.includedTags ?? []).find((t) => t.id.startsWith("order-"));
    const orderKey = orderTag ? orderTag.id.replace("order-", "") : "relevance";
    let url = `${API_BASE}/manga?order[${orderKey}]=desc&page=${page}&limit=20`;

    if (query.title) {
      url += `&keyword=${encodeURIComponent(normalizeString(query.title))}`;
    }

    // --- Logic Mode Hack ---
    let genresMode = "and"; // default

    if (
      query.includedTags &&
      query.includedTags.some((t) => t.id === "logic-mode")
    ) {
      genresMode = "and";
    }
    if (
      query.excludedTags &&
      query.excludedTags.some((t) => t.id === "logic-mode")
    ) {
      genresMode = "or";
    }

    url += `&genres_mode=${genresMode}`;

    const allTags = [...(query.includedTags ?? [])].filter(
      (t) => t.id !== "logic-mode" && !t.id.startsWith("order-"),
    );
    const excludedTags = [...(query.excludedTags ?? [])].filter(
      (t) => t.id !== "logic-mode",
    );

    const genreIds: string[] = [];
    const typeIds: string[] = [];
    const statusIds: string[] = [];
    const demographicIds: string[] = [];

    for (const tag of allTags) {
      if (tag.id.startsWith("genre-")) {
        genreIds.push(tag.id.replace("genre-", ""));
      } else if (tag.id.startsWith("theme-")) {
        genreIds.push(tag.id.replace("theme-", ""));
      } else if (tag.id.startsWith("format-")) {
        genreIds.push(tag.id.replace("format-", ""));
      } else if (tag.id.startsWith("demographic-")) {
        demographicIds.push(tag.id.replace("demographic-", ""));
      } else if (tag.id.startsWith("type-")) {
        typeIds.push(tag.id.replace("type-", ""));
      } else if (tag.id.startsWith("status-")) {
        statusIds.push(tag.id.replace("status-", ""));
      }
    }

    for (const id of genreIds) url += `&genres[]=${id}`;
    for (const id of typeIds) url += `&types[]=${id}`;
    for (const id of statusIds) url += `&statuses[]=${id}`;
    for (const id of demographicIds) url += `&demographics[]=${id}`;

    if (excludedTags.length > 0) {
      for (const tag of excludedTags) {
        if (tag.id.startsWith("genre-") || tag.id.startsWith("theme-")) {
          const cleanId = tag.id.replace(/^(genre-|theme-)/, "");
          url += `&genres[]=-${cleanId}`;
        }
      }
    }

    const request = App.createRequest({ url: signUrl(url), method: "GET" });
    const response = await this.requestManager.schedule(request, 1);
    this.checkResponseError(response);

    const json = JSON.parse(
      response.data ?? "{}",
    ) as APIResponse<APIMangaResult>;
    const [showNsfw, { filteredTermIds, tagWhitelistMode, tagAndMode, typeFilter }] = await Promise.all([
      getIsNsfw(this.stateManager),
      this.getTagFilterState(),
    ]);
    const items = this.parser.parseMangaList(json.result.items, showNsfw, filteredTermIds, tagWhitelistMode, typeFilter, tagAndMode);

    let nextPage = undefined;
    if (json.result.pagination && json.result.pagination.last_page > page) {
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
    if (response.status === 403 || response.status === 503) {
      throw new Error("Cloudflare Bypass Required");
    }
    if (response.status < 200 || response.status >= 300) {
      const preview = (response.data ?? "").substring(0, 300);
      console.log(`[ComixTo] HTTP ${response.status} — response preview: ${preview}`);
      throw new Error(`HTTP ${response.status}: Unexpected response from server`);
    }
    // Warn if server returned HTML instead of JSON (e.g. Cloudflare challenge slipped through)
    const data = response.data ?? "";
    if (data.trimStart().startsWith("<")) {
      console.log(`[ComixTo] WARNING: Response looks like HTML, not JSON. Preview: ${data.substring(0, 300)}`);
      throw new Error("Cloudflare Bypass Required");
    }
  }
}
