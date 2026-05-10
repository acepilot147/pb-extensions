import {
    DUIButton,
    DUINavigationButton,
    RequestManager,
    SourceStateManager
} from '@paperback/types'

import { API_BASE, APIResponse, APIGenreItem, APIGenreResult, CONTENT_TYPES, CONTENT_RATINGS } from './Common'
import { signUrl } from './ComixHash'

interface TagCache {
    genre: APIGenreItem[];
    theme: APIGenreItem[];
    format: APIGenreItem[];
    demographic: APIGenreItem[];
    ts?: number;
}

export const TRENDING_OPTIONS =[
  { id: "1", label: "1 day" },
  { id: "7", label: "7 days" },
  { id: "30", label: "1 month" },
  { id: "90", label: "3 months" },
  { id: "180", label: "6 months" },
  { id: "365", label: "1 year" },
];

// Helper to prevent JS GC from destroying UI closures before iOS runs them
const uiKeepAlive: any[] =[];
export const keepAlive = <T>(obj: T): T => {
    uiKeepAlive.push(obj);
    return obj;
}

// One-shot warm-up: runs once on first groupSettings render, skipped on all subsequent re-renders.
// Pre-loads all values so the form renders with real data immediately.
let groupSettingsWarmUp: Promise<void> | null = null;
const warmUpGroupSettings = (stateManager: SourceStateManager): Promise<void> => {
    if (!groupSettingsWarmUp) {
        groupSettingsWarmUp = (async () => {
            await getUploadersFiltering(stateManager);
            await getUploadersWhitelisted(stateManager);
            await getStrictNameMatching(stateManager);
            await getUploaders(stateManager);
            await getSelectedUploaders(stateManager);
            await getUploaderInput(stateManager);
        })();
    }
    return groupSettingsWarmUp;
}

// --- HELPERS: DISCOVER & CONTENT RATING ---
// Returns the user's max-allowed content rating id (one of CONTENT_RATINGS ids).
// Items with this rating or tamer are shown; anything more explicit is hidden.
export const getContentRatingMax = async (stateManager: SourceStateManager): Promise<string> => {
    const val = await stateManager.retrieve('content_rating_max') as string[] | null;
    return val?.[0] ?? "suggestive";
}

export const getTrendingLimit = async (stateManager: SourceStateManager): Promise<string[]> => {
    const val = await stateManager.retrieve('trending_limit') as string[];
    return val ?? ["30"];
}

// --- HELPERS: GROUP FILTERING ---
export const getUploadersFiltering = async (stateManager: SourceStateManager): Promise<boolean> => {
    return (await stateManager.retrieve('uploaders_toggled') as boolean) ?? false;
}

export const getUploadersWhitelisted = async (stateManager: SourceStateManager): Promise<boolean> => {
    return (await stateManager.retrieve('uploaders_whitelisted') as boolean) ?? false;
}

export const getStrictNameMatching = async (stateManager: SourceStateManager): Promise<boolean> => {
    return (await stateManager.retrieve('strict_name_matching') as boolean) ?? false;
}

export const getUploaders = async (stateManager: SourceStateManager): Promise<string[]> => {
    return (await stateManager.retrieve('uploaders') as string[]) ??[];
}

export const getUploaderInput = async (stateManager: SourceStateManager): Promise<string> => {
    return (await stateManager.retrieve('uploader_input') as string) ?? '';
}

export const getSelectedUploaders = async (stateManager: SourceStateManager): Promise<string[]> => {
    return (await stateManager.retrieve('uploaders_selected') as string[]) ??[];
}

// --- MENUS ---

export const contentSettings = (stateManager: SourceStateManager): DUINavigationButton => {
    return keepAlive(App.createDUINavigationButton({
        id: 'content_settings',
        label: 'Extension Settings',
        form: App.createDUIForm({
            sections: async () => keepAlive([
                // 1. Home Page Settings
                App.createDUISection({
                    id: 'home_settings',
                    header: 'Discover Page Settings',
                    footer: 'Adjust the time range for trending media on the Discover page.',
                    isHidden: false,
                    rows: async () => keepAlive([
                        App.createDUISelect({
                            id: 'trending_limit',
                            label: 'Trending Timeframe',
                            options: TRENDING_OPTIONS.map(opt => opt.id),
                            value: App.createDUIBinding({
                                get: async () => await getTrendingLimit(stateManager),
                                set: async (newValue) => await stateManager.store('trending_limit', newValue)
                            }),
                            allowsMultiselect: false,
                            labelResolver: async (value: string) => {
                                return TRENDING_OPTIONS.find(opt => opt.id === value)?.label ?? value;
                            }
                        })
                    ])
                }),
                // 2. Content Filtering
                App.createDUISection({
                    id: 'rating_settings',
                    header: 'Content Filtering',
                    footer: 'Items with the selected rating or tamer are shown. Anything more explicit is hidden.',
                    isHidden: false,
                    rows: async () => keepAlive([
                        App.createDUISelect({
                            id: 'content_rating_max',
                            label: 'Maximum Content Rating',
                            options: CONTENT_RATINGS.map(r => r.id),
                            value: App.createDUIBinding({
                                get: async () => [await getContentRatingMax(stateManager)],
                                set: async (newValue: string[]) => await stateManager.store('content_rating_max', newValue)
                            }),
                            allowsMultiselect: false,
                            labelResolver: async (value: string) => {
                                return CONTENT_RATINGS.find(r => r.id === value)?.label ?? value;
                            }
                        })
                    ])
                })
            ])
        })
    }))
}

