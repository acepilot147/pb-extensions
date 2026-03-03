import {
    DUIButton,
    DUINavigationButton,
    SourceStateManager
} from '@paperback/types'

export const TRENDING_OPTIONS = [
  { id: "1", label: "1 day" },
  { id: "7", label: "7 days" },
  { id: "30", label: "1 month" },
  { id: "90", label: "3 months" },
  { id: "180", label: "6 months" },
  { id: "365", label: "1 Year" },
];

// Helper to get the current state. Defaults to TRUE for backward compatibility.
export const getIsNsfw = async (stateManager: SourceStateManager): Promise<boolean> => {
    const val = await stateManager.retrieve('is_nsfw');
    // If val is null (never set), return true. Otherwise, return the saved boolean.
    return val !== null ? (val as boolean) : true;
}

// Helper to get trending limit. Returns an array of strings per Paperback's DUISelect requirements.
export const getTrendingLimit = async (stateManager: SourceStateManager): Promise<string[]> => {
    const val = await stateManager.retrieve('trending_limit') as string[];
    return val ?? ["30"]; // Default to 1 month
}

export const contentSettings = (stateManager: SourceStateManager): DUINavigationButton => {
    return App.createDUINavigationButton({
        id: 'content_settings',
        label: 'Extension Settings',
        form: App.createDUIForm({
            sections: async () => [
                // 1. Home Page Settings
                App.createDUISection({
                    id: 'home_settings',
                    header: 'Discover Page Settings',
                    footer: 'Adjust the time range for trending media on the Discover page.',
                    isHidden: false,
                    rows: async () => [
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
                    ]
                }),
                // 2. Content Filtering
                App.createDUISection({
                    id: 'nsfw_settings',
                    header: 'Content Filtering',
                    isHidden: false,
                    rows: async () => [
                        App.createDUISwitch({
                            id: 'is_nsfw',
                            label: 'Show NSFW Content',
                            value: App.createDUIBinding({
                                get: async () => await getIsNsfw(stateManager),
                                set: async (newValue) => await stateManager.store('is_nsfw', newValue)
                            })
                        })
                    ]
                })
            ]
        })
    })
}

export const resetSettings = (stateManager: SourceStateManager): DUIButton => {
    return App.createDUIButton({
        id: 'reset',
        label: 'Reset to Default',
        onTap: async () => {
            await stateManager.store('trending_limit', null);
            await stateManager.store('is_nsfw', null);
        }
    })
}