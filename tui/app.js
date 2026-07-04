import React, { useState, useEffect } from 'react';
import { render, Box, Text, useInput, useApp, useStdout } from 'ink';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// This file runs from the built tui/dist/app.mjs, so the repo root is two
// levels up (dist -> tui -> root), not one.
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

const DEFAULT_CONFIG = { default_model: 'gemini-2.5-flash', active_tab: 'api_key', api_keys: [], active_profile: null };

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// Create config.json on first run; migrate an older single-key config.json
// (flat `api_key` string) into the profile list (`api_keys: [{name, api_key}]`).
(function migrateConfig() {
  const existing = loadConfig();
  let cfg = { ...existing };
  let changed = false;

  if (!Array.isArray(cfg.api_keys)) {
    if (typeof cfg.api_key === 'string' && cfg.api_key) {
      cfg.api_keys = [{ name: 'Default', api_key: cfg.api_key }];
      cfg.active_profile = 'Default';
    } else {
      cfg.api_keys = [];
      cfg.active_profile = null;
    }
    changed = true;
  }
  if ('api_key' in cfg) {
    delete cfg.api_key;
    changed = true;
  }

  cfg = { ...DEFAULT_CONFIG, ...cfg };
  if (changed || JSON.stringify(cfg) !== JSON.stringify(existing)) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
    } catch (e) {
      // Non-fatal — the in-memory merged value is still used for this session.
    }
  }
})();

const TABS = ['api_key', 'models', 'exit'];
const ACTIONS = ['Switch to selected', 'Edit API key', 'Delete API key', 'Create API key'];

// ── Fixed-width row helpers (same convention as Gemi_MCP_V2's list panes) —
// build each row as one already-clipped string instead of letting Ink/the
// terminal wrap long text, which is what pushed rows onto a second line.
// ponytail: no CJK/full-width-char accounting like Gemi's displayWidth (profile
// names/keys here are ASCII); add it if this ever needs to render CJK text. ──
function padEndDisplay(str, width) {
  return str.length >= width ? str : str + ' '.repeat(width - str.length);
}
function truncateDisplay(str, width) {
  return str.length <= width ? str : str.slice(0, Math.max(0, width));
}

// Mask an API key for display: AIzaXXXX********YYYY (keep the first 8 chars
// visible, plus the last 4 chars).
function maskApiKey(key) {
  if (!key) return '(empty)';
  if (key.length <= 12) return key;
  return `${key.slice(0, 8)}********${key.slice(-4)}`;
}

// ── Header — same convention as Gemi_MCP_V2's Header: bordered status strip
// above the menu bar, current profile/model separated by " │ ". ────────────
const Header = React.memo(function Header({ activeProfileName, defaultModel }) {
  return (
    <Box borderStyle="single" paddingX={1} height={3} overflow="hidden">
      <Text bold color="green">GAS MCP</Text>
      <Text>  │  profile: <Text color="cyan" bold>{activeProfileName || '(none)'}</Text></Text>
      <Text>  │  default model: <Text color="cyan" bold>{defaultModel || '(none)'}</Text></Text>
    </Box>
  );
});

// ── Menu bar — same convention as Gemi_MCP_V2: highlighted tab = active mode ─
const MenuBar = React.memo(function MenuBar({ activeTab, mode }) {
  const isMenu = mode === 'menu';
  return (
    <Box flexDirection="row" paddingX={1} marginTop={0} height={1} overflow="hidden">
      <Text
        color={activeTab === 'api_key' ? (isMenu ? 'black' : 'cyan') : 'gray'}
        backgroundColor={isMenu && activeTab === 'api_key' ? 'cyan' : undefined}
        bold={!isMenu && activeTab === 'api_key'}
      >
        {' API KEY '}
      </Text>
      <Text>  </Text>
      <Text
        color={activeTab === 'models' ? (isMenu ? 'black' : 'cyan') : 'gray'}
        backgroundColor={isMenu && activeTab === 'models' ? 'cyan' : undefined}
        bold={!isMenu && activeTab === 'models'}
      >
        {' MODELS '}
      </Text>
      <Text>  </Text>
      <Text
        color={activeTab === 'exit' ? (isMenu ? 'black' : 'red') : 'gray'}
        backgroundColor={isMenu && activeTab === 'exit' ? 'red' : undefined}
        bold={!isMenu && activeTab === 'exit'}
      >
        {' EXIT '}
      </Text>
      <Text>  </Text>
      {isMenu && <Text dimColor>(← → switch, ↓/Enter select)</Text>}
    </Box>
  );
});

