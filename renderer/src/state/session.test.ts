import {describe, expect, it} from 'vitest';
import {applyUserDocumentChange, createTab, markDocumentSaved, migrateSession} from './session';

describe('session migration', () => {
  it('hides the document panel once and then remembers the user choice', () => {
    const first = migrateSession({version: 2, tabs: [], settings: {theme: 'paper', docPanelVisible: true}});
    expect(first.settings.docPanelVisible).toBe(false);
    expect(first.settings.theme).toBe('paper');
    first.settings.docPanelVisible = true;
    expect(migrateSession(first).settings.docPanelVisible).toBe(true);
    expect(migrateSession(null).settings.docPanelVisible).toBe(false);
    expect(migrateSession(first).tabs).toEqual([]);
  });
  it('converts legacy split mode to markup with preview while retaining settings', () => {
    const session = migrateSession({
      tabs: [{id: 7, name: 'legacy.md', md: '# Старый файл\r\n', dirty: true}],
      active: 7,
      mode: 'split',
      theme: 'paper',
      jiraBase: 'https://jira.example',
      keys: {openws: 'Alt+O', saveas: 'Alt+S', docpanel: 'Alt+J'},
      tbIds: ['new', 'openws', 'saveas', 'docpanel'],
    });
    expect(session.version).toBe(2);
    expect(session.settings.viewMode).toBe('split');
    expect(session.settings.theme).toBe('paper');
    expect(session.activeId).toBe('legacy-7');
    expect(session.tabs[0].markdown).toBe('# Старый файл\r\n');
    expect(session.tabs[0].dirty).toBe(true);
    expect(session.tabs[0].savedMarkdown).toBe('');
    expect(session.settings.shortcuts).toMatchObject({openWorkspace: 'Alt+O', saveAs: 'Alt+S', docPanel: 'Alt+J'});
    expect(session.settings.toolbarCommands).toEqual(['new', 'openWorkspace', 'saveAs', 'docPanel']);
  });

  it('retains the active legacy tab when ids were already strings', () => {
    const session = migrateSession({
      tabs: [{id: 'one', name: 'one.md', md: ''}, {id: 'two', name: 'two.md', md: '# two'}],
      active: 'two',
    });
    expect(session.activeId).toBe('two');
  });
});

describe('document dirty state', () => {
  it('does not dirty an untouched document and marks only a real user change', () => {
    const tab = createTab('exact.md', '# Текст\r\n');
    expect(tab.dirty).toBe(false);
    const same = applyUserDocumentChange(tab, tab.markdown);
    expect(same.dirty).toBe(false);
    const edited = applyUserDocumentChange(tab, '# Новый текст\n');
    expect(edited.dirty).toBe(true);
    expect(markDocumentSaved(edited, 42)).toMatchObject({dirty: false, touched: false, savedAt: 42, savedMarkdown: '# Новый текст\n'});
  });
});
