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
    const pages: string[] = data.pages.map((p) => p.url);
    return App.createChapterDetails({
      id: chapterId,
      mangaId: mangaId,
      pages: pages,
    });
  }

  parseMangaList(
    items: APIMangaItem[],
    showNsfw: boolean,
    filteredTermIds: Set<number> = new Set(),
    tagWhitelistMode: boolean = false,
    typeFilter: Set<string> = new Set(),
    tagAndMode: boolean = false,
  ): PartialSourceManga[] {
    const mangaList: PartialSourceManga[] = [];

    for (const item of items) {
      if (!showNsfw && isNsfw(item.contentRating)) {
        continue;
      }

      if (filteredTermIds.size > 0 || typeFilter.size > 0) {
        // v1 list items expose tag arrays only on detail endpoints; flatten what we have on list items.
        const itemTagIds = new Set<number>([
          ...(item.genres ?? []).map((t) => t.id),
          ...(item.demographics ?? []).map((t) => t.id),
          ...(item.formats ?? []).map((t) => t.id),
          ...(item.tags ?? []).map((t) => t.id),
        ]);

        const filteredIdsArr = Array.from(filteredTermIds);
        let hasMatch: boolean;
        if (tagAndMode) {
          const tagsAllMatch =
            filteredIdsArr.length === 0 ||
            filteredIdsArr.every((id) => itemTagIds.has(id));
          const typeMatches =
            typeFilter.size === 0 || (item.type != null && typeFilter.has(item.type));
          hasMatch = tagsAllMatch && typeMatches;
        } else {
          const hasTagMatch =
            filteredIdsArr.length > 0 &&
            filteredIdsArr.some((id) => itemTagIds.has(id));
          const hasTypeMatch =
            typeFilter.size > 0 && item.type != null && typeFilter.has(item.type);
          hasMatch = hasTagMatch || hasTypeMatch;
        }
        if (tagWhitelistMode ? !hasMatch : hasMatch) {
          continue;
        }
      }

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
