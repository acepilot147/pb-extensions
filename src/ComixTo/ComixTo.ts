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
} from "./Common";
import { 
    resetSettings, 
    contentSettings, 
    groupSettings,
    getIsNsfw, 
    getTrendingLimit,
    getUploadersFiltering, 
    getUploadersWhitelisted, 
    getStrictNameMatching, 
    getUploaders 
} from "./Settings";

export const ComixToInfo: SourceInfo = {
  version: "1.2.0",
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
    return App.createDUISection({
      id: "main",
      header: "Source Settings",
      isHidden: false,
      rows: async () => [
        contentSettings(this.stateManager), 
        groupSettings(this.stateManager),
        resetSettings(this.stateManager)
      ],
    });
  }

  getMangaShareUrl(mangaId: string): string {
    return `${DOMAIN}/title/${mangaId}`;
  }

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const request = App.createRequest({
      url: `${API_BASE}/manga/${mangaId}?includes[]=author&includes[]=artist`,
      method: "GET",
    });

    const response = await this.requestManager.schedule(request, 1);
    this.checkResponseError(response);

    const json = JSON.parse(response.data ?? "{}");
    if (json.status !== 200) throw new Error("Failed to fetch manga details");

    return this.parser.parseMangaDetails(json.result, mangaId);
  }

  async getChapters(mangaId: string): Promise<Chapter[]> {
    const chapters: any[] = [];
    let page = 1;
    let lastPage = 1;

    do {
      const request = App.createRequest({
        url: `${API_BASE}/manga/${mangaId}/chapters?page=${page}&limit=100&order[number]=desc`,
        method: "GET",
      });

      const response = await this.requestManager.schedule(request, 1);
      this.checkResponseError(response);

      const json = JSON.parse(
        response.data ?? "{}",
      ) as APIResponse<APIChapterResult>;
      if (json.status !== 200) break;

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
      url: `${API_BASE}/chapters/${chapterId}`,
      method: "GET",
    });

    const response = await this.requestManager.schedule(request, 1);
    this.checkResponseError(response);

    const json = JSON.parse(
      response.data ?? "{}",
    ) as APIResponse<APIPagesResult>;
    if (json.status !== 200) throw new Error("Failed to fetch chapter pages");

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

    // 0: "Popular (Monthly)"
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
        `${API_BASE}/manga?order[chapter_updated_at]=desc&limit=15&scope=hot&includes[]=author`,
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
    const request = App.createRequest({ url, method: "GET" });
    const response = await this.requestManager.schedule(request, 1);
    this.checkResponseError(response);
    const json = JSON.parse(response.data ?? "{}") as APIResponse<APIMangaResult>;

    // 🟢 Fetch setting and pass it to the parser
    const showNsfw = await getIsNsfw(this.stateManager);

    if (json.result && json.result.items) {
      section.items = this.parser.parseMangaList(json.result.items, showNsfw);
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
        url = `${API_BASE}/manga?order[chapter_updated_at]=desc&scope=hot&limit=20&page=${page}&includes[]=author`;
        break;
      case "new":
        url = `${API_BASE}/manga?order[created_at]=desc&limit=20&page=${page}&includes[]=author`;
        break;
      default:
        return App.createPagedResults({ results: [], metadata: undefined });
    }

    const request = App.createRequest({ url, method: "GET" });
    const response = await this.requestManager.schedule(request, 1);
    const json = JSON.parse(
      response.data ?? "{}",
    ) as APIResponse<APIMangaResult>;

    const showNsfw = await getIsNsfw(this.stateManager);
    const items = this.parser.parseMangaList(json.result.items, showNsfw);
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
        url: `${API_BASE}/terms?type=${type}&limit=100`,
        method: "GET",
      });
      const res = await this.requestManager.schedule(req, 1);
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

    sections.push(
      App.createTagSection({
        id: "status",
        label: "Status",
        tags: PUBLICATION_STATUS.map((x) =>
          App.createTag({ id: `status-${x.id}`, label: x.label }),
        ),
      }),
    );

    // 2. Dynamic Filters (Middle)
    sections.push(
      ...this.parser.parseTagSections(genres, themes, formats, demographics),
    );

    // 3. The Hacky Logic Tag (Bottom)
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

    let url = `${API_BASE}/manga?order[relevance]=desc&page=${page}&limit=20`;

    if (query.title) {
      url += `&keyword=${encodeURIComponent(query.title)}`;
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
      (t) => t.id !== "logic-mode",
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

    const request = App.createRequest({ url, method: "GET" });
    const response = await this.requestManager.schedule(request, 1);
    this.checkResponseError(response);

    const json = JSON.parse(
      response.data ?? "{}",
    ) as APIResponse<APIMangaResult>;
    const showNsfw = await getIsNsfw(this.stateManager);
    const items = this.parser.parseMangaList(json.result.items, showNsfw);

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
  }
}
