import { DUIButton, SourceStateManager } from "@paperback/types";

export const resetSettings = (stateManager: SourceStateManager): DUIButton => {
  return App.createDUIButton({
    id: "reset",
    label: "Reset to Default",
    onTap: async () => {
      await stateManager.store("trending_limit", null);
    },
  });
};
