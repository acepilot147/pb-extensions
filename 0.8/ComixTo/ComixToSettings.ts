import {
    createDUIBinding,
    createDUIForm,
    createDUINavigationButton,
    createDUISection,
    createDUISwitch,
    createDUIInputField,
    createDUIButton,
    createDUISelect,
    DUINavigationButton,
    SourceStateManager,
    DUISection,
    DUIButton
} from 'paperback-extensions-common';

// --- Stability Utilities ---
const uiKeepAlive: any[] = [];
const keepAlive = <T>(obj: T): T => {
    uiKeepAlive.push(obj);
    return obj;
};

let settingsWarmUp: Promise<void> | null = null;
const warmUpSettings = (stateManager: SourceStateManager) => {
    if (!settingsWarmUp) {
        settingsWarmUp = (async () => {
            await stateManager.retrieve('uploaders');
            await stateManager.retrieve('uploader_input');
        })();
    }
    return settingsWarmUp;
};

export const DEFAULT_SETTINGS = {
    show_volume_number: false,
    show_title: false,
    show_uploader: false,
    is_nsfw: true,
    trending_limit: ['30'] as string[],
    remove_duplicates: true,
    one_version_only: false,
    uploaders: [] as string[],
    uploaders_selected: [] as string[],
    uploader_input: '',
    uploaders_enabled: false,
    uploaders_whitelist: false,
    uploaders_strict: false
};

export const getSetting = async <K extends keyof typeof DEFAULT_SETTINGS>(
    stateManager: SourceStateManager,
    key: K
): Promise<typeof DEFAULT_SETTINGS[K]> => {
    const val = await stateManager.retrieve(key);
    return val !== null ? (val as typeof DEFAULT_SETTINGS[K]) : DEFAULT_SETTINGS[key];
};

export const getFilters = async (stateManager: SourceStateManager) => {
    return {
        showVolume: await getSetting(stateManager, 'show_volume_number'),
        showTitle: await getSetting(stateManager, 'show_title'),
        showUploader: await getSetting(stateManager, 'show_uploader'),
        uploaders: {
            enabled: await getSetting(stateManager, 'uploaders_enabled'),
            whitelist: await getSetting(stateManager, 'uploaders_whitelist'),
            strict: await getSetting(stateManager, 'uploaders_strict'),
            list: await getSetting(stateManager, 'uploaders_selected')
        },
        oneVersionOnly: await getSetting(stateManager, 'one_version_only'),
        removeDuplicates: await getSetting(stateManager, 'remove_duplicates')
    };
};

export const chapterSettings = (stateManager: SourceStateManager): DUINavigationButton => {
    return keepAlive(createDUINavigationButton({
        id: 'chapter_settings',
        label: 'Chapter Display Settings',
        form: createDUIForm({
            sections: async () => [
                createDUISection({
                    id: 'contentchapter',
                    header: 'Chapter Display',
                    isHidden: false,
                    rows: async () => [
                        createDUISwitch({
                            id: 'show_volume_number',
                            label: 'Show Chapter Volume',
                            value: createDUIBinding({
                                get: async () => await getSetting(stateManager, 'show_volume_number'),
                                set: async (newValue: boolean) => await stateManager.store('show_volume_number', newValue)
                            })
                        }),
                        createDUISwitch({
                            id: 'show_title',
                            label: 'Show Chapter Title',
                            value: createDUIBinding({
                                get: async () => await getSetting(stateManager, 'show_title'),
                                set: async (newValue: boolean) => await stateManager.store('show_title', newValue)
                            })
                        }),
                        createDUISwitch({
                            id: 'show_uploader',
                            label: 'Show Uploader',
                            value: createDUIBinding({
                                get: async () => await getSetting(stateManager, 'show_uploader'),
                                set: async (newValue: boolean) => await stateManager.store('show_uploader', newValue)
                            })
                        })
                    ]
                })
            ]
        })
    }));
};

