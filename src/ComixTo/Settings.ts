import {
    DUIButton,
    DUINavigationButton,
    SourceStateManager
} from '@paperback/types'

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
// Prevents concurrent stateManager reads during cold start, and avoids piling up retrieves on spam presses.
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

// --- HELPERS: DISCOVER & NSFW ---
export const getIsNsfw = async (stateManager: SourceStateManager): Promise<boolean> => {
    const val = await stateManager.retrieve('is_nsfw');
    return val !== null ? (val as boolean) : true;
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
                    id: 'nsfw_settings',
                    header: 'Content Filtering',
                    isHidden: false,
                    rows: async () => keepAlive([
                        App.createDUISwitch({
                            id: 'is_nsfw',
                            label: 'Show NSFW Content',
                            value: App.createDUIBinding({
                                get: async () => await getIsNsfw(stateManager),
                                set: async (newValue) => await stateManager.store('is_nsfw', newValue)
                            })
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
                                    await stateManager.store('uploader_input', ''); // Bypass the binding, update state directly
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

                                    await stateManager.store('uploader_input', ''); // Bypass the binding, update state directly
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

export const resetSettings = (stateManager: SourceStateManager): DUIButton => {
    return keepAlive(App.createDUIButton({
        id: 'reset',
        label: 'Reset All Settings to Default',
        onTap: async () => {
            // Await sequentially to avoid Swift bridge Promise.all flooding race conditions
            await stateManager.store('trending_limit', null);
            await stateManager.store('is_nsfw', null);
            await stateManager.store('uploaders', null);
            await stateManager.store('uploaders_selected', null);
            await stateManager.store('uploaders_whitelisted', null);
            await stateManager.store('uploaders_toggled', null);
            await stateManager.store('uploader_input', null);
            await stateManager.store('strict_name_matching', null);
        }
    }))
}