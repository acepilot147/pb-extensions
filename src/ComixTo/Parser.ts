import {
  Chapter,
  ChapterDetails,
  Tag,
  TagSection,
  SourceManga,
  PartialSourceManga,
} from "@paperback/types";
import {
  APIMangaItem,
  APIChapterItem,
  APIPagesResult,
  APIGenreItem,
  DOMAIN,
  normalizeString,
} from "./Common";

export class Parser {
  parseMangaDetails(data: APIMangaItem, mangaId: string): SourceManga {
    return App.createSourceManga({
      id: mangaId,
      mangaInfo: App.createMangaInfo({
        titles: [data.title, ...data.alt_titles],
        image: data.poster.large || "https://comix.to/images/no-poster.png",
        status: data.status,
        desc: data.synopsis,
        author: data.author?.map((a) => a.title).join(", ") ?? "",
        artist: data.artist?.map((a) => a.title).join(", ") ?? "",
        rating: data.rated_avg ? data.rated_avg / 2 : 0,
        hentai: data.is_nsfw,
        tags: [], // Detailed tags usually require a separate fetch or mapping from term_ids
      }),
    });
  }

parseChapters(
    data: APIChapterItem[], 
    isFiltering: boolean, 
    isWhitelist: boolean, 
    isStrict: boolean, 
    savedGroups: string[]
  ): Chapter[] {
    const chapters: Chapter[] = [];

    for (const chap of data) {
      const groupName = chap.scanlation_group?.name || "";

      // 1. Apply filtering logic if enabled and groups exist
      if (isFiltering && savedGroups.length > 0) {
        let matchFound = false;

        const normalizedGroupName = normalizeString(groupName).toLowerCase();
        for (const savedGroup of savedGroups) {
          const normalizedSaved = normalizeString(savedGroup).toLowerCase();
          if (isStrict) {
            // Exact match (case-insensitive)
            if (normalizedGroupName === normalizedSaved) {
              matchFound = true;
              break;
            }
          } else {
            // Partial match
            if (normalizedGroupName.includes(normalizedSaved)) {
              matchFound = true;
              break;
            }
          }
        }

        // Whitelist mode: if we didn't find the group in the list, skip this chapter
        if (isWhitelist && !matchFound) continue;

        // Blacklist mode (default): if we DID find the group in the list, skip this chapter
        if (!isWhitelist && matchFound) continue;
      }

      // 2. If it passes the filter, build and add the chapter
      chapters.push(
        App.createChapter({
          id: chap.chapter_id.toString(),
          chapNum: chap.number,
          name: chap.name ? `${chap.name}` : `Chapter ${chap.number}`,
          langCode: chap.language || "en",
          volume: chap.volume,
          group: groupName,
          time: new Date(chap.updated_at * 1000),
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
    const pages: string[] = data.images.map((img) => img.url);
    return App.createChapterDetails({
      id: chapterId,
      mangaId: mangaId,
      pages: pages,
    });
  }

  parseMangaList(items: APIMangaItem[], showNsfw: boolean, filteredTermIds: Set<number> = new Set(), tagWhitelistMode: boolean = false, typeFilter: Set<string> = new Set(), tagAndMode: boolean = false): PartialSourceManga[] {
    const mangaList: PartialSourceManga[] = [];

    for (const item of items) {
      if (!showNsfw && item.is_nsfw) {
        continue;
      }

      if (filteredTermIds.size > 0 || typeFilter.size > 0) {
        let hasMatch: boolean;
        if (tagAndMode) {
          // AND: every selected term ID must appear in the item, AND type must match if type filter is set
          const tagsAllMatch = filteredTermIds.size === 0 || [...filteredTermIds].every(id => item.term_ids?.includes(id) ?? false);
          const typeMatches = typeFilter.size === 0 || (item.type != null && typeFilter.has(item.type));
          hasMatch = tagsAllMatch && typeMatches;
        } else {
          // OR: any selected term ID or type is sufficient
          const hasTagMatch = filteredTermIds.size > 0 && (item.term_ids?.some(id => filteredTermIds.has(id)) ?? false);
          const hasTypeMatch = typeFilter.size > 0 && item.type != null && typeFilter.has(item.type);
          hasMatch = hasTagMatch || hasTypeMatch;
        }
        if (tagWhitelistMode ? !hasMatch : hasMatch) {
          continue;
        }
      }

      mangaList.push(
        App.createPartialSourceManga({
          mangaId: item.hash_id,
          image:
            item.poster?.large ||
            item.poster?.medium ||
            "https://comix.to/images/no-poster.png",
          title: item.title,
          subtitle: item.latest_chapter
            ? `Ch. ${item.latest_chapter}`
            : undefined,
        }),
      );
    }
    return mangaList;
  }

  // Helper to organize raw API terms into Paperback TagSections
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
    ) => {
      return App.createTagSection({
        id: id,
        label: label,
        tags: items.map((x) =>
          App.createTag({ id: `${id}-${x.term_id}`, label: x.title }),
        ),
      });
    };

    return [
      createSection("genre", "Genres", genres),
      createSection("theme", "Themes", themes),
      createSection("format", "Formats", formats),
      createSection("demographic", "Demographics", demographics),
    ];
  }
}
