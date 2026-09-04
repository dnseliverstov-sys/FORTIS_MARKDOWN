import {beforeEach, describe, expect, it} from 'vitest';
import {AUTOSAVE_KEY, createTab, migrateSession} from './session';
import {discardChanges, parseRecovery, persistRecovery, recoveryFor, resolveRecovery} from './recovery';

beforeEach(() => localStorage.clear());

describe('draft recovery', () => {
  it('rejects a snapshot once, rolls back saved files and removes new drafts', () => {
    const session = migrateSession(null);
    const file = {...createTab('file.md', '# saved\r\n'), markdown: '# changed', dirty: true, touched: true, handleKey: 'workspace:a/file.md'};
    const draft = {...createTab('new.md', '# draft', true), savedMarkdown: ''};
    session.tabs = [file, draft];
    session.activeId = draft.id;
    const recovery = recoveryFor(session)!;
    expect(recovery.tabs[0]).toMatchObject({id: file.id, savedMarkdown: '# saved\r\n', handleKey: file.handleKey});
    const rejected = resolveRecovery(session, recovery, false);
    expect(rejected.tabs).toHaveLength(1);
    expect(rejected.tabs[0]).toMatchObject({markdown: '# saved\r\n', dirty: false, touched: false});
    persistRecovery(rejected);
    expect(localStorage.getItem(AUTOSAVE_KEY)).toBeNull();
    expect(recoveryFor(migrateSession(rejected))).toBeNull();
    expect(recoveryFor(migrateSession(migrateSession(rejected)))).toBeNull();
  });

  it('matches duplicate names by identity and restores without duplicates', () => {
    const session = migrateSession(null);
    session.tabs = [createTab('same.md', 'one'), createTab('same.md', 'two')];
    session.tabs[0] = {...session.tabs[0], handleKey: 'a/same.md', dirty: true, markdown: 'edited'};
    const recovery = recoveryFor(session)!;
    const restored = resolveRecovery(session, recovery, true);
    expect(restored.tabs.map((tab) => tab.markdown)).toEqual(['edited', 'two']);
    expect(resolveRecovery(restored, recovery, true).tabs).toHaveLength(2);
    const legacy = parseRecovery(JSON.stringify({ts: 1, tabs: [{name: 'same.md', md: 'legacy'}]}))!;
    expect(resolveRecovery(session, legacy, true).tabs.map((tab) => tab.markdown)).toEqual(['edited', 'two', 'legacy']);
  });

  it('discards dirty drafts when closing but keeps clean tabs and settings', () => {
    const session = migrateSession(null);
    session.tabs.push({...createTab('draft.md', 'draft', true), savedMarkdown: ''});
    expect(discardChanges(session).tabs).toEqual([session.tabs[0]]);
    expect(discardChanges(session).settings).toEqual(session.settings);
  });

  it('declines legacy duplicate names without recreating their backup', () => {
    const session = migrateSession(null);
    session.tabs = [
      {...createTab('same.md', 'first saved'), markdown: 'first draft', dirty: true},
      {...createTab('same.md', 'second saved'), markdown: 'second draft', dirty: true},
    ];
    const backup = parseRecovery(JSON.stringify({ts: 1, tabs: [
      {name: 'same.md', md: 'first draft'}, {name: 'same.md', md: 'second draft'},
    ]}))!;
    const next = resolveRecovery(session, backup, false);
    expect(next.tabs.map((tab) => tab.markdown)).toEqual(['first saved', 'second saved']);
    expect(recoveryFor(next)).toBeNull();
  });

  it('does not renew the recovery timestamp without a content change', () => {
    const session = migrateSession(null);
    session.tabs = [createTab('draft.md', 'draft', true)];
    const snapshot = recoveryFor(session, 123)!;
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(snapshot));
    persistRecovery(session);
    expect(parseRecovery(localStorage.getItem(AUTOSAVE_KEY))?.ts).toBe(123);
  });

  it('ignores invalid storage and retains a valid legacy snapshot', () => {
    expect(parseRecovery('{broken')).toBeNull();
    expect(parseRecovery('{"ts":1,"tabs":[null,{}]}')).toBeNull();
    expect(parseRecovery('{"ts":1,"tabs":[{"name":"old.md","md":"content"}]}')?.tabs[0].md).toBe('content');
  });
});