const createDynamicListSection = (
    stateManager: SourceStateManager,
    id: string,
    header: string,
    listKey: keyof typeof DEFAULT_SETTINGS,
    selectedKey: keyof typeof DEFAULT_SETTINGS,
    inputKey: keyof typeof DEFAULT_SETTINGS,
    filterToggleKey: keyof typeof DEFAULT_SETTINGS,
    whitelistToggleKey: keyof typeof DEFAULT_SETTINGS,
    strictToggleKey: keyof typeof DEFAULT_SETTINGS
): DUISection => {
    return createDUISection({
        id: id,
        header: header,
        isHidden: false,
        rows: async () => {
            const masterList = await getSetting(stateManager, listKey) as string[];
            return [
                createDUISwitch({
                    id: `${id}_filter_toggle`,
                    label: `Enable ${header} Filtering`,
                    value: createDUIBinding({
                        get: async () => await getSetting(stateManager, filterToggleKey) as boolean,
                        set: async (newValue: boolean) => await stateManager.store(filterToggleKey, newValue)
                    })
                }),
                createDUISwitch({
                    id: `${id}_whitelist_toggle`,
                    label: 'Enable Whitelist Mode',
                    value: createDUIBinding({
                        get: async () => await getSetting(stateManager, whitelistToggleKey) as boolean,
                        set: async (newValue: boolean) => await stateManager.store(whitelistToggleKey, newValue)
                    })
                }),
                createDUISwitch({
                    id: `${id}_strict_toggle`,
                    label: 'Strict Matching',
                    value: createDUIBinding({
                        get: async () => await getSetting(stateManager, strictToggleKey) as boolean,
                        set: async (newValue: boolean) => await stateManager.store(strictToggleKey, newValue)
                    })
                }),
                createDUISelect({
                    id: `${id}_select`,
                    label: `Selected ${header}`,
                    options: masterList,
                    value: createDUIBinding({
                        get: async () => await getSetting(stateManager, selectedKey) as string[],
                        set: async (newValue: string[]) => await stateManager.store(selectedKey, newValue)
                    }),
                    allowsMultiselect: true,
                    labelResolver: async (val: string) => val
                }),
                createDUIInputField({
                    id: `${id}_input`,
                    label: 'Name (Comma-separated)',
                    value: createDUIBinding({
                        get: async () => await getSetting(stateManager, inputKey) as string,
                        set: async (newValue: string) => await stateManager.store(inputKey, newValue)
                    })
                }),
                createDUIButton({
                    id: `${id}_add`,
                    label: 'Add to List',
                    onTap: async () => {
                        const val = await getSetting(stateManager, inputKey) as string;
                        if (!val || val.trim() === '') return;
                        const newItems = val.split(',').map(s => s.trim()).filter(s => s !== '');
                        let list = await getSetting(stateManager, listKey) as string[];
                        let selected = await getSetting(stateManager, selectedKey) as string[];
                        let changed = false;
                        for (const item of newItems) {
                            if (!list.includes(item)) {
                                list.push(item);
                                changed = true;
                            }
                            if (!selected.includes(item)) {
                                selected.push(item);
                                changed = true;
                            }
                        }
                        if (changed) {
                            await stateManager.store(listKey, list);
                            await stateManager.store(selectedKey, selected);
                        }
                        await stateManager.store(inputKey, '');
                    }
                }),
                createDUIButton({
                    id: `${id}_remove`,
                    label: 'Remove from List',
                    onTap: async () => {
                        const val = await getSetting(stateManager, inputKey) as string;
                        if (!val || val.trim() === '') return;
                        const removeItems = val.split(',').map(s => s.trim()).filter(s => s !== '');
                        let list = await getSetting(stateManager, listKey) as string[];
                        let selected = await getSetting(stateManager, selectedKey) as string[];
                        
                        list = list.filter(item => !removeItems.includes(item));
                        selected = selected.filter(item => !removeItems.includes(item));
                        
                        await stateManager.store(listKey, list);
                        await stateManager.store(selectedKey, selected);
                        await stateManager.store(inputKey, '');
                    }
                })
            ];
        }
    });
};

