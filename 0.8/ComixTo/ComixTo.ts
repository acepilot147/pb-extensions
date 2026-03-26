import {
    Source,
    Manga,
    Chapter,
    ChapterDetails,
    HomeSection,
    SearchRequest,
    PagedResults,
    SourceInfo,
    ContentRating,
    BadgeColor,
    Request,
    Response,
    createRequestObject,
    createPagedResults,
    createRequestManager,
    createSourceStateManager,
    createDUINavigationButton,
    createDUIForm,
    createDUISection,
    createDUISwitch,
    createDUISelect,
    createDUIBinding,
    SourceStateManager,
    DUISection,
} from "paperback-extensions-common";

import { parseMangaDetails, parseChapterList, parsePageList, parseMangaList } from "./ComixToParser";
import { chapterSettings, contentSettings, resetSettings, getFilters } from "./ComixToSettings";

const COMIXTO_DOMAIN = "https://comix.to";

export const ComixToInfo: SourceInfo = {
    version: "1.4.1",
    name: "Comix.to",
    icon: "icon.png",
    author: "Michiya52",
    authorWebsite: "https://github.com/Michiya52",
    description: "Extension for Comix.to with advanced filters. (Updated by Michiya52)",
    contentRating: ContentRating.MATURE,
    websiteBaseURL: COMIXTO_DOMAIN,
};

export class ComixTo extends Source {
    requestManager = createRequestManager({
        requestsPerSecond: 3,
        requestTimeout: 15000,
        interceptor: {
            interceptRequest: async (request: Request): Promise<Request> => {
                request.headers = {
                    ...(request.headers ?? {}),
                    ...{
                        "Referer": COMIXTO_DOMAIN,
                        "User-Agent": await this.requestManager.getDefaultUserAgent(),
                    },
                };
                return request;
            },
            interceptResponse: async (response: Response): Promise<Response> => {
                if (response.status === 403 || response.status === 503) {
                    throw new Error("Cloudflare Bypass Required");
                }
                return response;
            },
        },
    });

    stateManager = createSourceStateManager();

    async getSourceMenu(): Promise<DUISection> {
        return createDUISection({
            id: "main",
            header: "Source Settings",
            isHidden: false,
            rows: async () => [
                contentSettings(this.stateManager, this.requestManager),
                chapterSettings(this.stateManager),
                resetSettings(this.stateManager)
            ]
        });
    }

    getMangaShareUrl(mangaId: string): string {
        return `${COMIXTO_DOMAIN}/comic/${mangaId}`;
    }

    async getPopularManga(range: number): Promise<PagedResults> {
        const request = createRequestObject({
            url: `${COMIXTO_DOMAIN}/popular`, // Assumed URL
            method: "GET",
        });
        const response = await this.requestManager.schedule(request, 1);
        const $ = this.cheerio.load(response.data);
        return parseMangaList($, COMIXTO_DOMAIN);
    }

    async getLatestUpdates(range: number): Promise<PagedResults> {
        const request = createRequestObject({
            url: `${COMIXTO_DOMAIN}/latest`, // Assumed URL
            method: "GET",
        });
        const response = await this.requestManager.schedule(request, 1);
        const $ = this.cheerio.load(response.data);
        return parseMangaList($, COMIXTO_DOMAIN);
    }

    async getSearchResults(query: SearchRequest, metadata: any): Promise<PagedResults> {
        const mangaSorting = await this.stateManager.retrieve("manga_sorting") as string ?? "";
        const sortParam = mangaSorting ? `&sort=${mangaSorting.split('.').pop()}` : "";
        const request = createRequestObject({
            url: `${COMIXTO_DOMAIN}/search`, // Assumed URL
            method: "GET",
            param: `?q=${encodeURIComponent(query.title ?? "")}${sortParam}`,
        });
        const response = await this.requestManager.schedule(request, 1);
        const $ = this.cheerio.load(response.data);
        return parseMangaList($, COMIXTO_DOMAIN);
    }

    async getMangaDetails(mangaId: string): Promise<Manga> {
        const request = createRequestObject({
            url: `${COMIXTO_DOMAIN}/comic/${mangaId}`,
            method: "GET",
        });
        const response = await this.requestManager.schedule(request, 1);
        const $ = this.cheerio.load(response.data);
        return parseMangaDetails($, mangaId);
    }

    async getChapters(mangaId: string): Promise<Chapter[]> {
        const request = createRequestObject({
            url: `${COMIXTO_DOMAIN}/comic/${mangaId}`,
            method: "GET",
        });
        const response = await this.requestManager.schedule(request, 1);
        const $ = (this as any).cheerio.load(response.data);

        const sortVotes = await this.stateManager.retrieve("sort_upvotes") as boolean ?? false;
        const appFilters = await getFilters(this.stateManager);

        return parseChapterList($, mangaId, sortVotes, appFilters);
    }

    async getChapterDetails(mangaId: string, chapterId: string): Promise<ChapterDetails> {
        const request = createRequestObject({
            url: `${COMIXTO_DOMAIN}/chapter/${chapterId}`, // Assumed URL structure
            method: "GET",
        });
        const response = await this.requestManager.schedule(request, 1);
        const $ = (this as any).cheerio.load(response.data);
        return parsePageList($, mangaId, chapterId);
    }

    async getCloudflareBypassRequestAsync(): Promise<Request> {
        return createRequestObject({
            url: COMIXTO_DOMAIN,
            method: "GET",
            headers: {
                "Referer": `${COMIXTO_DOMAIN}/`,
                "User-Agent": await this.requestManager.getDefaultUserAgent(),
            },
        });
    }
}
