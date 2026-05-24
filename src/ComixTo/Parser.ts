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
} from "./Common";

const NO_POSTER = "https://comix.to/images/no-poster.png";
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
        image: data.poster?.large || data.poster?.medium || NO_POSTER,
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
      const url = /^https?:\/\//.test(p.url) ? p.url : `${baseUrl}${p.url}`;
      return url.replace(/\/si\/(?=[bh])/, "/i/");
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
          image: item.poster?.large || item.poster?.medium || NO_POSTER,
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