export const contentSettings = (stateManager: SourceStateManager, requestManager?: any): DUINavigationButton => {
    return keepAlive(createDUINavigationButton({
        id: 'content_settings',
        label: 'Extension Settings',
        form: createDUIForm({
            sections: async () => {
                await warmUpSettings(stateManager);
                return [
                    createDynamicListSection(stateManager, 'uploaders', 'Uploaders', 'uploaders', 'uploaders_selected', 'uploader_input', 'uploaders_enabled', 'uploaders_whitelist', 'uploaders_strict'),
                    createDUISection({
                        id: 'nsfw_settings',
                        header: 'Content Filtering',
                        rows: async () => [
                            createDUISwitch({
                                id: 'is_nsfw',
                                label: 'Show NSFW Content',
                                value: createDUIBinding({
                                    get: async () => await getSetting(stateManager, 'is_nsfw'),
                                    set: async (newValue: boolean) => await stateManager.store('is_nsfw', newValue)
                                })
                            })
                        ]
                    }),
                    createDUISection({
                        id: 'home_settings',
                        header: 'Discover Page Settings',
                        rows: async () => [
                            createDUISelect({
                                id: 'trending_limit',
                                label: 'Trending Timeframe',
                                options: ['1', '7', '30', '90', '180', '365'],
                                value: createDUIBinding({
                                    get: async () => await getSetting(stateManager, 'trending_limit'),
                                    set: async (newValue: string[]) => await stateManager.store('trending_limit', newValue)
                                }),
                                allowsMultiselect: false,
                                labelResolver: async (value: string) => {
                                    const labels: any = { '1': '1 day', '7': '7 days', '30': '1 month', '90': '3 months', '180': '6 months', '365': '1 year' };
                                    return labels[value] || value;
                                }
                            })
                        ]
                    }),
                    createDUISection({
                        id: 'general_settings',
                        header: 'Advanced Chapter Filtering',
                        rows: async () => [
                            createDUISwitch({
                                id: 'one_version_only',
                                label: 'Always Only Show 1 Source',
                                value: createDUIBinding({
                                    get: async () => await getSetting(stateManager, 'one_version_only'),
                                    set: async (newValue: boolean) => await stateManager.store('one_version_only', newValue)
                                })
                            }),
                            createDUISwitch({
                                id: 'remove_duplicates',
                                label: 'Remove Duplicate Chapters',
                                value: createDUIBinding({
                                    get: async () => await getSetting(stateManager, 'remove_duplicates'),
                                    set: async (newValue: boolean) => await stateManager.store('remove_duplicates', newValue)
                                })
                            })
                        ]
                    }),
                    createDUISection({
                        id: 'network_settings',
                        header: 'Network Settings',
                        rows: async () => [
                            createDUIButton({
                                id: 'cf_bypass_trigger',
                                label: 'Manually Trigger Cloudflare Bypass',
                                onTap: async () => {
                                    if (requestManager) {
                                        // createRequestObject is not imported here but available globally usually, wait we should import it or use a callback
                                        // Actually since we don't have createRequestObject imported here we can just throw to force it
                                        throw new Error("Cloudflare Bypass Required");
                                    }
                                }
                            })
                        ]
                    })
                ];
            }
        })
    }));
};

export const resetSettings = (stateManager: SourceStateManager): DUIButton => {
    return createDUIButton({
        id: 'reset',
        label: 'Reset All Settings',
        onTap: async () => {
            const promises = Object.keys(DEFAULT_SETTINGS).map(key => stateManager.store(key, null));
            await Promise.all(promises);
        }
    });
};
