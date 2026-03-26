import {
    Manga,
    Chapter,
    ChapterDetails,
    Tag,
    TagSection,
    PagedResults,
    SourceManga,
    PartialSourceManga,
    createManga,
    createChapter,
    createChapterDetails,
    createTag,
    createTagSection,
    createPartialSourceManga,
    createPagedResults
} from "paperback-extensions-common";

const convertTime = (timeAgo: string): Date => {
    let time: Date;
    let trimmed = Number((/\d*/.exec(timeAgo) ?? [])[0]);
    trimmed = (trimmed === 0 && timeAgo.includes('a')) ? 1 : trimmed;
    if (timeAgo.includes('minutes') || timeAgo.includes('mins') || timeAgo.includes('minute')) {
        time = new Date(Date.now() - trimmed * 60000);
    } else if (timeAgo.includes('hours') || timeAgo.includes('hour')) {
        time = new Date(Date.now() - trimmed * 3600000);
    } else if (timeAgo.includes('days') || timeAgo.includes('day')) {
        time = new Date(Date.now() - trimmed * 86400000);
    } else if (timeAgo.includes('year') || timeAgo.includes('years')) {
        time = new Date(Date.now() - trimmed * 31556952000);
    } else {
        time = new Date(timeAgo);
    }
    return time;
};


export const parseMangaList = ($: any, baseUrl: string): PagedResults => {
    const manga: PartialSourceManga[] = [];
    // Generic selectors for checking: .manga-item, .item-summary, .entry
    // Assuming a list layout
    $('div.manga-item, div.item, div.entry').each((_: any, element: any) => {
        const id = $('a', element).attr('href')?.split('/').pop() ?? '';
        const title = $('h3, .title', element).text().trim();
        const image = $('img', element).attr('src') ?? '';
        const subtitle = $('span.chapter, .latest-chapter', element).text().trim();

        if (!id || !title) return;

        manga.push(createPartialSourceManga({
            mangaId: id,
            image: image,
            title: title,
            subtitle: subtitle ? subtitle : undefined
        }));
    });

    return createPagedResults({
        results: manga
    });
}

export const parseMangaDetails = ($: any, mangaId: string): Manga => {
    // Generic selectors
    const title = $('h1, .manga-title').first().text().trim();
    const image = $('img.manga-cover, .summary_image img').attr('src') ?? '';
    const author = $('.author-content, .author').text().trim();
    const artist = $('.artist-content, .artist').text().trim();
    const description = $('.description-summary, .summary_content').text().trim();
    const status = $('.post-status, .status').text().trim();

    const arrayTags: Tag[] = [];
    $('.genres-content a, .genre a').each((_: any, element: any) => {
        const id = $(element).attr('href')?.split('/').pop() ?? '';
        const label = $(element).text().trim();
        arrayTags.push(createTag({ id: id, label: label }));
    });
    const tagSections: TagSection[] = [createTagSection({ id: '0', label: 'genres', tags: arrayTags })];

    return createManga({
        id: mangaId,
        titles: [title],
        image: image,
        status: status.toLowerCase().includes("ongoing") ? 1 : 0, // 1: Ongoing, 0: Completed
        rating: 0,
        author: author,
        artist: artist,
        tags: tagSections,
        desc: description,
        hentai: false
    });
}