function YesNoConfirm({ message, selected, height }) {
  return (
    <Box height={height} flexDirection="column" justifyContent="center" alignItems="center">
      <Text>{message}</Text>
      <Box marginTop={1}>
        <Text backgroundColor={selected === 0 ? 'cyan' : undefined} color={selected === 0 ? 'black' : undefined}> Yes </Text>
        <Text>  </Text>
        <Text backgroundColor={selected === 1 ? 'cyan' : undefined} color={selected === 1 ? 'black' : undefined}> No </Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>(← → choose, Enter confirm, Esc cancel)</Text>
      </Box>
    </Box>
  );
}

// ── API KEY tab, panel view — left: action list; right: saved profiles ──────
// Right column follows Gemi_MCP_V2's AccountsPane convention: a frozen header
// row (highlighted, never scrolls), then rows built as one fixed-width string
// per profile (name column + key column, truncated — never wrapped).
function ApiKeyPanels({ mode, actionSelected, profiles, profileSelected, activeProfileName, height, leftWidth, rightWidth }) {
  const innerWidth = Math.max(10, rightWidth - 4); // minus border(2) + paddingX(2)
  const nameWidth = Math.min(20, Math.max(8, 'Profile'.length, ...profiles.map((p) => (p.name || '').length)));
  const GUTTER = 2; // '★ ' or '  ' marker column
  const COL_GAP = 2; // spacing between the name and key columns
  const prefixWidth = GUTTER + nameWidth + COL_GAP;
  const keyWidth = Math.max(4, innerWidth - prefixWidth);
  const headerRow = padEndDisplay(' '.repeat(GUTTER) + padEndDisplay('Profile', nameWidth) + ' '.repeat(COL_GAP) + 'API Key', innerWidth);

  const win = windowed(profiles, profileSelected, height - 3); // -1 header row, -2 top+bottom border

  return (
    <Box height={height}>
      <Box width={leftWidth} height={height} borderStyle="single" borderColor={mode === 'left' ? 'cyan' : 'gray'} paddingX={1} flexDirection="column">
        <Text dimColor>Action:</Text>
        {ACTIONS.map((a, i) => {
          const isCursor = mode === 'left' && i === actionSelected;
          return (
            <Text key={a} backgroundColor={isCursor ? 'cyan' : undefined} color={isCursor ? 'black' : undefined}>
              {i === actionSelected ? '› ' : '  '}{a}
            </Text>
          );
        })}
      </Box>
      <Box width={rightWidth} height={height} borderStyle="single" borderColor={mode === 'right' ? 'cyan' : 'gray'} paddingX={1} flexDirection="column">
        <Text backgroundColor="blue" color="white">{headerRow}</Text>
        {profiles.length === 0 && <Text dimColor>(none yet — use Create API key)</Text>}
        {win.items.map((p, i) => {
          const idx = win.start + i;
          const isCursor = mode === 'right' && idx === profileSelected;
          const isActive = p.name === activeProfileName;
          const nm = padEndDisplay(truncateDisplay(p.name || '', nameWidth), nameWidth);
          const keyStr = truncateDisplay(maskApiKey(p.api_key), keyWidth);
          const rowStr = padEndDisplay(`${isActive ? '★' : ' '} ${nm}  ${keyStr}`, innerWidth);
          return (
            <Text key={`${p.name}-${idx}`} backgroundColor={isCursor ? 'cyan' : undefined} color={isCursor ? 'black' : undefined}>
              {rowStr}
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

// ── API KEY tab, create/edit form — profile name box, then key box ──────────
function ApiKeyForm({ mode, nameDraft, keyDraft, chooseSelected, editing, height }) {
  const namingActive = mode === 'apikey_name_typing';
  const keyingActive = mode === 'apikey_key_typing';
  const choosing = mode === 'apikey_choose';
  return (
    <Box height={height} flexDirection="column" paddingX={1}>
      <Text dimColor>{editing ? 'Edit' : 'Create'} API key profile:</Text>
      <Text dimColor>Profile name:</Text>
      <Box borderStyle="round" borderColor={namingActive ? 'cyan' : 'gray'} paddingX={1}>
        <Text>{nameDraft.length ? nameDraft : '(empty)'}{namingActive ? '█' : ''}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>API key:</Text>
      </Box>
      <Box borderStyle="round" borderColor={keyingActive ? 'cyan' : 'gray'} paddingX={1}>
        <Text>{keyDraft.length ? keyDraft : '(empty)'}{keyingActive ? '█' : ''}</Text>
      </Box>
      {choosing && (
        <Box marginTop={1}>
          <Text backgroundColor={chooseSelected === 0 ? 'cyan' : undefined} color={chooseSelected === 0 ? 'black' : undefined}> Save </Text>
          <Text>  </Text>
          <Text backgroundColor={chooseSelected === 1 ? 'cyan' : undefined} color={chooseSelected === 1 ? 'black' : undefined}> Cancel </Text>
        </Box>
      )}
    </Box>
  );
}

// Cap rendered rows to the panel's actual height (minus its header line) so a
// long list can't push the panel taller than the fixed content area; keeps
// the selected row scrolled into view.
function windowed(list, selected, visible) {
  const n = Math.max(1, visible);
  const start = Math.max(0, Math.min(selected - Math.floor(n / 2), Math.max(0, list.length - n)));
  return { start, items: list.slice(start, start + n) };
}

// supportedGenerationMethods split into three short, fixed-width columns
// instead of one long comma list: Type (what the model fundamentally is),
// Stream (real-time bidirectional support), Cache/Batch (cost/latency
// optimizations available on top of the base capability). countTokens /
// countTextTokens are omitted — every model has one of them, so they carry
// no distinguishing information.
function capsOf(m) {
  const methods = m.supportedGenerationMethods || [];
  const has = (name) => methods.includes(name);
  let type = 'Other';
  if (has('generateContent')) type = 'Text';
  else if (has('embedContent') || has('asyncBatchEmbedContent')) type = 'Embedding';
  else if (has('predict') || has('predictLongRunning')) type = 'Image';
  else if (has('generateAnswer')) type = 'QA';
  const stream = has('bidiGenerateContent') ? '✓' : '';
  const cacheBatch = [
    has('createCachedContent') ? 'Cache' : null,
    (has('batchGenerateContent') || has('asyncBatchEmbedContent')) ? 'Batch' : null,
  ].filter(Boolean).join(' · ');
  return { type, stream, cacheBatch };
}

// Right-edge scroll indicator (thumb size/position scaled to how much of the
// list is currently visible), same idea as a native list-box scrollbar so a
// long model list doesn't look "stuck" with no sense of how far down you are.
function scrollbarColumn(total, trackHeight, start) {
  if (total <= trackHeight) return Array(trackHeight).fill(' ');
  const thumbSize = Math.max(1, Math.round((trackHeight * trackHeight) / total));
  const maxStart = total - trackHeight;
  const thumbStart = maxStart > 0 ? Math.round((start / maxStart) * (trackHeight - thumbSize)) : 0;
  return Array.from({ length: trackHeight }, (_, i) => (i >= thumbStart && i < thumbStart + thumbSize ? '█' : '│'));
}

// Fixed widths for the three capability columns — sized to their longest
// possible value ('Embedding', 'Cache · Batch') so they're never truncated;
// only the Model Name column flexes/truncates when the terminal is narrow.
const TYPE_W = 9;
const STREAM_W = 6;
const CACHEBATCH_W = 13;

// ── Models tab — single flat list of every model, A–Z, with capabilities
// split into three short columns (Type / Stream / Cache·Batch) instead of
// one long comma list of raw supportedGenerationMethods names. Enter sets
// config.json's default_model, used by server.py when a tool call doesn't
// specify one. Previously this was a two-panel drill-down (category ->
// models); that forced an extra navigation step and the category column
// header was just raw, developer-facing API method names.
// Row strings are built to an exact character width (never left to wrap) —
// same fixed-width convention as ApiKeyPanels — because letting Ink wrap an
// overflowing model id onto a second line broke row alignment and pushed the
// list past the panel height. ──
function ModelsTab({ mode, loading, error, models, modelSelected, defaultModel, width, height }) {
  if (loading) {
    return (
      <Box height={height} alignItems="center" justifyContent="center">
        <Text dimColor>Loading models from Google AI Studio…</Text>
      </Box>
    );
  }
  if (error) {
    return (
      <Box height={height} alignItems="center" justifyContent="center">
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  // Visible rows = panel height minus the title row (1) and the top+bottom
  // border (2). A single-line border box consumes TWO rows vertically, not one;
  // undercounting it by one made the list overflow the box, which is what caused
  // both the row overlap ("transparent" title stacking on the first item) and
  // the one-frame redraw lag.
  const trackHeight = height - 3;
  const modelWin = windowed(models, modelSelected, trackHeight);
  const scrollbar = scrollbarColumn(models.length, trackHeight, modelWin.start);

  // Box width is pinned to the terminal-derived `width` passed in — never
  // grown past it. Widening the box beyond the actual terminal columns made
  // Ink/the terminal wrap each row, which corrupted the layout and made the
  // list look squeezed to half width instead of wider.
  const innerWidth = Math.max(20, width - 4); // minus border(2) + paddingX(2)
  const SCROLL_GAP = 1;
  const contentWidth = Math.max(10, innerWidth - SCROLL_GAP - 1); // -1 for the scrollbar char itself
  const GUTTER = 2; // '★ ' or '  ' marker column
  const COL_GAP = 2;
  const fixedColsWidth = TYPE_W + STREAM_W + CACHEBATCH_W + COL_GAP * 3;
  const nameWidth = Math.max(8, Math.min(
    Math.max(12, ...models.map((m) => m.id.length), 'Model Name'.length),
    contentWidth - GUTTER - fixedColsWidth,
  ));
  const headerRow = padEndDisplay(
    ' '.repeat(GUTTER) + padEndDisplay('Model Name', nameWidth) + ' '.repeat(COL_GAP)
      + padEndDisplay('Type', TYPE_W) + ' '.repeat(COL_GAP)
      + padEndDisplay('Stream', STREAM_W) + ' '.repeat(COL_GAP)
      + padEndDisplay('Cache/Batch', CACHEBATCH_W),
    contentWidth,
  );

  return (
    <Box height={height}>
      <Box width={width} height={height} borderStyle="single" borderColor={mode === 'left' ? 'cyan' : 'gray'} paddingX={1} flexDirection="column">
        <Text backgroundColor="blue" color="white">{headerRow}{' '.repeat(SCROLL_GAP)} </Text>
        {modelWin.items.map((m, i) => {
          const idx = modelWin.start + i;
          const isCursor = mode === 'left' && idx === modelSelected;
          const isDefault = m.id === defaultModel;
          const nm = padEndDisplay(truncateDisplay(m.id, nameWidth), nameWidth);
          const typeCol = padEndDisplay(m.type, TYPE_W);
          const streamCol = padEndDisplay(m.stream, STREAM_W);
          const cacheBatchCol = padEndDisplay(m.cacheBatch, CACHEBATCH_W);
          const rowStr = padEndDisplay(
            `${isDefault ? '★' : ' '} ${nm}  ${typeCol}  ${streamCol}  ${cacheBatchCol}`,
            contentWidth,
          );
          return (
            <Text key={m.id}>
              <Text backgroundColor={isCursor ? 'cyan' : undefined} color={isCursor ? 'black' : undefined}>{rowStr}</Text>
              {' '.repeat(SCROLL_GAP)}<Text dimColor>{scrollbar[i]}</Text>
            </Text>
          );
        })}
      </Box>
    </Box>
  );
}

function Footer({ mode, activeTab }) {
  let hint;
  if (mode === 'menu') hint = '[← →] switch tab  [Enter/↓] select  [Ctrl+C] quit';
  else if (mode === 'apikey_name_typing') hint = '[type] edit name  [Enter] next field  [Esc/Tab] back';
  else if (mode === 'apikey_key_typing') hint = '[type] edit key  [Enter] continue to Save/Cancel  [Esc/Tab] back';
  else if (mode === 'apikey_choose') hint = '[← →] Save/Cancel  [Enter] confirm  [Esc/Tab] back';
  else if (mode === 'apikey_delete_confirm') hint = '[← →] choose  [Enter] confirm  [Esc/Tab] cancel';
  else if (mode === 'left' && activeTab === 'api_key') hint = '[↑↓] choose action  [→/Enter] pick profile (Enter=create)  [Esc/Tab] back';
  else if (mode === 'right' && activeTab === 'api_key') hint = '[↑↓] navigate  [Enter] run action  [←/Esc/Tab] back';
  else if (mode === 'left') hint = '[↑↓] navigate  [Enter] set default  [Esc/Tab] back';
  else hint = '[Ctrl+C] quit';
  return (
    <Box paddingX={1} height={1} overflow="hidden">
      <Text dimColor wrap="truncate-end">{hint}</Text>
    </Box>
  );
}

function App() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  // Same approach as Gemi_MCP_V2: track terminal rows in state (updated on the
  // stdout 'resize' event) rather than reading stdout.rows fresh each render.
  const [termRows, setTermRows] = useState(stdout?.rows ?? 24);
  const [termCols, setTermCols] = useState(stdout?.columns ?? 80);
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => {
      setTermRows(stdout.rows ?? 24);
      setTermCols(stdout.columns ?? 80);
    };
    stdout.on('resize', onResize);
    return () => stdout.off('resize', onResize);
  }, [stdout]);
  // Fixed content height, independent of which tab/mode is active. Every tab
  // renders exactly this many rows (padding with blank space if it has less
  // content) so total output height never changes between renders — a
  // varying height is what causes Ink to leave stale frames behind when
  // switching tabs (the "ghost" duplicate-menu-bar bug). Header (3, bordered),
  // MenuBar (1) and Footer (1) take 5 rows; the extra -1 leaves one blank line
  // at the bottom so total output is termRows-1, NOT the full terminal height.
  // Filling every row makes the terminal scroll one line when the final row is
  // written, which knocks Ink's cursor-based in-place redraw out of alignment
  // and makes the screen lag one keypress behind the real state.
  const mainHeight = Math.max(6, termRows - 6);
  // Fixed numeric panel widths (not percentage strings) so row strings can be
  // built to an exact character width — same as Gemi's leftPanelWidth/rightPanelWidth.
  const leftPanelWidth = 30;
  const rightPanelWidth = Math.max(20, termCols - leftPanelWidth);
  const [activeTab, setActiveTab] = useState('api_key');
  // mode: 'menu' | 'left' | 'right' (panel focus, shared by API KEY and MODELS tabs) |
  //       'apikey_name_typing' | 'apikey_key_typing' | 'apikey_choose' | 'apikey_delete_confirm' |
  //       'exit_confirm'
  const [mode, setMode] = useState('menu');
  const [exitConfirmSelected, setExitConfirmSelected] = useState(0);

  const initialCfg = loadConfig();
  const [apiKeyProfiles, setApiKeyProfiles] = useState(initialCfg.api_keys || []);
  const [activeProfileName, setActiveProfileName] = useState(initialCfg.active_profile || null);
  const [actionSelected, setActionSelected] = useState(0); // index into ACTIONS
  const [profileSelected, setProfileSelected] = useState(0); // index into apiKeyProfiles
  const [editingIndex, setEditingIndex] = useState(null); // null = creating a new profile
  const [nameDraft, setNameDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [apikeyChooseSelected, setApikeyChooseSelected] = useState(0); // 0 = Save, 1 = Cancel
  const [deleteConfirmSelected, setDeleteConfirmSelected] = useState(0); // 0 = Yes, 1 = No

  const [models, setModels] = useState(null); // null = not fetched yet
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState(null);
  const [modelSelected, setModelSelected] = useState(0);
  const [defaultModel, setDefaultModel] = useState(loadConfig().default_model || '');

  // The TUI only loaded config.json once, at mount -- so an external edit
  // (hand-editing the file, or another tool writing to it) while the TUI is
  // already open left the displayed profile/model stuck showing stale data.
  // Re-read the file whenever the user drills into a tab from the menu bar,
  // so what's on screen always matches what's actually on disk.
  function refreshFromDisk() {
    const cfg = loadConfig();
    const profiles = cfg.api_keys || [];
    setApiKeyProfiles(profiles);
    setActiveProfileName(cfg.active_profile || null);
    setDefaultModel(cfg.default_model || '');
    // Clamp in case the profile list shrank (or changed) since this state was last set.
    setProfileSelected((s) => Math.max(0, Math.min(s, profiles.length - 1)));
  }

  // Prefetch the model catalog at mount (not lazily on tab-open), so it's ready
  // before the user ever navigates to the MODELS tab. Fetching lazily meant the
  // first arrow press after entering the tab landed on the "Loading…" screen and
  // appeared to do nothing, forcing a second press. Category = supportedGenerationMethods
  // joined, kept in the order the API returns it (no re-sorting).
  useEffect(() => {
    if (models !== null || modelsLoading) return;
    const cfg = loadConfig();
    const active = (cfg.api_keys || []).find((p) => p.name === cfg.active_profile);
    const key = active && active.api_key;
    if (!key) {
      // Only surface the "no key" message once the user is actually on the MODELS
      // tab; at mount, stay silent so a later profile switch can still prefetch.
      if (activeTab === 'models') {
        setModelsError('No active API key profile — go to the API KEY tab and switch to (or create) one first.');
      }
      return;
    }
    setModelsError(null);
    setModelsLoading(true);
    fetch('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': key } })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setModels(json.models || []))
      .catch((err) => setModelsError(err.message))
      .finally(() => setModelsLoading(false));
  }, [activeTab, models, modelsLoading]);

  const allModels = models
    ? models
        .map((m) => ({ id: m.name.replace(/^models\//, ''), ...capsOf(m) }))
        .sort((a, b) => a.id.localeCompare(b.id))
    : [];

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit();
      return;
    }

    if (mode === 'exit_confirm') {
      if (key.leftArrow || key.rightArrow) {
        setExitConfirmSelected((s) => (s === 0 ? 1 : 0));
      }
      if (key.escape || key.tab) {
        setMode('menu');
        setActiveTab('api_key');
        return;
      }
      if (key.return) {
        if (exitConfirmSelected === 0) {
          exit();
        } else {
          setMode('menu');
          setActiveTab('api_key');
        }
      }
      return;
    }

    if (mode === 'apikey_delete_confirm') {
      if (key.leftArrow || key.rightArrow) {
        setDeleteConfirmSelected((s) => (s === 0 ? 1 : 0));
      }
      if (key.escape || key.tab) {
        setMode('right');
        return;
      }
      if (key.return) {
        if (deleteConfirmSelected === 0) {
          const target = apiKeyProfiles[profileSelected];
          const newList = apiKeyProfiles.filter((_, i) => i !== profileSelected);
          let newActive = activeProfileName;
          if (target && target.name === activeProfileName) {
            newActive = newList.length ? newList[0].name : null;
          }
          saveConfig({ api_keys: newList, active_profile: newActive });
          setApiKeyProfiles(newList);
          setActiveProfileName(newActive);
          setProfileSelected((s) => Math.max(0, Math.min(s, newList.length - 1)));
        }
        setMode('right');
      }
      return;
    }

    // ── Tab / Esc: context-aware back navigation ─────────────────────────
    if (key.tab || key.escape) {
      if (mode === 'right') setMode('left');
      else if (mode === 'apikey_key_typing') setMode('apikey_name_typing');
      else if (mode === 'apikey_choose') setMode('apikey_key_typing');
      else if (mode === 'apikey_name_typing') setMode(editingIndex === null ? 'left' : 'right');
      else setMode('menu');
      return;
    }

    // ── Menu bar ─────────────────────────────────────────────────────────
    if (mode === 'menu') {
      if (key.leftArrow || key.rightArrow) {
        setActiveTab((prev) => {
          const i = TABS.indexOf(prev);
          const step = key.rightArrow ? 1 : -1;
          return TABS[(i + step + TABS.length) % TABS.length];
        });
      }
      if (key.return || key.downArrow) {
        if (activeTab === 'exit') {
          setMode('exit_confirm');
          setExitConfirmSelected(0);
        } else if (activeTab === 'api_key') {
          refreshFromDisk();
          setActionSelected(0);
          setMode('left');
        } else {
          refreshFromDisk();
          setModelSelected(0);
          setMode('left');
        }
      }
      return;
    }

    // ── API KEY tab: left panel — action list ─────────────────────────────
    if (mode === 'left' && activeTab === 'api_key') {
      if (key.upArrow) setActionSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setActionSelected((s) => Math.min(ACTIONS.length - 1, s + 1));
      if (key.rightArrow && actionSelected !== 3 && apiKeyProfiles.length > 0) {
        setProfileSelected(0);
        setMode('right');
      }
      if (key.return) {
        if (actionSelected === 3) {
          setEditingIndex(null);
          setNameDraft('');
          setKeyDraft('');
          setMode('apikey_name_typing');
        } else if (apiKeyProfiles.length > 0) {
          setProfileSelected(0);
          setMode('right');
        }
      }
      return;
    }

    // ── API KEY tab: right panel — profile list, action runs on Enter ─────
    if (mode === 'right' && activeTab === 'api_key') {
      if (key.upArrow) setProfileSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setProfileSelected((s) => Math.min(Math.max(0, apiKeyProfiles.length - 1), s + 1));
      if (key.leftArrow) setMode('left');
      if (key.return) {
        const p = apiKeyProfiles[profileSelected];
        if (p) {
          if (actionSelected === 0) {
            // Switch to selected
            saveConfig({ active_profile: p.name });
            setActiveProfileName(p.name);
          } else if (actionSelected === 1) {
            // Edit API key
            setEditingIndex(profileSelected);
            setNameDraft(p.name);
            setKeyDraft(p.api_key);
            setMode('apikey_name_typing');
          } else if (actionSelected === 2) {
            // Delete API key
            setDeleteConfirmSelected(0);
            setMode('apikey_delete_confirm');
          }
        }
      }
      return;
    }

    // ── API KEY tab: create/edit — stage 1, profile name ──────────────────
    if (mode === 'apikey_name_typing') {
      if (key.return) {
        setMode('apikey_key_typing');
        return;
      }
      if (key.backspace || key.delete) {
        setNameDraft((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setNameDraft((s) => s + input);
      }
      return;
    }

    // ── API KEY tab: create/edit — stage 2, key value ─────────────────────
    if (mode === 'apikey_key_typing') {
      if (key.return) {
        setApikeyChooseSelected(0);
        setMode('apikey_choose');
        return;
      }
      if (key.backspace || key.delete) {
        setKeyDraft((s) => s.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setKeyDraft((s) => s + input);
      }
      return;
    }

    // ── API KEY tab: create/edit — stage 3, Save / Cancel ─────────────────
    if (mode === 'apikey_choose') {
      if (key.leftArrow || key.rightArrow) {
        setApikeyChooseSelected((s) => (s === 0 ? 1 : 0));
        return;
      }
      if (key.return) {
        const returnMode = editingIndex === null ? 'left' : 'right';
        if (apikeyChooseSelected === 0) {
          const trimmedName = nameDraft.trim() || '(unnamed)';
          let newList;
          if (editingIndex === null) {
            newList = [...apiKeyProfiles, { name: trimmedName, api_key: keyDraft }];
          } else {
            newList = apiKeyProfiles.map((p, i) => (i === editingIndex ? { name: trimmedName, api_key: keyDraft } : p));
          }
          let newActive = activeProfileName;
          if (editingIndex !== null && apiKeyProfiles[editingIndex] && apiKeyProfiles[editingIndex].name === activeProfileName) {
            newActive = trimmedName;
          }
          if (!newActive && newList.length === 1) newActive = newList[0].name;
          saveConfig({ api_keys: newList, active_profile: newActive });
          setApiKeyProfiles(newList);
          setActiveProfileName(newActive);
        }
        setMode(returnMode);
        return;
      }
      return;
    }

    // ── MODELS tab: single flat list — every model, Enter sets default ────
    if (mode === 'left') {
      if (key.upArrow) setModelSelected((s) => Math.max(0, s - 1));
      if (key.downArrow) setModelSelected((s) => Math.min(Math.max(0, allModels.length - 1), s + 1));
      if (key.return) {
        const picked = allModels[modelSelected];
        if (picked) {
          saveConfig({ default_model: picked.id });
          setDefaultModel(picked.id);
        }
      }
      return;
    }
  });

  return (
    <Box flexDirection="column" width="100%" height="100%">
      <Header activeProfileName={activeProfileName} defaultModel={defaultModel} />
      <MenuBar activeTab={activeTab} mode={mode} />
      {mode === 'exit_confirm' && <ExitConfirmWrapper selected={exitConfirmSelected} height={mainHeight} />}
      {mode === 'apikey_delete_confirm' && (
        <YesNoConfirm
          message={`Delete profile "${(apiKeyProfiles[profileSelected] || {}).name || ''}"?`}
          selected={deleteConfirmSelected}
          height={mainHeight}
        />
      )}
      {mode !== 'exit_confirm' && mode !== 'apikey_delete_confirm' && activeTab === 'api_key' && (
        ['apikey_name_typing', 'apikey_key_typing', 'apikey_choose'].includes(mode) ? (
          <ApiKeyForm
            mode={mode}
            nameDraft={nameDraft}
            keyDraft={keyDraft}
            chooseSelected={apikeyChooseSelected}
            editing={editingIndex !== null}
            height={mainHeight}
          />
        ) : (
          <ApiKeyPanels
            mode={mode}
            actionSelected={actionSelected}
            profiles={apiKeyProfiles}
            profileSelected={profileSelected}
            activeProfileName={activeProfileName}
            height={mainHeight}
            leftWidth={leftPanelWidth}
            rightWidth={rightPanelWidth}
          />
        )
      )}
      {mode !== 'exit_confirm' && mode !== 'apikey_delete_confirm' && activeTab === 'models' && (
        <ModelsTab
          mode={mode}
          loading={modelsLoading}
          error={modelsError}
          models={allModels}
          modelSelected={modelSelected}
          defaultModel={defaultModel}
          width={leftPanelWidth + rightPanelWidth}
          height={mainHeight}
        />
      )}
      {mode !== 'exit_confirm' && mode !== 'apikey_delete_confirm' && activeTab === 'exit' && (
        <Box height={mainHeight} alignItems="center" justifyContent="center">
          <Text dimColor>Press Enter to quit</Text>
        </Box>
      )}
      <Footer mode={mode} activeTab={activeTab} />
    </Box>
  );
}

function ExitConfirmWrapper({ selected, height }) {
  return <YesNoConfirm message="Quit GAS MCP?" selected={selected} height={height} />;
}

render(<App />);
