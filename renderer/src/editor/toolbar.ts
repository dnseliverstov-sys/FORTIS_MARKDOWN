import {defaultPreset} from '@gravity-ui/markdown-editor/_/modules/toolbars/presets.js';
import {ToolbarName} from '@gravity-ui/markdown-editor/_/modules/toolbars/constants.js';
import type {ToolbarsPreset} from '@gravity-ui/markdown-editor';

// Let Gravity's responsive toolbar move actions into overflow only when needed.
export const fortisToolbar: ToolbarsPreset = {
  ...defaultPreset,
  orders: {
    ...defaultPreset.orders,
    [ToolbarName.wysiwygMain]: [...defaultPreset.orders.wysiwygMain!, ...defaultPreset.orders.wysiwygHidden!],
    [ToolbarName.markupMain]: [...defaultPreset.orders.markupMain!, ...defaultPreset.orders.markupHidden!],
    [ToolbarName.wysiwygHidden]: [],
    [ToolbarName.markupHidden]: [],
  },
};
