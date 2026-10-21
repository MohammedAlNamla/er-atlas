import { store, initStore } from './storage.js';
import { openDialog, initOverlays } from './ui.js';
import { $, state, WORKSPACES_KEY, activeWorkspace, saveWorkspaces, storageKey, DIALOG_ICONS, headerIcon, confirmAction, copyText, showToast } from './core.js';
import { applyTheme, currentTheme, cycleTheme, closeHeaderMenus, scheduleFitChrome, setNavbarSearch } from './chrome.js';
import { closeWorkspaceMenu, toggleWorkspaceMenu, activateWorkspace, openWorkspaceDialog, sampleSchema, exportWorkspace, importWorkspace, deleteWorkspace, migrateLegacySufra, sameConnection, submitWorkspace } from './workspaces.js';
import { renderTopics, renderView, setViewMode, locateTable } from './views.js';
import { buildTopicPositions, snap4, savePositions, openArrangement, applyArrangement, arrangeWithAi } from './layout.js';
import { renderNodes, rankedSearch, updateSearchCount, updateEmphasis, transform, fitView, zoom, selectTable, selectRelation } from './canvas.js';
import { renderEdges, updateEdgesForTable, canvasRelationAt } from './edges.js';
import { closeContextMenu, showContextMenu, saveDraft, refreshDraft, stepDraft, openEditor, submitEdit, reviewDraft, sendPlanToAi } from './editor.js';
import { buildGroups, topicKey, renderTopicEditor, refreshTopics, syncCodeSource, saveCodeSource, loadCodeSettings, analyzeTopicCode, openCodeDialog, suggestTopics } from './groups.js';
import { renderAiMessages, autosizeComposer, sendAiQuestion, saveAiMessages, openAiConversation } from './chat.js';
import { updateAiSettings, loadLocalAiStatus, testAiConnection, restoreAiSettings, changeProvider } from './ai.js';
import { openLint, openExport } from './sheets.js';
import { openShortcuts, openQuickActions, filterQuickActions } from './commands.js';
import { resetDatabaseList, renderDatabaseList, browseDatabases, openConnectionDialog, fillFromEnv, openDemo, refreshSchema, submitConnection } from './connect.js';
function installEvents() {
  initOverlays();
  for (const [id, name] of Object.entries(DIALOG_ICONS)) { const header = $(id)?.querySelector('.modal-header'); if (header) headerIcon(header, name); }
  document.fonts?.ready.then(scheduleFitChrome);
  const viewport = $('viewport');
  $('relationshipDialog').addEventListener('close', () => { state.selectedRelation = null; updateEmphasis(); });
  for (const [trigger, menu] of [['toolsButton', 'toolsMenu'], ['aiMenuButton', 'aiMenu'], ['topicSwitchButton', 'topics']]) {
    $(trigger).addEventListener('click', () => {
      const open = $(menu).hidden; closeHeaderMenus(); closeWorkspaceMenu();
      $(menu).hidden = !open; $(trigger).setAttribute('aria-expanded', String(open));
      if (open) $(menu).querySelector('button')?.focus();
    });
    $(menu).addEventListener('click', event => { if (event.target.closest('button')) closeHeaderMenus(); });
    $(menu).addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape'].includes(event.key)) return;
      event.preventDefault(); if (event.key === 'Escape') { closeHeaderMenus(); $(trigger).focus(); return; }
      const items = [...$(menu).querySelectorAll('button:not(:disabled)')], index = items.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    });
  }
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.header-menu,.topic-switcher')) closeHeaderMenus(); });
  $('aiSettingsButton').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('aiProviderChip').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('arrangeSettingsButton').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('saveAiSettingsButton').addEventListener('click', () => { updateAiSettings({ save: true }); $('aiSettingsDialog').close(); });
  $('codeSourceButton').addEventListener('click', openCodeDialog); $('topicAnalysisButton').addEventListener('click', openCodeDialog);
  $('selectionModeButton').addEventListener('click', () => {
    state.linkMode = false; state.linkSource = null;
    $('selectionModeButton').setAttribute('aria-pressed', 'true'); renderNodes(); showToast('اختر جدولًا أو علاقة لعرض التفاصيل');
  });
  $('quickActionsButton').addEventListener('click', openQuickActions);
  $('lintButton').addEventListener('click', openLint);
  $('exportButton').addEventListener('click', () => openExport());
  $('themeButton').addEventListener('click', cycleTheme);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (currentTheme() === 'auto') applyTheme('auto'); });
  $('quickSearch').addEventListener('input', event => filterQuickActions(event.target.value));
  const visibleCommands = () => [...$('quickActionList').querySelectorAll('.quick-command')].filter(item => !item.hidden);
  $('quickSearch').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); visibleCommands()[0]?.click(); }
    if (event.key === 'ArrowDown') { event.preventDefault(); visibleCommands()[0]?.focus(); }
  });
  $('quickActionList').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const items = visibleCommands(), index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowUp' && index <= 0) $('quickSearch').focus();
    else items[Math.max(0, Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  });
  $('applyArrangementButton').addEventListener('click', () => {
    if (!state.arrangement?.proposed) { arrangeWithAi(); return; }
    if (applyArrangement()) $('arrangeDialog').close();
  });
  $('stopArrangementButton').addEventListener('click', () => state.layoutController?.abort());
  $('arrangeDialog').addEventListener('close', () => { state.layoutController?.abort(); });
  $('stopAiButton').addEventListener('click', () => state.aiController?.abort());
  $('discardDraftButton').addEventListener('click', () => confirmAction('تجاهل المسودة؟', `سيُزال ${state.cursor} تغييرات مقترحة من هذه المساحة.`, 'سيعود المخطط إلى التعريف الأصلي. لا تتغير قاعدة البيانات.', () => {
    state.operations = []; state.cursor = 0; saveDraft(); refreshDraft(); showToast('تم تجاهل المسودة');
  }, 'تجاهل المسودة'));
  $('backTopicsButton').addEventListener('click', () => {
    state.topic = 'all'; activeWorkspace().topic = 'all'; saveWorkspaces();
    buildTopicPositions(); renderTopics(); renderView(); renderNodes(); fitView(false);
  });
  $('chooseFocusButton').addEventListener('click', () => {
    state.focusTable = null; state.focusPositions = null;
    renderView(); renderNodes(); fitView(false);
    $('viewOverlay').querySelector('input')?.focus();
  });
  $('workspaceSwitchButton').addEventListener('click', toggleWorkspaceMenu);
  document.addEventListener('pointerdown', event => { if (!event.target.closest('.workspace-switcher')) closeWorkspaceMenu(); });
  $('newWorkspaceButton').addEventListener('click', () => openWorkspaceDialog());
  $('renameWorkspaceButton').addEventListener('click', () => openWorkspaceDialog(true));
  $('exportWorkspaceButton').addEventListener('click', exportWorkspace);
  $('importWorkspaceButton').addEventListener('click', importWorkspace);
  $('deleteWorkspaceButton').addEventListener('click', deleteWorkspace);
  $('envConnectionButton').addEventListener('click', fillFromEnv);
  $('closeWorkspaceDialog').addEventListener('click', () => $('workspaceDialog').close());
  $('workspaceForm').addEventListener('submit', submitWorkspace);
  $('emptyPrimaryButton').addEventListener('click', () => activeWorkspace()?.kind === 'ideas' ? openEditor('addTable') : openConnectionDialog());
  $('emptyAiButton').addEventListener('click', openAiConversation);
  $('addTableButton').addEventListener('click', () => openEditor('addTable'));
  $('viewTabs').addEventListener('click', event => { const view = event.target.closest('.seg')?.dataset.view; if (view) setViewMode(view); });
  $('linkModeButton').addEventListener('click', () => {
    openEditor('addRelation');
  });
  $('changesButton').addEventListener('click', () => openDialog($('changesPanel')));
  $('closeChanges').addEventListener('click', () => $('changesPanel').close());
  $('undoButton').addEventListener('click', () => stepDraft(-1));
  $('undoQuick').addEventListener('click', () => stepDraft(-1));
  $('redoQuick').addEventListener('click', () => stepDraft(1));
  $('helpButton').addEventListener('click', openShortcuts);
  $('redoButton').addEventListener('click', () => stepDraft(1));
  $('closeEditDialog').addEventListener('click', () => $('editDialog').close());
  $('editForm').addEventListener('submit', submitEdit);
  $('topicManageButton').addEventListener('click', () => {
    syncCodeSource(); renderTopicEditor(); updateAiSettings(); loadLocalAiStatus(); $('topicsDialog').showModal();
  });
  $('topicSourceRoot').addEventListener('change', () => { saveCodeSource(); syncCodeSource(); });
  $('analyzeTopicCodeButton').addEventListener('click', analyzeTopicCode);
  loadCodeSettings();
  $('closeTopicsDialog').addEventListener('click', () => $('topicsDialog').close());
  $('resetTopicsButton').addEventListener('click', () => {
    state.customGroups = null; store.removeItem(topicKey()); buildGroups();
    refreshTopics(); renderTopicEditor(); showToast('تمت استعادة التقسيم التلقائي');
  });
  $('topicAiSettingsButton').addEventListener('click', () => openDialog($('aiSettingsDialog')));
  $('aiButton').addEventListener('click', openAiConversation);
  $('aiArrangeButton').addEventListener('click', () => openArrangement('ai'));
  $('closeAiDialog').addEventListener('click', () => $('aiDialog').close());
  $('clearAiButton').addEventListener('click', () => {
    if (state.aiController || !state.aiMessages.length) return;
    state.aiMessages = []; saveAiMessages(); renderAiMessages(); $('aiQuestion').focus();
  });
  restoreAiSettings();
  updateAiSettings(); loadLocalAiStatus();
  $('aiProvider').addEventListener('change', changeProvider);
  $('aiModel').addEventListener('change', () => updateAiSettings({ save: true }));
  $('aiEndpoint').addEventListener('change', () => updateAiSettings({ save: true }));
  $('aiForm').addEventListener('submit', event => { event.preventDefault(); sendAiQuestion(); });
  $('aiQuestion').addEventListener('input', autosizeComposer);
  $('aiQuestion').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!state.aiController) sendAiQuestion(); }
  });
  $('aiScopeChip').addEventListener('click', () => {
    state.aiWide = !state.aiWide; updateAiSettings();
    if (!state.aiMessages.length && !state.aiController) renderAiMessages();
  });
  $('aiKey').addEventListener('input', () => updateAiSettings());
  $('aiEndpoint').addEventListener('input', () => updateAiSettings());
  $('recheckAiButton').addEventListener('click', async event => {
    const trigger = event.currentTarget; trigger.disabled = true; trigger.textContent = 'أفحص…';
    await loadLocalAiStatus(); trigger.disabled = false; trigger.textContent = 'إعادة الفحص';
  });
  $('testAiButton').addEventListener('click', testAiConnection);
  $('aiSettingsDialog').addEventListener('close', () => { updateAiSettings({ save: true }); if ($('aiDialog').open && !state.aiController) renderAiMessages(); });
  $('arrangeWithAiButton').addEventListener('click', arrangeWithAi);
  $('suggestTopicsButton').addEventListener('click', suggestTopics);
  $('reviewButton').addEventListener('click', reviewDraft);
  $('closePlanDialog').addEventListener('click', () => $('planDialog').close());
  $('copyPromptButton').addEventListener('click', async () => {
    await copyText(state.handoffPrompt);
  });
  $('sendToAiButton').addEventListener('click', sendPlanToAi);
  viewport.addEventListener('contextmenu', showContextMenu);
  window.addEventListener('pointerdown', event => { if (!event.target.closest?.('#contextMenu')) closeContextMenu(); }, true);
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest('.table-node')) return;
    viewport.setPointerCapture(event.pointerId);
    state.drag = { type: 'pan', startX: event.clientX, startY: event.clientY, originX: state.x, originY: state.y, moved: false };
    viewport.classList.add('panning');
  });
  window.addEventListener('pointermove', event => {
    const drag = state.drag;
    if (!drag) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (drag.type === 'node') {
      if (drag.moved && !drag.routeInvalidated) { state.routeGeneration++; drag.routeInvalidated = true; }
      const point = { x: snap4(drag.originX + dx / state.scale), y: snap4(drag.originY + dy / state.scale) };
      (state.viewMode === 'focus' ? state.focusPositions : state.viewMode === 'topics' ? state.topicPositions : state.positions).set(drag.id, point);
      drag.card.style.left = `${point.x}px`; drag.card.style.top = `${point.y}px`;
      if (!state.edgeFrame) state.edgeFrame = requestAnimationFrame(() => {
        state.edgeFrame = null;
        if (state.drag?.type === 'node') updateEdgesForTable(state.drag.id);
      });
    } else {
      state.x = drag.originX + dx; state.y = drag.originY + dy; transform();
    }
  });
  window.addEventListener('pointerup', () => {
    const drag = state.drag;
    if (!drag) return;
    if (drag.type === 'node') {
      if (state.edgeFrame) { cancelAnimationFrame(state.edgeFrame); state.edgeFrame = null; }
      if (drag.moved) {
        if (state.viewMode === 'map') savePositions();
        if (state.viewMode === 'topics') store.setItem(`${storageKey()}.topicLayout.${state.topic}`, JSON.stringify(Object.fromEntries(state.topicPositions)));
        if (state.viewMode === 'focus') store.setItem(`${storageKey()}.focusLayout.${state.focusTable}`, JSON.stringify(Object.fromEntries(state.focusPositions)));
        state.edgeRoutes = null; renderEdges(); state.suppressClickUntil = performance.now() + 150;
      }
      else selectTable(drag.id, { inspect: false });
    } else if (drag.moved) {
      state.suppressClickUntil = performance.now() + 150;
    }
    viewport.classList.remove('panning');
    state.drag = null;
  });
  viewport.addEventListener('wheel', event => {
    event.preventDefault();
    // Pinch gestures arrive with ctrlKey; a mouse wheel reports whole, large steps. Anything else is a trackpad scroll.
    const mouseWheel = event.deltaMode !== 0 || (event.deltaX === 0 && Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50);
    if (event.ctrlKey || event.metaKey) zoom(Math.exp(-Math.max(-60, Math.min(60, event.deltaY)) * .01), event.clientX, event.clientY);
    else if (mouseWheel && !event.shiftKey) zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY);
    else if (event.shiftKey && !event.deltaX) { state.x -= event.deltaY; transform(); }
    else { state.x -= event.deltaX; state.y -= event.deltaY; transform(); }
  }, { passive: false });
  viewport.addEventListener('click', event => {
    if (performance.now() < state.suppressClickUntil) return;
    if (!event.target.closest('.table-node')) {
      const relationId = canvasRelationAt(event.clientX, event.clientY);
      if (relationId) { selectRelation(relationId); return; }
    }
    if (event.target === viewport || event.target === $('world') || event.target === $('nodes') || event.target === $('edges')) {
      state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis();
    }
  });
  $('zoomIn').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoom(1.2, r.left + r.width / 2, r.top + r.height / 2); });
  $('zoomOut').addEventListener('click', () => { const r = viewport.getBoundingClientRect(); zoom(1 / 1.2, r.left + r.width / 2, r.top + r.height / 2); });
  $('fitButton').addEventListener('click', () => fitView(state.topic !== 'all', { overview: true }));
  $('readableViewButton').addEventListener('click', () => fitView(state.topic !== 'all'));
  $('arrangeButton').addEventListener('click', () => openArrangement());
  $('closeDetails').addEventListener('click', () => { state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis(); });
  $('searchInput').addEventListener('input', () => { state.searchIndex = -1; updateEmphasis(); updateSearchCount(); });
  $('searchToggleButton').addEventListener('click', () => setNavbarSearch($('searchToggleButton').getAttribute('aria-expanded') !== 'true', { focus: true }));
  $('searchInput').addEventListener('keydown', event => {
    if (event.key === 'Escape' && event.currentTarget.value) { event.preventDefault(); event.stopPropagation(); event.currentTarget.value = ''; state.searchIndex = -1; updateEmphasis(); updateSearchCount(); return; }
    if (event.key !== 'Enter') return;
    // Enter walks the matches, Shift+Enter walks back; best name matches come first.
    const matches = rankedSearch(event.currentTarget.value.trim().toLowerCase()); if (!matches.length) return;
    state.searchIndex = ((state.searchIndex ?? -1) + (event.shiftKey ? -1 : 1) + matches.length) % matches.length;
    locateTable(matches[state.searchIndex].id); updateSearchCount(); event.currentTarget.focus();
  });
  window.addEventListener('keydown', event => {
    const editing = event.target.closest?.('input,textarea,select,[contenteditable="true"]');
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); openQuickActions(); return; }
    if (document.querySelector('dialog[open]')) return;
    if (!editing && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault(); stepDraft(event.key.toLowerCase() === 'y' || event.shiftKey ? 1 : -1); return;
    }
    if (!editing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const rect = viewport.getBoundingClientRect(), step = event.shiftKey ? 240 : 80;
      const pan = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[event.key];
      if (pan && !document.activeElement?.closest?.('.table-node,button,[role="menuitem"],.header-menu')) { event.preventDefault(); state.x += pan[0]; state.y += pan[1]; transform(); return; }
      if (['+', '='].includes(event.key)) { zoom(1.2, rect.left + rect.width / 2, rect.top + rect.height / 2); return; }
      if (['-', '_'].includes(event.key)) { zoom(1 / 1.2, rect.left + rect.width / 2, rect.top + rect.height / 2); return; }
      if (event.key === '0') { fitView(state.topic !== 'all'); return; }
      const tool = { v: 'selectionModeButton', t: 'addTableButton', r: 'linkModeButton', a: 'arrangeButton' }[event.key.toLowerCase()];
      if (tool && !$(tool).hidden && !$(tool).disabled) { event.preventDefault(); $(tool).click(); return; }
      if (event.key === '?') { event.preventDefault(); openShortcuts(); return; }
      if (event.key.toLowerCase() === 'l') { event.preventDefault(); openLint(); return; }
      if (event.key.toLowerCase() === 'e') { event.preventDefault(); openExport(); return; }
      if (event.key.toLowerCase() === 'd') { event.preventDefault(); openDialog($('changesPanel')); return; }
      if (event.key.toLowerCase() === 'f') { fitView(state.topic !== 'all', { overview: true }); return; }
    }
    if (event.key === 'Escape' && (!$('toolsMenu').hidden || !$('aiMenu').hidden || !$('topics').hidden)) { closeHeaderMenus(); return; }
    if (event.key === 'Escape' && !$('workspaceMenu').hidden) { closeWorkspaceMenu({ focus: true }); return; }
    if (event.key === '/' && !editing) { event.preventDefault(); setNavbarSearch(true, { focus: true }); }
    if (event.key === 'Escape' && document.querySelector('.chrome.d1.search-open')) { event.preventDefault(); setNavbarSearch(false, { focus: true }); return; }
    if (event.key === 'Escape' && !$('connectDialog').open) { closeContextMenu(); state.selectedTable = null; state.selectedRelation = null; $('details').hidden = true; updateEmphasis(); }
  });
  let previousViewport = { width: viewport.clientWidth, height: viewport.clientHeight };
  window.addEventListener('resize', () => {
    scheduleFitChrome();
    if (!state.schema) { previousViewport = { width: viewport.clientWidth, height: viewport.clientHeight }; return; }
    state.x += (viewport.clientWidth - previousViewport.width) / 2;
    state.y += (viewport.clientHeight - previousViewport.height) / 2;
    previousViewport = { width: viewport.clientWidth, height: viewport.clientHeight }; transform();
  });
  $('connectionButton').addEventListener('click', openConnectionDialog);
  $('browseDatabasesButton').addEventListener('click', browseDatabases);
  $('connectDatabase').addEventListener('input', event => { if (state.databases) { state.databaseFilter = event.target.value.trim(); renderDatabaseList(); } });
  $('connectDatabase').addEventListener('keydown', event => { if (event.key === 'ArrowDown' && state.databases) { event.preventDefault(); $('databaseList').querySelector('.database-option:not(:disabled)')?.focus(); } });
  // Changing where or who we connect as makes the listed databases stale.
  for (const name of ['host', 'port', 'user', 'password', 'ssl']) $('connectForm').elements.namedItem(name).addEventListener('change', () => { if (state.databases) resetDatabaseList('تغيّرت بيانات الدخول. اضغط «استعرض» لتحديث القائمة.'); });
  $('databaseList').addEventListener('keydown', event => {
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const items = [...$('databaseList').querySelectorAll('.database-option:not(:disabled)')], index = items.indexOf(document.activeElement);
    if (event.key === 'ArrowUp' && index <= 0) { $('connectDatabase').focus(); return; }
    items[Math.min(items.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1))]?.focus();
  });
  $('closeDialog').addEventListener('click', () => $('connectDialog').close());
  $('demoButton').addEventListener('click', openDemo);
  $('refreshButton').addEventListener('click', refreshSchema);
  $('connectForm').addEventListener('submit', submitConnection);
}
async function bootstrap() {
  await initStore();
  applyTheme(currentTheme());
  installEvents();
  let serverSchema = null;
  try {
    const response = await fetch('/api/schema');
    if (response.ok) { const data = await response.json(); if (data.tables) serverSchema = data; }
  } catch { /* app can still open in demo mode */ }
  let registry;
  try { registry = JSON.parse(store.getItem(WORKSPACES_KEY) || 'null'); } catch { registry = null; }
  if (Array.isArray(registry?.items) && registry.items.length) {
    state.workspaces = registry.items.filter(item => item?.id && item?.name && ['database', 'demo', 'ideas'].includes(item.kind));
    if (state.workspaces.length) {
      await migrateLegacySufra();
      const requestedId = location.hash.slice(1);
      const active = state.workspaces.find(item => item.id === requestedId)
        || state.workspaces.find(item => item.id === registry.activeId)
        || state.workspaces[0];
      const live = active.kind === 'database' && sameConnection(active.schema, serverSchema);
      if (live) active.schema = serverSchema;
      else if (serverSchema) await fetch('/api/disconnect', { method: 'POST' }).catch(() => {});
      await activateWorkspace(active.id, { initial: true, live });
      return;
    }
  }
  const first = serverSchema || sampleSchema();
  state.workspaces = [{ id: 'legacy', name: serverSchema ? first.database : 'التجربة', kind: serverSchema ? 'database' : 'demo', schema: first, topic: 'all', connection: null }];
  await activateWorkspace('legacy', { initial: true, live: Boolean(serverSchema) });
  if (!serverSchema && !sessionStorage.getItem('eratlas.seen')) {
    sessionStorage.setItem('eratlas.seen', '1');
    setTimeout(openConnectionDialog, 450);
  }
}

bootstrap();
