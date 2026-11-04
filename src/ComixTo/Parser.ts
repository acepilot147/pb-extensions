import {
  Chapter,
  ChapterDetails,
  TagSection,
  SourceManga,
  PartialSourceManga,
} from "@paperback/types";
import {
  APIMangaItem,
  APIChapterItem,
  APIPagesResult,
  APIGenreItem,
  normalizeString,
  parseRelativeTime,
  isRatingAllowed,
  resolveSiteUrl,
} from "./Common";

// comix removed /images/no-poster.png (404 since 2026-11) and now draws an
// inline placeholder; an empty image URL makes Paperback show its own.
const NO_POSTER = "";

// Poster paths are site-relative since 2026-11 ("/images/covers/…"); older
// builds returned absolute URLs. Prefer the full-size image, then the 280px one.
const posterUrl = (poster?: { medium?: string; large?: string }): string => {
  const path = poster?.large || poster?.medium;
  return path ? resolveSiteUrl(path) : NO_POSTER;
};
const isNsfw = (rating?: string) => rating != null && rating !== "safe";

export class Parser {
  parseMangaDetails(data: APIMangaItem, mangaId: string): SourceManga {
    const buildSection = (
      id: string,
      label: string,
      items?: { id: number; title: string }[],
    ) =>
      items && items.length
        ? App.createTagSection({
            id,
            label,
            tags: items.map((t) =>
              App.createTag({ id: `${id}-${t.id}`, label: t.title }),
            ),
          })
        : null;

    const sections = [
      buildSection("genre", "Genres", data.genres),
      buildSection("tag", "Tags", data.tags),
      buildSection("demographic", "Demographics", data.demographics),
      buildSection("format", "Formats", data.formats),
    ].filter((s): s is NonNullable<typeof s> => s !== null);

    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [data.title, ...(data.altTitles ?? [])],
        image: posterUrl(data.poster),
        status: data.status,
        desc: data.synopsis,
        author: data.authors?.map((a) => a.title).join(", ") ?? "",
        artist: data.artists?.map((a) => a.title).join(", ") ?? "",
        rating: data.ratedAvg ? data.ratedAvg / 2 : 0,
        hentai: isNsfw(data.contentRating),
        tags: sections,
      }),
    });
  }

  parseChapters(
    data: APIChapterItem[],
    isFiltering: boolean,
    isWhitelist: boolean,
    isStrict: boolean,
    savedGroups: string[],
  ): Chapter[] {
    const chapters: Chapter[] = [];

    for (const chap of data) {
      const groupName = chap.group?.name || "";

      if (isFiltering && savedGroups.length > 0) {
        let matchFound = false;

        const normalizedGroupName = normalizeString(groupName).toLowerCase();
        for (const savedGroup of savedGroups) {
          const normalizedSaved = normalizeString(savedGroup).toLowerCase();
          if (isStrict) {
            if (normalizedGroupName === normalizedSaved) {
              matchFound = true;
              break;
            }
          } else {
            if (normalizedGroupName.includes(normalizedSaved)) {
              matchFound = true;
              break;
            }
          }
        }

        if (isWhitelist && !matchFound) continue;
        if (!isWhitelist && matchFound) continue;
      }

      chapters.push(
        App.createChapter({
          id: chap.id.toString(),
          chapNum: chap.number,
          name: chap.name ? `${chap.name}` : `Chapter ${chap.number}`,
          langCode: chap.language || "en",
          volume: chap.volume,
          group: groupName,
          time: parseRelativeTime(chap.createdAtFormatted),
          sortingIndex: chap.number,
        }),
      );
    }

    return chapters;
  }

  parseChapterDetails(
    data: APIPagesResult,
    mangaId: string,
    chapterId: string,
  ): ChapterDetails {
    const baseUrl = data.pages.baseUrl ?? "";
    const pages: string[] = data.pages.items.map((p) => {
      return /^https?:\/\//.test(p.url) ? p.url : `${baseUrl}${p.url}`;
    });
    
    return App.createChapterDetails({
      id: chapterId,
      mangaId: mangaId,
      pages: pages,
    });
  }

  // Tag/type filtering is delegated to the API via genres_in[] / genres_ex[] / types[] —
  // /manga and /manga/top list endpoints don't return per-item tag arrays, so the only
  // client-side filter that's meaningful here is content rating.
  parseMangaList(items: APIMangaItem[], maxRating: string): PartialSourceManga[] {
    const mangaList: PartialSourceManga[] = [];

    for (const item of items) {
      if (!isRatingAllowed(item.contentRating, maxRating)) continue;

      mangaList.push(
        App.createPartialSourceManga({
          mangaId: item.hid,
          image: posterUrl(item.poster),
          title: item.title,
          subtitle: item.latestChapter ? `Ch. ${item.latestChapter}` : undefined,
        }),
      );
    }
    return mangaList;
  }

  parseTagSections(
    genres: APIGenreItem[],
    themes: APIGenreItem[],
    formats: APIGenreItem[],
    demographics: APIGenreItem[],
  ): TagSection[] {
    const createSection = (
      id: string,
      label: string,
      items: APIGenreItem[],
    ) =>
      App.createTagSection({
        id: id,
        label: label,
        tags: items.map((x) =>
          App.createTag({ id: `${id}-${x.id}`, label: x.label }),
        ),
      });

    return [
      createSection("genre", "Genres", genres),
      createSection("tag", "Tags", themes),
      createSection("format", "Formats", formats),
      createSection("demographic", "Demographics", demographics),
    ];
  }
}
