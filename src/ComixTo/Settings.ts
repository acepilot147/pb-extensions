import {
    DUIButton,
    DUINavigationButton,
    SourceStateManager
} from '@paperback/types'

// Helper to get the current state. Defaults to TRUE for backward compatibility.
export const getIsNsfw = async (stateManager: SourceStateManager): Promise<boolean> => {
    const val = await stateManager.retrieve('is_nsfw');
    // If val is null (never set), return true. Otherwise, return the saved boolean.
    return val !== null ? (val as boolean) : true;
}

export const contentSettings = (stateManager: SourceStateManager): DUINavigationButton => {
    return App.createDUINavigationButton({
        id: 'content_settings',
        label: 'Content Settings',
        form: App.createDUIForm({
            sections: async () => [
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
            await stateManager.store('is_nsfw', null); // Reset NSFW toggle
        }
    })
}