export const groupSettings = (stateManager: SourceStateManager): DUINavigationButton => {
    return keepAlive(App.createDUINavigationButton({
        id: 'group_settings',
        label: 'Scanlation Group Settings',
        form: App.createDUIForm({
            sections: async () => {
                await warmUpGroupSettings(stateManager);

                return keepAlive([
                App.createDUISection({
                    id: 'filtering_settings',
                    header: 'Filtering Settings',
                    footer: 'By default, listed groups are excluded from chapter lists (blacklist mode). Turn off Strict Matching to catch partial names.',
                    isHidden: false,
                    rows: async () => keepAlive([
                        App.createDUISwitch({
                            id: 'toggle_uploaders_filtering',
                            label: 'Enable Group Filtering',
                            value: App.createDUIBinding({
                                get: async () => await getUploadersFiltering(stateManager),
                                set: async (newValue: boolean) => await stateManager.store('uploaders_toggled', newValue)
                            })
                        }),
                        App.createDUISwitch({
                            id: 'uploaders_switch',
                            label: 'Enable Whitelist Mode',
                            value: App.createDUIBinding({
                                get: async () => await getUploadersWhitelisted(stateManager),
                                set: async (newValue: boolean) => await stateManager.store('uploaders_whitelisted', newValue)
                            })
                        }),
                        App.createDUISwitch({
                            id: 'strict_name_matching',
                            label: 'Strict Group Name Matching',
                            value: App.createDUIBinding({
                                get: async () => await getStrictNameMatching(stateManager),
                                set: async (newValue: boolean) => await stateManager.store('strict_name_matching', newValue)
                            })
                        })
                    ])
                }),
                App.createDUISection({
                    id: 'manage_groups',
                    header: 'Manage Groups',
                    isHidden: false,
                    rows: async () => {
                        const uploaders = await getUploaders(stateManager);

                        return keepAlive([
                            App.createDUISelect({
                                id: 'uploaders_list',
                                label: 'Currently Saved Groups',
                                options: uploaders,
                                value: App.createDUIBinding({
                                    get: async () => await getSelectedUploaders(stateManager),
                                    set: async (newValue: string[]) => await stateManager.store('uploaders_selected', newValue)
                                }),
                                labelResolver: async (value) => value,
                                allowsMultiselect: true
                            }),
                            App.createDUIInputField({
                                id: 'uploader_input',
                                label: 'Group Name',
                                value: App.createDUIBinding({
                                    get: async () => await getUploaderInput(stateManager),
                                    set: async (newValue: string) => await stateManager.store('uploader_input', newValue)
                                })
                            }),
                            App.createDUIButton({
                                id: 'add_uploader',
                                label: 'Add Group',
                                onTap: async () => {
                                    const targetUploader = await getUploaderInput(stateManager);
                                    if (!targetUploader || targetUploader.trim() === '') {
                                        throw new Error('Group name cannot be empty!');
                                    }

                                    const uploadersList = await getUploaders(stateManager);
                                    if (uploadersList.includes(targetUploader)) {
                                        throw new Error(`Group "${targetUploader}" is already in the list!`);
                                    }

                                    uploadersList.push(targetUploader);
                                    await stateManager.store('uploaders', uploadersList);
                                    await stateManager.store('uploader_input', '');
                                }
                            }),
                            App.createDUIButton({
                                id: 'remove_uploader',
                                label: 'Remove Group',
                                onTap: async () => {
                                    const targetUploader = await getUploaderInput(stateManager);
                                    if (!targetUploader || targetUploader.trim() === '') {
                                        throw new Error('Group name cannot be empty!');
                                    }

                                    const uploadersList = await getUploaders(stateManager);
                                    const index = uploadersList.indexOf(targetUploader);

                                    if (index !== -1) {
                                        uploadersList.splice(index, 1);
                                        await stateManager.store('uploaders', uploadersList);
                                        const selectedList = await getSelectedUploaders(stateManager);
                                        const newSelected = selectedList.filter((s: string) => s !== targetUploader);
                                        await stateManager.store('uploaders_selected', newSelected);
                                    } else {
                                        throw new Error(`Group "${targetUploader}" is not in the list!`);
                                    }

                                    await stateManager.store('uploader_input', '');
                                }
                            })
                        ]);
                    }
                })
            ]);
            }
        })
    }))
}

