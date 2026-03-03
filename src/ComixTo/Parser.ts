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

  parseChapters(data: APIChapterItem[]): Chapter[] {
    const chapters: Chapter[] = [];
    for (const chap of data) {
      chapters.push(
        App.createChapter({
          id: chap.chapter_id.toString(),
          chapNum: chap.number,
          name: chap.name ? `${chap.name}` : `Chapter ${chap.number}`,
          langCode: chap.language || "en",
          volume: chap.volume,
          group: chap.scanlation_group?.name || "",
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

  parseMangaList(items: APIMangaItem[], showNsfw: boolean): PartialSourceManga[] {
    const mangaList: PartialSourceManga[] = [];
    
    for (const item of items) {
      if (!showNsfw && item.is_nsfw) {
        continue;
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
