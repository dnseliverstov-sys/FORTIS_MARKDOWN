declare module 'turndown-plugin-gfm' {
  import type TurndownService from 'turndown';
  export const gfm: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
}

declare module '@diplodoc/latex-extension/runtime/styles';
declare module 'github-slugger' {
  export default class GithubSlugger {
    slug(value: string, maintainCase?: boolean): string;
    reset(): void;
  }
}