// --- HELPERS: TAG BLACKLIST ---
const TAG_CACHE_TTL = 86400000; // 24 hours

export const getCachedTags = async (stateManager: SourceStateManager): Promise<TagCache | null> => {
    const cached = await stateManager.retrieve('tag_cache_v1') as string | null;
    if (!cached) return null;
    try {
        const parsed = JSON.parse(cached) as TagCache;
        if (!parsed.ts || Date.now() - parsed.ts > TAG_CACHE_TTL) return null;
        return parsed;
    } catch { return null; }
}

export const getTagBlacklist = async (stateManager: SourceStateManager): Promise<string[]> => {
    return (await stateManager.retrieve('tag_blacklist') as string[]) ?? [];
}

export const getTagFilterEnabled = async (stateManager: SourceStateManager): Promise<boolean> => {
    return (await stateManager.retrieve('tag_filter_enabled') as boolean) ?? false;
}

export const getTagWhitelistMode = async (stateManager: SourceStateManager): Promise<boolean> => {
    return (await stateManager.retrieve('tag_whitelist_mode') as boolean) ?? false;
}

export const getTagAndMode = async (stateManager: SourceStateManager): Promise<boolean> => {
    return (await stateManager.retrieve('tag_and_mode') as boolean) ?? false;
}

export const getTypeFilter = async (stateManager: SourceStateManager): Promise<string[]> => {
    return (await stateManager.retrieve('type_filter') as string[]) ?? [];
}

// Module-level promise prevents duplicate fetches if the form renders before the first fetch finishes.
let tagCacheWarmUp: Promise<TagCache | null> | null = null;

export const resetTagCacheWarmUp = (): void => {
    tagCacheWarmUp = null;
}

const warmUpTagCache = (stateManager: SourceStateManager, requestManager: RequestManager): Promise<TagCache | null> => {
    if (!tagCacheWarmUp) {
        tagCacheWarmUp = (async (): Promise<TagCache | null> => {
            const existing = await getCachedTags(stateManager);
            if (existing) return existing;

            try {
                const fetchTerms = async (type: string): Promise<APIGenreItem[]> => {
                    const req = App.createRequest({
                        // /tags/search caps at limit=50 in v1; >50 returns 422.
                        url: signUrl(`${API_BASE}/tags/search?type=${type}&limit=50`),
                        method: 'GET',
                    });
                    const res = await requestManager.schedule(req, 1);
                    const json = JSON.parse(res.data ?? '{}') as APIResponse<APIGenreResult>;
                    return Array.isArray(json.result) ? json.result : [];
                };

                // v1 renamed type=theme → type=tag.
                const [genre, theme, format, demographic] = await Promise.all([
                    fetchTerms('genre'),
                    fetchTerms('tag'),
                    fetchTerms('format'),
                    fetchTerms('demographic'),
                ]);

                const cache: TagCache = { genre, theme, format, demographic, ts: Date.now() };
                await stateManager.store('tag_cache_v1', JSON.stringify(cache));
                return cache;
            } catch {
                return null;
            }
        })();
    }
    return tagCacheWarmUp;
}

// --- MENUS: TAG FILTER ---

