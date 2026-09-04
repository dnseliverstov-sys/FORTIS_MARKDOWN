import type {DocumentTab, FortisSession} from '../types';
import {AUTOSAVE_KEY, createTab, EXIT_KEY} from './session';

export interface RecoveryTab {
  id?: string;
  name: string;
  md: string;
  savedMarkdown?: string;
  handleKey?: string;
  savedAt?: number;
  isDraft?: boolean;
}

export interface Recovery {
  version: 2;
  ts: number;
  tabs: RecoveryTab[];
}

export function parseRecovery(raw: string | null): Recovery | null {
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || !Array.isArray(value.tabs) || !Number.isFinite(value.ts)) return null;
    const tabs: RecoveryTab[] = value.tabs.filter((tab: unknown) => tab && typeof tab === 'object'
      && typeof (tab as RecoveryTab).name === 'string' && typeof (tab as RecoveryTab).md === 'string')
      .map((tab: RecoveryTab) => ({
        name: tab.name, md: tab.md,
        id: typeof tab.id === 'string' ? tab.id : undefined,
        savedMarkdown: typeof tab.savedMarkdown === 'string' ? tab.savedMarkdown : undefined,
        handleKey: typeof tab.handleKey === 'string' ? tab.handleKey : undefined,
        savedAt: typeof tab.savedAt === 'number' ? tab.savedAt : undefined,
        isDraft: typeof tab.isDraft === 'boolean' ? tab.isDraft : undefined,
      }));
    return tabs.length ? {version: 2, ts: value.ts, tabs} : null;
  } catch { return null; }
}

export function readCrashRecovery(): Recovery | null {
  try {
    return localStorage.getItem(EXIT_KEY) === 'ok' ? null : parseRecovery(localStorage.getItem(AUTOSAVE_KEY));
  } catch { return null; }
}

export function recoveryFor(session: FortisSession, ts = Date.now()): Recovery | null {
  const tabs = session.tabs.filter((tab) => tab.dirty).map((tab) => ({
    name: tab.name, md: tab.markdown, id: tab.id, savedMarkdown: tab.savedMarkdown,
    handleKey: tab.handleKey, savedAt: tab.savedAt, isDraft: tab.isDraft,
  }));
  return tabs.length ? {version: 2, ts, tabs} : null;
}

export function persistRecovery(session: FortisSession): void {
  const next = recoveryFor(session);
  if (!next) { localStorage.removeItem(AUTOSAVE_KEY); return; }
  const previous = parseRecovery(localStorage.getItem(AUTOSAVE_KEY));
  // Keep the date of the last content change, not the last timer tick.
  if (previous && JSON.stringify(previous.tabs) === JSON.stringify(next.tabs)) return;
  localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(next));
}

function findTab(tabs: DocumentTab[], draft: RecoveryTab): DocumentTab | undefined {
  if (draft.id) {
    const byId = tabs.find((tab) => tab.id === draft.id);
    if (byId) return byId;
  }
  if (draft.handleKey) return tabs.find((tab) => tab.handleKey === draft.handleKey);
  if (draft.id) return undefined;
  const matches = tabs.filter((tab) => tab.name === draft.name);
  return matches.length === 1 ? matches[0] : undefined;
}

function withTabs(session: FortisSession, tabs: DocumentTab[]): FortisSession {
  return {...session, tabs, activeId: tabs.some((tab) => tab.id === session.activeId) ? session.activeId : tabs[0]?.id || null};
}

function discardTab(tab: DocumentTab): DocumentTab[] {
  const isDraft = tab.isDraft ?? (!tab.handleKey && !tab.savedAt && tab.savedMarkdown === '');
  if (isDraft) return [];
  return [{...tab, markdown: tab.savedMarkdown, dirty: false, touched: false, revision: tab.revision + 1}];
}

export function discardChanges(session: FortisSession): FortisSession {
  return withTabs(session, session.tabs.flatMap((tab) => tab.dirty ? discardTab(tab) : [tab]));
}

export function resolveRecovery(session: FortisSession, recovery: Recovery, restore: boolean): FortisSession {
  let tabs = [...session.tabs];
  for (const draft of recovery.tabs) {
    const existing = findTab(tabs, draft);
    if (!restore) {
      if (existing) tabs = tabs.flatMap((tab) => tab.id === existing.id ? discardTab(tab) : [tab]);
      else if (!draft.id && !draft.handleKey) {
        // Legacy backups only recorded names. Declining all entries with that
        // name must also clear their dirty session copies, including duplicates.
        tabs = tabs.flatMap((tab) => tab.name === draft.name && tab.dirty ? discardTab(tab) : [tab]);
      }
      continue;
    }
    const baseline = draft.savedMarkdown ?? existing?.savedMarkdown ?? '';
    const recovered: DocumentTab = {
      ...(existing || createTab(draft.name)),
      ...(existing ? {} : {id: draft.id || crypto.randomUUID()}),
      name: draft.name, markdown: draft.md, savedMarkdown: baseline,
      handleKey: draft.handleKey ?? existing?.handleKey,
      savedAt: draft.savedAt ?? existing?.savedAt,
      isDraft: draft.isDraft ?? existing?.isDraft ?? (!draft.handleKey && !draft.savedAt),
      dirty: draft.md !== baseline || Boolean(draft.isDraft), touched: true,
      revision: (existing?.revision || 0) + 1,
    };
    if (existing) tabs = tabs.map((tab) => tab.id === existing.id ? recovered : tab);
    else tabs.push(recovered);
  }
  const result = withTabs(session, tabs);
  if (restore) result.activeId = findTab(tabs, recovery.tabs[0])?.id || tabs.at(-1)?.id || result.activeId;
  return result;
}