export const parseChapterList = (
    $: any,
    mangaId: string,
    sortVotes: boolean = false,
    settings?: any
): Chapter[] => {
    const rawChapters: any[] = [];

    // 1. Extract all chapters from the page
    $('ul.row-content-chapter li, .chapter-list .row, .listing-chapters_wrap li').each((_: any, element: any) => {
        const id = $('a', element).attr('href')?.split('/').pop() ?? '';
        const name = $('a', element).text().trim();
        const time = $('.chapter-release-date, .date', element).text().trim();
        const chapMatch = name.match(/Chapter\s*(\d+(\.\d+)?)/i);
        const chapNum = Number(chapMatch?.[1] ?? 0);

        let finalName = name;
        let volumeNumber: number | undefined = undefined;
        let groupName: string | undefined = undefined;

        if (settings?.showVolume) {
            const volMatch = name.match(/Vol\.?\s*(\d+(\.\d+)?)/i);
            if (volMatch) {
                volumeNumber = Number(volMatch[1]);
            }
        }

        const uploader = $('.scanlator, .chapter-uploader, .group, .group-name', element).text().trim();
        if (uploader) {
            groupName = uploader;
        }

        const voteText = $('.votes, .like-count', element).text().trim();
        const votes = parseInt(voteText.replace(/,/g, '')) || 0;

        const langInfo = $('.lang-icon, .language', element).attr('title') || $('.language', element).text().trim() || 'en';
        const regionInfo = $('.region-icon, .region', element).attr('title') || $('.region', element).text().trim() || '';

        if (!id) return;

        rawChapters.push({
            id: id,
            mangaId: mangaId,
            name: finalName,
            chapNum: chapNum,
            volume: volumeNumber,
            time: convertTime(time),
            votes: votes,
            group: groupName,
            lang: langInfo,
            region: regionInfo
        });
    });

    // 2. Group by Chapter Number for "Soft Whitelist" logic
    const grouped = rawChapters.reduce((acc: any, chap: any) => {
        if (!acc[chap.chapNum]) acc[chap.chapNum] = [];
        acc[chap.chapNum].push(chap);
        return acc;
    }, {});

    const finalChapters: Chapter[] = [];

    const checkFilterFunc = (val: string | undefined, filter: { enabled: boolean, whitelist: boolean, strict: boolean, list: string[] } | undefined) => {
        if (!filter || !filter.enabled || !filter.list || filter.list.length === 0) return { pass: true, isMatched: false };
        if (!val) return { pass: !filter.whitelist, isMatched: false };

        const target = val.toLowerCase();
        const isMatched = filter.list.some(item => {
            const listItem = item.toLowerCase();
            return filter.strict ? target === listItem : target.includes(listItem);
        });

        return { pass: filter.whitelist ? isMatched : !isMatched, isMatched };
    };

    for (const chapNum in grouped) {
        const variants = grouped[chapNum];
        let filtered = variants;
        let filters = settings;

        if (filters) {
            // A. Hard Filter: Uploader Blacklist
            if (filters.uploaders && filters.uploaders.enabled && !filters.uploaders.whitelist) {
                filtered = variants.filter((v: any) => checkFilterFunc(v.group, filters.uploaders).pass);
            }

            // B. Soft Filter: Uploader Whitelist (Fallback to all if zero matches)
            if (filters.uploaders && filters.uploaders.enabled && filters.uploaders.whitelist) {
                const whitelisted = filtered.filter((v: any) => checkFilterFunc(v.group, filters.uploaders).isMatched);
                if (whitelisted.length > 0) {
                    filtered = whitelisted;
                }
            }

            // C. Priority Ranking (v1.3.4) - Sort by uploader preference
            const uploaderList = filters.uploaders.list.map((u: string) => u.toLowerCase());
            filtered.sort((a: any, b: any) => {
                const aName = a.group?.toLowerCase() ?? "";
                const bName = b.group?.toLowerCase() ?? "";
                let aIdx = uploaderList.findIndex((u: string) => filters.uploaders.strict ? aName === u : aName.includes(u));
                let bIdx = uploaderList.findIndex((u: string) => filters.uploaders.strict ? bName === u : bName.includes(u));
                if (aIdx === -1) aIdx = 9999;
                if (bIdx === -1) bIdx = 9999;
                return aIdx - bIdx;
            });

            // D. Deduplication (v1.6)
            if (filters.removeDuplicates && filtered.length > 1) {
                const unique: any[] = [];
                const seen = new Set();
                for (const chap of filtered) {
                    const key = `${chap.chapNum}-${chap.lang}`;
                    if (!seen.has(key)) {
                        seen.add(key);
                        unique.push(chap);
                    }
                }
                filtered = unique;
            }

            // E. One Version per Chapter logic
            if (filters.oneVersionOnly && filtered.length > 1) {
                filtered = [filtered[0]];
            }
        }

        for (const chap of filtered) {
            const groupTag = (settings?.showUploader && chap.group) ? ` [${chap.group}]` : "";
            const displayName = (settings && !settings.showTitle) ? `Chapter ${chap.chapNum}${groupTag}` : `${chap.name}${groupTag}`;

            finalChapters.push(createChapter({
                id: chap.id,
                mangaId: chap.mangaId,
                name: displayName,
                langCode: 'en',
                chapNum: chap.chapNum,
                time: chap.time,
                volume: chap.volume,
                group: chap.group
            }));
        }
    }

    if (sortVotes) {
        finalChapters.sort((a, b) => (b as any).votes - (a as any).votes);
    }

    return finalChapters;
}

export const parsePageList = ($: any, mangaId: string, chapterId: string): ChapterDetails => {
    const pages: string[] = [];

    // Generic reader selectors
    $('.reading-content img, .page-break img, #reader-area img').each((_: any, element: any) => {
        const url = $(element).attr('src')?.trim();
        if (url) pages.push(url);
    });

    return createChapterDetails({
        id: chapterId,
        mangaId: mangaId,
        pages: pages,
        longStrip: false
    });
}