export const tagFilterSettings = (stateManager: SourceStateManager, requestManager: RequestManager): DUINavigationButton => {
    return keepAlive(App.createDUINavigationButton({
        id: 'tag_filter_settings',
        label: 'Tag Filter',
        form: App.createDUIForm({
            sections: async () => {
                const cache = await warmUpTagCache(stateManager, requestManager);

                if (!cache) {
                    return keepAlive([
                        App.createDUISection({
                            id: 'tag_filter_error',
                            header: 'Tag Filter',
                            footer: 'Failed to load tags. Please close and re-open this menu to retry.',
                            isHidden: false,
                            rows: async () => keepAlive([])
                        })
                    ]);
                }

                const makeSelect = (categoryId: string, label: string, items: APIGenreItem[]) => {
                    const options = items.map(x => String(x.id));
                    const labelMap = new Map(items.map(x => [String(x.id), x.label]));
                    return keepAlive(App.createDUISelect({
                        id: `tag_filter_select_${categoryId}`,
                        label,
                        options,
                        value: App.createDUIBinding({
                            get: async () => {
                                const all = await getTagBlacklist(stateManager);
                                return all.filter(id => options.includes(id));
                            },
                            set: async (newValue: string[]) => {
                                const all = await getTagBlacklist(stateManager);
                                const others = all.filter(id => !options.includes(id));
                                await stateManager.store('tag_blacklist', [...others, ...newValue]);
                            }
                        }),
                        labelResolver: async (value: string) => labelMap.get(value) ?? value,
                        allowsMultiselect: true
                    }));
                };

                return keepAlive([
                    App.createDUISection({
                        id: 'tag_filter_mode',
                        header: 'Tag Filter Settings',
                        footer: 'Blacklist (default): hide titles that match any checked item. Whitelist: show only titles that match. AND Mode: require all checked tags to match instead of any (whitelist mode only — ignored in blacklist mode).',
                        isHidden: false,
                        rows: async () => keepAlive([
                            App.createDUISwitch({
                                id: 'tag_filter_enabled',
                                label: 'Enable Tag Filter',
                                value: App.createDUIBinding({
                                    get: async () => await getTagFilterEnabled(stateManager),
                                    set: async (newValue: boolean) => await stateManager.store('tag_filter_enabled', newValue)
                                })
                            }),
                            App.createDUISwitch({
                                id: 'tag_whitelist_mode',
                                label: 'Enable Whitelist Mode',
                                value: App.createDUIBinding({
                                    get: async () => await getTagWhitelistMode(stateManager),
                                    set: async (newValue: boolean) => await stateManager.store('tag_whitelist_mode', newValue)
                                })
                            }),
                            App.createDUISwitch({
                                id: 'tag_and_mode',
                                label: 'AND Mode',
                                value: App.createDUIBinding({
                                    get: async () => await getTagAndMode(stateManager),
                                    set: async (newValue: boolean) => await stateManager.store('tag_and_mode', newValue)
                                })
                            }),
                            App.createDUILabel({
                                id: 'tag_load_status',
                                label: 'Tag Status',
                                value: 'Loaded',
                            }),
                        ])
                    }),
                    App.createDUISection({
                        id: 'tag_categories',
                        header: 'Tag Categories',
                        footer: 'Checked items will be filtered from Discovery and Search results per the mode above.',
                        isHidden: false,
                        rows: async () => keepAlive([
                            keepAlive(App.createDUISelect({
                                id: 'type_filter_select',
                                label: 'Content Type',
                                options: CONTENT_TYPES.map(x => x.id),
                                value: App.createDUIBinding({
                                    get: async () => await getTypeFilter(stateManager),
                                    set: async (newValue: string[]) => await stateManager.store('type_filter', newValue)
                                }),
                                labelResolver: async (value: string) => CONTENT_TYPES.find(x => x.id === value)?.label ?? value,
                                allowsMultiselect: true
                            })),
                            makeSelect('genre', 'Genres', cache.genre),
                            makeSelect('theme', 'Themes', cache.theme),
                            makeSelect('format', 'Formats', cache.format),
                            makeSelect('demographic', 'Demographics', cache.demographic),
                        ])
                    }),
                ]);
            }
        })
    }));
}

export const resetSettings = (stateManager: SourceStateManager): DUIButton => {
    return keepAlive(App.createDUIButton({
        id: 'reset',
        label: 'Reset All Settings to Default',
        onTap: async () => {
            // Await sequentially to avoid Swift bridge Promise.all flooding race conditions
            await stateManager.store('trending_limit', null);
            await stateManager.store('is_nsfw', null);
            await stateManager.store('content_rating_max', null);
            await stateManager.store('uploaders', null);
            await stateManager.store('uploaders_selected', null);
            await stateManager.store('uploaders_whitelisted', null);
            await stateManager.store('uploaders_toggled', null);
            await stateManager.store('uploader_input', null);
            await stateManager.store('strict_name_matching', null);
            await stateManager.store('tag_cache_v1', null);
            await stateManager.store('tag_blacklist', null);
            await stateManager.store('tag_filter_enabled', null);
            await stateManager.store('tag_whitelist_mode', null);
            await stateManager.store('tag_and_mode', null);
            await stateManager.store('type_filter', null);
            resetTagCacheWarmUp();
        }
    }))
}
