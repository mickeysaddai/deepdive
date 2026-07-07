'use strict';

// ── CENTRALISED STATE ──
// All mutable state lives here. Nothing else should declare top-level lets
// for app data — read and write exclusively through AppState so every change
// is traceable and testable from one place.
const AppState = {
  // Notes data
  notes: null,
  notesLoadedAt: null,
  notesError: null,

  // User data (persisted)
  themes: [],
  history: [],
  themeIndex: 3,

  // Session state
  currentTheme: null,
  chatHistory: [],
  isListening: false,
  recognition: null,
  currentAudio: null,
  currentAudioQueue: [],
  detailAllMatches: [],
  detailPage: 0,
  explorePage: 0,
  currentExploreUnit: null,

  // Single setter — all state changes go through here
  set(key, value) {
    this[key] = value;
    return this;
  },

  // Persist a key to localStorage
  save(key) {
    const map = {
      themes:     'dd-themes-v2',
      history:    'dd-history-v2',
      themeIndex: 'dd-theme',
    };
    if (map[key]) {
      try {
        localStorage.setItem(map[key], JSON.stringify(this[key]));
      } catch(e) {
        console.warn('Could not persist state:', key, e);
      }
    }
  },

  // Hydrate from localStorage on boot
  load() {
    try { this.themes  = JSON.parse(localStorage.getItem('dd-themes-v2')  || '[]'); } catch(e) { this.themes  = []; }
    try { this.history = JSON.parse(localStorage.getItem('dd-history-v2') || '[]'); } catch(e) { this.history = []; }
    try { this.themeIndex = parseInt(localStorage.getItem('dd-theme') || '3'); } catch(e) { this.themeIndex = 3; }
  },
};

// Boot — hydrate persisted state immediately
AppState.load();

// Legacy shims so existing functions that reference bare variables still work
// during the transition. These are thin proxies into AppState and can be
// removed once every call-site is migrated.
const synth = window.speechSynthesis;

// ── NAVIGATION ──
const ALL = ['home','themes','detail','pioneer','pioneer-detail','pioneer-questions','pioneer-answer','chat','history'];
const NAV = ['home','themes','pioneer','chat','history'];

function goTo(name) {
  ALL.forEach(s => document.getElementById('screen-' + s).classList.remove('active'));
  document.getElementById('screen-' + name).classList.add('active');
  NAV.forEach(s => {
    const b = document.getElementById('nav-' + s);
    if (b) b.classList.toggle('active', s === name);
  });
  if (name === 'themes') renderThemes();
  if (name === 'pioneer') { renderPioneer(); switchPioneerTab('explore'); }
  if (name === 'history') renderHistory();
  window.scrollTo(0, 0);
}

// ── UTILITIES ──
function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// ── FETCH NOTES ──
// Stale-while-revalidate: serve cached notes immediately if available,
// then silently refresh in the background if data is older than 5 minutes.
// On failure, fall back to stale cache rather than breaking the UI.
const NOTES_CACHE_KEY = 'dd-notes-cache-v1';
const NOTES_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function fetchNotes({ forceRefresh = false } = {}) {
  // Serve from memory cache if fresh enough
  const age = AppState.notesLoadedAt ? Date.now() - AppState.notesLoadedAt : Infinity;
  if (AppState.notes && !forceRefresh && age < NOTES_TTL_MS) {
    return AppState.notes;
  }

  // If we have stale in-memory notes, return them immediately and refresh in background
  if (AppState.notes && !forceRefresh) {
    refreshNotes(); // fire and forget
    return AppState.notes;
  }

  // No in-memory cache — try localStorage stale cache while we fetch
  if (!AppState.notes) {
    try {
      const cached = localStorage.getItem(NOTES_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        AppState.set('notes', parsed.notes);
        AppState.set('notesLoadedAt', parsed.loadedAt);
        console.log(`Loaded ${parsed.notes.length} notes from localStorage cache`);
      }
    } catch(e) {
      console.warn('Could not read notes cache from localStorage:', e);
    }
  }

  // Attempt live fetch with one automatic retry
  return await fetchNotesFromNetwork();
}

async function fetchNotesFromNetwork() {
  const attemptFetch = async () => {
    const res = await fetch('/.netlify/functions/sheets');
    if (!res.ok) throw new Error(`Sheets error: ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
  };

  try {
    // First attempt
    const data = await attemptFetch();
    const notes = data.notes || [];
    AppState.set('notes', notes);
    AppState.set('notesLoadedAt', Date.now());
    AppState.set('notesError', null);
    console.log(`Loaded ${notes.length} notes from network`);

    // Log validation summary if available
    if (data.validation) {
      console.log(`Validation: ${data.validation.rowsPassed} passed, ${data.validation.rowsDropped} dropped`);
    }

    // Kick off background embedding so semantic search stays fresh
    // This is fire-and-forget — never blocks the UI
    embedNotesInBackground(notes);

    // Persist to localStorage as stale fallback
    try {
      localStorage.setItem(NOTES_CACHE_KEY, JSON.stringify({
        notes,
        loadedAt: Date.now(),
      }));
    } catch(e) {
      console.warn('Could not persist notes to localStorage:', e);
    }

    return notes;

  } catch (firstErr) {
    console.warn('First fetch attempt failed, retrying once…', firstErr.message);

    // Wait 1.5s then retry once
    await new Promise(r => setTimeout(r, 1500));

    try {
      const data = await attemptFetch();
      const notes = data.notes || [];
      AppState.set('notes', notes);
      AppState.set('notesLoadedAt', Date.now());
      AppState.set('notesError', null);
      console.log(`Loaded ${notes.length} notes on retry`);
      return notes;

    } catch (secondErr) {
      // Both attempts failed — use stale cache if available, else throw
      AppState.set('notesError', secondErr.message);
      if (AppState.notes && AppState.notes.length > 0) {
        console.warn('Network failed twice — serving stale notes from cache');
        showStaleDataBanner();
        return AppState.notes;
      }
      throw secondErr;
    }
  }
}

async function refreshNotes() {
  try {
    const data = await (await fetch('/.netlify/functions/sheets')).json();
    const notes = data.notes || [];
    AppState.set('notes', notes);
    AppState.set('notesLoadedAt', Date.now());
    AppState.set('notesError', null);
    try {
      localStorage.setItem(NOTES_CACHE_KEY, JSON.stringify({ notes, loadedAt: Date.now() }));
    } catch(e) {}
    console.log(`Background refresh: ${notes.length} notes`);
  } catch(e) {
    console.warn('Background refresh failed silently:', e.message);
  }
}

function showStaleDataBanner() {
  // Don't show duplicate banners
  if (document.getElementById('stale-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'stale-banner';
  banner.style.cssText = `
    position: fixed; top: 0; left: 50%; transform: translateX(-50%);
    width: 100%; max-width: 480px; z-index: 500;
    background: #854F0B; color: white;
    padding: 10px 16px; font-size: 12px; font-weight: 500;
    display: flex; align-items: center; justify-content: space-between;
    font-family: 'Inter', sans-serif;
  `;
  banner.innerHTML = `
    <span>⚠️ Showing cached notes — couldn't reach Google Sheets</span>
    <button onclick="this.parentElement.remove();fetchNotes({forceRefresh:true}).catch(()=>{})"
      style="background:rgba(255,255,255,0.2);border:none;color:white;padding:4px 10px;border-radius:6px;font-size:11px;cursor:pointer;font-family:inherit">
      Retry
    </button>
  `;
  document.body.appendChild(banner);
  // Auto-dismiss after 8 seconds
  setTimeout(() => banner.remove(), 8000);
}

// ── SEARCH ──

// Build a stable note ID matching the one used in embed.js
function noteId(note) {
  const key = [
    note['_tab'] || '',
    note['Tag'] || '',
    note['Scripture / Reference'] || '',
    note['Note Title'] || '',
  ].join('|');
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) - hash) + key.charCodeAt(i);
    hash |= 0;
  }
  return `note_${Math.abs(hash)}_${key.length}`;
}

// Pure keyword search — fast, synchronous, always runs
function keywordScore(note, terms) {
  const fromTaggedTab = (note['_tab'] || '') === 'Tagged Notes';
  const tag        = (note['Tag'] || '').toLowerCase();
  const title      = (note['Note Title'] || '').toLowerCase();
  const content    = (note['Note Content'] || '').toLowerCase();
  const scripture  = (note['Scripture / Reference'] || '').toLowerCase();
  const location   = (note['Location Title'] || '').toLowerCase();

  // Use pre-computed _searchText if available (set by sheets.js data integrity layer)
  const everything = note['_searchText'] || Object.values(note).join(' ').toLowerCase();

  const hasTag = tag.trim().length > 0;
  const contentLength = content.trim().length;

  // Use pre-computed _quality if available
  let contentQuality = 0;
  const q = note['_quality'];
  if      (q === 'rich')        contentQuality = 50;
  else if (q === 'substantial') contentQuality = 25;
  else if (q === 'thin')        contentQuality = 8;
  else if (contentLength >= 200) contentQuality = 50;
  else if (contentLength >= 60)  contentQuality = 25;
  else if (contentLength >= 15)  contentQuality = 8;

  let score = 0, matched = false;
  for (const term of terms) {
    if (!term) continue;
    if (hasTag && tag.includes(term))     { score += 70; matched = true; }
    if (title.includes(term))             { score += 60; matched = true; }
    if (content.includes(term))           { score += contentQuality + 20; matched = true; }
    if (scripture.includes(term))         { score += 10; matched = true; }
    if (location.includes(term))          { score += 10; matched = true; }
    if (!matched && everything.includes(term)) { score += 3; matched = true; }
  }
  if (!matched) return 0;
  if (fromTaggedTab) score += 8;
  return score;
}

// Synchronous keyword-only search — used as immediate results while semantic runs
function searchNotes(notes, keywordStr, limit = 20) {
  const terms = keywordStr.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
  if (!terms.length) return [];

  const scored = [];
  for (const note of notes) {
    const score = keywordScore(note, terms);
    if (score > 0) scored.push({ note, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.note);
}

// Async semantic search — blends keyword scores with OpenAI semantic similarity.
// Returns enhanced results if embeddings are available, falls back to keyword-only
// silently if the embed function is unavailable or slow.
async function searchNotesSemantic(notes, queryStr, limit = 20) {
  const terms = queryStr.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
  if (!terms.length) return [];

  // Build keyword score map first (always runs, fast)
  const keywordMap = new Map();
  for (const note of notes) {
    const score = keywordScore(note, terms);
    if (score > 0) keywordMap.set(noteId(note), { note, score });
  }

  // Attempt semantic search with a 4-second timeout so slow network
  // never blocks the user — falls back to keyword results
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);

    const res = await fetch('/.netlify/functions/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'semantic-search', query: queryStr }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) throw new Error(`Embed function returned ${res.status}`);
    const data = await res.json();
    const semanticMatches = data.matches || [];

    if (!semanticMatches.length) {
      // No semantic results — return keyword results
      return Array.from(keywordMap.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(s => s.note);
    }

    // Build a note lookup by noteId for semantic matching
    const noteLookup = new Map();
    for (const note of notes) {
      noteLookup.set(noteId(note), note);
    }

    // Blend scores:
    // - Keyword score (0–200+) normalized to 0–100
    // - Semantic similarity (0–1) scaled to 0–80
    // Keyword still dominates for exact tag/title matches,
    // but semantic pulls in related notes that keyword misses entirely
    const maxKeyword = Math.max(...Array.from(keywordMap.values()).map(v => v.score), 1);
    const blended = new Map();

    // Add keyword-scored notes
    for (const [id, { note, score }] of keywordMap) {
      const normalizedKeyword = (score / maxKeyword) * 100;
      blended.set(id, { note, score: normalizedKeyword, source: 'keyword' });
    }

    // Blend in semantic matches
    for (const match of semanticMatches) {
      const note = noteLookup.get(match.note_id);
      if (!note) continue;

      const semanticScore = match.similarity * 80;
      const existing = blended.get(match.note_id);

      if (existing) {
        // Note found by both — combine scores, keyword gets priority
        blended.set(match.note_id, {
          note,
          score: existing.score + semanticScore * 0.5,
          source: 'both',
        });
      } else {
        // Semantic-only match — surfaces related notes keyword missed
        blended.set(match.note_id, {
          note,
          score: semanticScore,
          source: 'semantic',
        });
      }
    }

    const results = Array.from(blended.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.note);

    console.log(`Search "${queryStr}": ${results.length} results (keyword: ${keywordMap.size}, semantic: ${semanticMatches.length})`);
    return results;

  } catch (err) {
    // Semantic failed — fall back to keyword silently
    if (err.name !== 'AbortError') {
      console.warn('Semantic search failed, using keyword fallback:', err.message);
    } else {
      console.warn('Semantic search timed out, using keyword fallback');
    }
    return Array.from(keywordMap.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.note);
  }
}

// Background embedding — called after notes are fetched to keep vectors fresh.
// Runs silently, never blocks the UI.
async function embedNotesInBackground(notes) {
  try {
    const res = await fetch('/.netlify/functions/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'embed-notes', notes }),
    });
    const data = await res.json();
    if (data.embedded > 0) {
      console.log(`Background embedding complete: ${data.embedded} new, ${data.skipped} unchanged`);
    }
  } catch (err) {
    console.warn('Background embedding failed silently:', err.message);
  }
}

// ── THEMES LIST ──
function renderThemes() {
  const query = (document.getElementById('theme-search')?.value || '').toLowerCase();
  const list = document.getElementById('themes-list');

  if (AppState.themes.length === 0 && !query) {
    list.innerHTML = `
      <div class="empty-themes">
        <div class="big-icon">🌊</div>
        <h3>No study notes yet</h3>
        <p>Create your first study note topic and Deep Dive will search your notes for everything related to it.</p>
        <button onclick="openModal()">
          <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add your first study note
        </button>
      </div>`;
    return;
  }

  const sorted = [...AppState.themes].reverse();
  const filtered = sorted.filter(t => t.name.toLowerCase().includes(query));

  list.innerHTML = filtered.map((t) => {
    const originalIndex = AppState.themes.indexOf(t);
    return `
      <div class="theme-row" onclick="openTheme(${originalIndex})">
        <span class="theme-name">${esc(t.name)}</span>
        <span class="theme-arrow"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></span>
      </div>`;
  }).join('') + `
    <div class="add-row" onclick="openModal()">
      <svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add new study note
    </div>`;
}

// ── THEME DETAIL ──
const PAGE_SIZE = 10;


async function openTheme(index) {
  const theme = AppState.themes[index];
  AppState.set('currentTheme', theme);
  AppState.set('detailPage', 0);
  AppState.set('detailAllMatches', []);
  document.getElementById('detail-title').textContent = theme.name;
  document.getElementById('detail-content').innerHTML = `<div class="loading-state"><div class="spinner"></div>Searching your notes for "${esc(theme.name)}"…</div>`;
  goTo('detail');

  try {
    const notes = await fetchNotes();
    AppState.set('detailAllMatches', await searchNotesSemantic(notes, theme.keywords || theme.name));
    renderDetail(theme, AppState.detailAllMatches, 0);
    addHistory({ type: 'theme', title: theme.name, count: AppState.detailAllMatches.length, payload: { name: theme.name, keywords: theme.keywords || theme.name } });
  } catch (err) {
    console.error('openTheme error:', err);
    AppState.set('notesError', err.message);
    document.getElementById('detail-content').innerHTML = `
      <div class="empty-state">
        <p>Could not load notes.</p>
        <p style="font-size:12px;color:var(--text3);margin-top:8px">${esc(err.message)}</p>
        <button class="note-action" style="margin-top:16px;padding:10px 20px"
          onclick="openTheme(${JSON.stringify(index)})">
          Retry
        </button>
      </div>`;
  }
}

function renderDetail(theme, allMatches, page) {
  AppState.set('detailPage', page);
  const el = document.getElementById('detail-content');
  const total = allMatches.length;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const start = page * PAGE_SIZE;
  const matches = allMatches.slice(start, start + PAGE_SIZE);

  if (total === 0) {
    el.innerHTML = `
      <span class="source-pill">Google Sheets — 0 matches</span>
      <div class="empty-state">
        <p>No notes found for "<strong>${esc(theme.name)}</strong>".<br><br>
        Try adding more keywords, or make sure your Google Sheet has notes tagged with related terms.</p>
      </div>`;
    return;
  }

  const cards = matches.map((note, i) => {
    const globalI = start + i;
    const tag      = note['Tag'] || '';
    const title    = note['Note Title'] || note['Scripture / Reference'] || '';
    const body     = note['Note Content'] || '';
    const scripture = note['Scripture / Reference'] || '';
    const book     = note['Bible Book'] || '';
    const chapter  = note['Chapter'] || '';
    const verse    = note['Verse / Block'] || '';
    const location = note['Location Title'] || '';
    const pub      = note['Publication'] || note['Publicatoin'] || '';
    const tab      = note['_tab'] || 'Google Sheets';
    const displayTitle = title || scripture || `Note ${globalI + 1}`;
    const ref = [scripture || (book ? `${book} ${chapter}:${verse}`.trim() : ''), location, pub, tab].filter(Boolean).join(' · ');

    return `
      <div class="note-card">
        <div class="note-head" onclick="toggleNote('n${globalI}')" role="button" aria-expanded="false" id="n${globalI}-h">
          ${tag ? `<span class="note-tag-pill">${esc(tag)}</span>` : ''}
          <span class="note-summary">${esc(displayTitle)}</span>
          <span class="note-chev" id="n${globalI}-c"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></span>
        </div>
        <div class="note-body" id="n${globalI}">
          <p class="note-full">${esc(body) || 'No content recorded.'}</p>
          ${ref ? `<p class="note-ref">${esc(ref)}</p>` : ''}
          <div class="note-actions">
            <button class="note-action" onclick="prefillChat('Tell me more about: ${esc(displayTitle).replace(/'/g,"\\'")}')">
              <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
              Ask about this
            </button>
            ${tag ? `<button class="note-action" onclick="prefillChat('Find all notes related to: ${esc(tag).replace(/'/g,"\\'")}')">
              <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              Find related
            </button>` : ''}
          </div>
        </div>
      </div>`;
  }).join('');

  const paginationBar = totalPages > 1 ? `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:16px;gap:8px">
      <button class="note-action" style="flex:1;justify-content:center;padding:10px"
        onclick="renderDetail(AppState.currentTheme, AppState.detailAllMatches, ${page - 1}); window.scrollTo(0,0)"
        ${page === 0 ? 'disabled style="flex:1;justify-content:center;padding:10px;opacity:0.35;cursor:default"' : ''}>← Prev</button>
      <span style="font-size:12px;color:var(--text3);white-space:nowrap">Page ${page + 1} of ${totalPages}</span>
      <button class="note-action" style="flex:1;justify-content:center;padding:10px"
        onclick="renderDetail(AppState.currentTheme, AppState.detailAllMatches, ${page + 1}); window.scrollTo(0,0)"
        ${page >= totalPages - 1 ? 'disabled style="flex:1;justify-content:center;padding:10px;opacity:0.35;cursor:default"' : ''}>Next →</button>
    </div>` : '';

  el.innerHTML = `
    <span class="source-pill">Google Sheets — ${total} note${total !== 1 ? 's' : ''} found</span>
    <p style="font-size:13px;color:var(--text3);margin-bottom:16px">Showing ${start + 1}–${Math.min(start + PAGE_SIZE, total)} of ${total} · Tap any row to expand</p>
    ${cards}
    ${paginationBar}
    <div style="margin-top:12px">
      <button class="note-action" style="padding:11px 16px;font-size:13px;width:100%;justify-content:center"
        onclick="prefillChat('Summarize everything I have on: ${esc(theme.name).replace(/'/g,"\\'")}')">
        <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Ask Claude to summarize this theme
      </button>
    </div>`;
}

function toggleNote(id) {
  const body = document.getElementById(id);
  const chev = document.getElementById(id + '-c');
  const isOpen = body.classList.contains('open');
  body.classList.toggle('open', !isOpen);
  chev.classList.toggle('open', !isOpen);
}

// ── PIONEER TABS ──
function switchPioneerTab(tab) {
  const xref = document.getElementById('pioneer-xref-pane');
  const explore = document.getElementById('pioneer-explore-pane');
  const btnX = document.getElementById('pioneer-tab-xref');
  const btnE = document.getElementById('pioneer-tab-explore');
  if (tab === 'xref') {
    xref.style.display = ''; explore.style.display = 'none';
    btnX.style.background = 'var(--gold)'; btnX.style.color = 'var(--navy)';
    btnE.style.background = 'rgba(255,255,255,0.12)'; btnE.style.color = 'rgba(255,255,255,0.7)';
  } else {
    xref.style.display = 'none'; explore.style.display = '';
    btnE.style.background = 'var(--gold)'; btnE.style.color = 'var(--navy)';
    btnX.style.background = 'rgba(255,255,255,0.12)'; btnX.style.color = 'rgba(255,255,255,0.7)';
    AppState.set('explorePage', 0);
    renderExploreUnits(0);
  }
}

const EXPLORE_PAGE_SIZE = 12;

function renderExploreUnits(page = 0) {
  AppState.set('explorePage', page);
  const el = document.getElementById('explore-units-list');
  const total = PIONEER_UNITS.length;
  const totalPages = Math.ceil(total / EXPLORE_PAGE_SIZE);
  const start = page * EXPLORE_PAGE_SIZE;
  const slice = PIONEER_UNITS.slice(start, start + EXPLORE_PAGE_SIZE);

  const cards = slice.map((u, i) => `
    <div class="unit-card" onclick="openExploreUnit(${start + i})">
      <p class="unit-number">Unit ${esc(u.id)}</p>
      <p class="unit-title">${esc(u.title)}</p>
      <p style="font-size:11px;color:var(--text3);margin-top:4px">${u.questions.length} question${u.questions.length !== 1 ? 's' : ''}</p>
    </div>`).join('');

  const pagination = totalPages > 1 ? `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-top:8px;gap:8px">
      <button class="note-action" style="flex:1;justify-content:center;padding:10px"
        onclick="renderExploreUnits(${page - 1}); window.scrollTo(0,0)"
        ${page === 0 ? 'disabled style="flex:1;justify-content:center;padding:10px;opacity:0.35;cursor:default"' : ''}>← Prev</button>
      <span style="font-size:12px;color:var(--text3);white-space:nowrap">Page ${page + 1} of ${totalPages}</span>
      <button class="note-action" style="flex:1;justify-content:center;padding:10px"
        onclick="renderExploreUnits(${page + 1}); window.scrollTo(0,0)"
        ${page >= totalPages - 1 ? 'disabled style="flex:1;justify-content:center;padding:10px;opacity:0.35;cursor:default"' : ''}>Next →</button>
    </div>` : '';

  el.innerHTML = cards + pagination;
}

let currentExploreUnit = null;

function openExploreUnit(i) {
  AppState.set('currentExploreUnit', PIONEER_UNITS[i]);
  document.getElementById('questions-title').textContent = AppState.currentExploreUnit.title;
  const el = document.getElementById('questions-content');
  el.innerHTML = `<p style="font-size:13px;color:var(--text3);margin-bottom:16px;line-height:1.5">Tap a question — Deep Dive will search your notes for the answer.</p>` +
    AppState.currentExploreUnit.questions.map((q, qi) => `
      <div class="unit-card" onclick="openQuestionAnswer(${i}, ${qi})" style="display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:11px;font-weight:700;color:var(--gold);margin-top:2px;flex-shrink:0">Q${qi+1}</span>
        <span style="font-size:14px;line-height:1.5;color:var(--text)">${esc(q)}</span>
      </div>`).join('');
  goTo('pioneer-questions');
}

async function openQuestionAnswer(unitIdx, qIdx) {
  const unit = PIONEER_UNITS[unitIdx];
  const question = unit.questions[qIdx];
  document.getElementById('answer-question-title').textContent = question.length > 60 ? question.slice(0, 57) + '…' : question;
  document.getElementById('answer-content').innerHTML = `<div class="loading-state"><div class="spinner"></div>Searching your notes…</div>`;
  goTo('pioneer-answer');

  try {
    const notes = await fetchNotes();
    const keywords = question.replace(/[^a-zA-Z\s]/g, ' ').split(/\s+/).filter(w => w.length > 4).join(',');
    const matches = searchNotes(notes, keywords, 15);
    const el = document.getElementById('answer-content');

    const matchCards = matches.length === 0
      ? `<div class="empty-state"><p>No matching notes found for this question yet.</p></div>`
      : matches.map((note, i) => {
          const tag = note['Tag'] || '';
          const title = note['Note Title'] || note['Scripture / Reference'] || `Note ${i+1}`;
          const body = note['Note Content'] || '';
          const ref = note['Scripture / Reference'] || '';
          const tab = note['_tab'] || '';
          return `
            <div class="note-card">
              <div class="note-head" onclick="toggleNote('qa${i}')" id="qa${i}-h">
                ${tag ? `<span class="note-tag-pill">${esc(tag)}</span>` : ''}
                <span class="note-summary">${esc(title)}</span>
                <span class="note-chev" id="qa${i}-c"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></span>
              </div>
              <div class="note-body" id="qa${i}">
                <p class="note-full">${esc(body) || 'No content recorded.'}</p>
                ${ref ? `<p class="note-ref">${esc(ref)}${tab ? ' · ' + esc(tab) : ''}</p>` : ''}
                <div class="note-actions">
                  <button class="note-action" onclick="prefillChat('Based on this question from the Pioneer School book, what do my notes say? Question: ${esc(question).replace(/'/g,"\\'")} Note: ${esc(title).replace(/'/g,"\\'")}')">
                    <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                    Ask Claude about this
                  </button>
                </div>
              </div>
            </div>`;
        }).join('');

    el.innerHTML = `
      <div style="background:var(--surface);border-radius:var(--radius);padding:14px 16px;margin-bottom:16px;box-shadow:0 1px 3px rgba(13,27,42,0.07)">
        <p style="font-size:10px;font-weight:700;color:var(--text3);letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px">Question</p>
        <p style="font-size:14px;line-height:1.6;color:var(--text)">${esc(question)}</p>
      </div>
      <span class="source-pill">Your notes — ${matches.length} match${matches.length !== 1 ? 'es' : ''}</span>
      ${matchCards}
      <div style="margin-top:16px">
        <button class="note-action" style="padding:11px 16px;font-size:13px;width:100%;justify-content:center"
          onclick="prefillChat('Pioneer School question: ${esc(question).replace(/'/g,"\\'")} — what do my notes say about this?')">
          <svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Ask Claude to answer from my notes
        </button>
      </div>`;
  } catch (err) {
    document.getElementById('answer-content').innerHTML = `<div class="empty-state"><p>Could not load notes. ${esc(err.message)}</p></div>`;
  }
}

// ── PIONEER ──
const UNITS = [
  { number: "Unit 1b", title: "Fortify Your Relationship With Jehovah", keywords: "jehovah,relationship,study,meditation,bible,reading,prayer,love" },
  { number: "Unit 2a", title: "Using the New World Translation—Part 1", keywords: "translation,new world,bible,scriptures,jehovah,name,accurate" },
  { number: "Unit 2b", title: "Using the New World Translation—Part 2", keywords: "footnotes,translation,scriptures,bible,glossary" },
  { number: "Unit 3a", title: "Keep Pace With Spiritual Enlightenment", keywords: "spiritual,enlightenment,jehovah,truth,progressive,light" },
  { number: "Unit 4a", title: "Uphold Jehovah's Sovereignty", keywords: "sovereignty,jehovah,loyalty,integrity,neutrality,kingdom" },
  { number: "Unit 4b", title: "Show Personal Interest in Others", keywords: "personal interest,ministry,preaching,territory,witness,people" },
  { number: "Unit 5a", title: "From House to House—Our Principal Way of Preaching", keywords: "house to house,preach,ministry,jesus,commission,field service" },
  { number: "Unit 6a", title: "Women Who Make Jehovah's Heart Rejoice", keywords: "women,jehovah,dignity,helper,congregation,role" },
  { number: "Unit 7a", title: "Benefit From Counsel and Direction", keywords: "counsel,direction,congregation,elders,oversight,jesus" },
  { number: "Unit 7b", title: "Resist the Spirit of the World", keywords: "spirit of the world,resist,worldly,christian,temptation" },
  { number: "Unit 8a", title: "Walk in the Way of Integrity", keywords: "integrity,neutrality,loyalty,christian,honesty,faithful" },
  { number: "Unit 8b", title: "Participate in Various Forms of Our Ministry", keywords: "informal witnessing,ministry,conversation,preach,kingdom,witness" },
  { number: "Unit 10a", title: "Appreciate Jesus' Role", keywords: "jesus,firstborn,creation,son,role,appreciate" },
  { number: "Unit 10b", title: "Think in Terms of Bible Principles", keywords: "principles,bible,laws,apply,student,wisdom" },
  { number: "Unit 11a", title: "Examine Your Spiritual Progress", keywords: "spiritual,progress,meditation,bible,mind of christ,humility" },
  { number: "Unit 11b", title: "Make Effective Return Visits", keywords: "return visit,householder,interest,bible study,follow up" },
  { number: "Unit 13a", title: "Learn From the Master", keywords: "jesus,master,example,learn,imitate" },
  { number: "Unit 13b", title: "Conduct Progressive Bible Studies—Part 1", keywords: "bible study,teaching,progressive,student,conduct" },
  { number: "Unit 14a", title: "Conduct Progressive Bible Studies—Part 2", keywords: "bible study,questions,teaching,student,auxiliary questions,heart" },
  { number: "Unit 15a", title: "Help Others Press On to Maturity", keywords: "maturity,bible student,progress,speaking,sharing,encourage" },
  { number: "Unit 16a", title: "The Joy of Jehovah Is Your Stronghold", keywords: "joy,jehovah,holy spirit,stronghold,happiness,source" },
  { number: "Unit 16b", title: "Jehovah Blesses Those Trusting In Him", keywords: "trust,jehovah,loyal love,blessing,faithful,reliability" },
  { number: "Unit 17a", title: "Persevere in Prayer", keywords: "prayer,persevere,jehovah,answer,faith,petition" },
  { number: "Unit 17b", title: "Endurance Leads to an Approved Condition", keywords: "endurance,trials,faithful,job,approved,approved condition,persecution" },
];

function renderPioneer() {
  document.getElementById('units-list').innerHTML = UNITS.map((u, i) => `
    <div class="unit-card" onclick="openUnit(${i})">
      <p class="unit-number">${esc(u.number)}</p>
      <p class="unit-title">${esc(u.title)}</p>
    </div>`).join('');
}

async function openUnit(i) {
  const unit = UNITS[i];
  document.getElementById('pioneer-detail-title').textContent = `${unit.number} — ${unit.title}`;
  document.getElementById('pioneer-detail-content').innerHTML = `<div class="loading-state"><div class="spinner"></div>Cross-referencing your notes with ${esc(unit.number)}…</div>`;
  goTo('pioneer-detail');

  try {
    const notes = await fetchNotes();
    const matches = searchNotes(notes, unit.keywords);
    const el = document.getElementById('pioneer-detail-content');

    if (matches.length === 0) {
      el.innerHTML = `<div class="empty-state"><p>No matching notes found for this unit yet.</p></div>`;
      return;
    }

    el.innerHTML = `
      <p style="font-size:13px;color:var(--text3);margin-bottom:14px">${matches.length} notes match this unit</p>
      ${matches.map((note, i) => {
        const tag   = note['Tag'] || '';
        const title = note['Note Title'] || note['Scripture / Reference'] || `Note ${i+1}`;
        const body  = note['Note Content'] || '';
        const ref   = note['Scripture / Reference'] || '';
        const tab   = note['_tab'] || '';
        return `
          <div class="note-card">
            <div class="note-head" onclick="toggleNote('pu${i}')" id="pu${i}-h">
              ${tag ? `<span class="note-tag-pill">${esc(tag)}</span>` : ''}
              <span class="note-summary">${esc(title)}</span>
              <span class="note-chev" id="pu${i}-c"><svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg></span>
            </div>
            <div class="note-body" id="pu${i}">
              <p class="note-full">${esc(body) || 'No content recorded.'}</p>
              ${ref ? `<p class="note-ref">${esc(ref)}${tab ? ' · ' + esc(tab) : ''}</p>` : ''}
            </div>
          </div>`;
      }).join('')}`;

    addHistory({ type: 'theme', title: `Pioneer: ${unit.title}`, count: matches.length, payload: { name: unit.title, keywords: unit.keywords } });
  } catch (err) {
    document.getElementById('pioneer-detail-content').innerHTML = `<div class="empty-state"><p>Could not load notes. ${esc(err.message)}</p></div>`;
  }
}

// ── CHAT ──


async function sendChat(msgOverride) {
  const input = document.getElementById('chat-input');
  const msg = msgOverride || input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';

  appendBubble(msg, 'me');
  AppState.chatHistory.push({ role: 'user', content: msg });
  const typing = appendTyping();

  try {
    const notes = await fetchNotes();
    const stopwords = new Set(['what','that','this','with','have','from','they','their','which','when','will','were','been','your','more','some','does','about','would','could','should','than','also','into','other','there','then','these','those','such','much','many','both','where','while','make','made','even','just','like','very','well','only','most','the','and','for','are','but','not','you','all','can','how','why','did','tell','find','give','show','know','want','need','help','please','okay','anything','something','everything','nothing']);
    const keywords = msg.toLowerCase().replace(/[^a-z\s]/g,' ').split(/\s+/).filter(w => w.length > 3 && !stopwords.has(w)).join(',');
    const relevant = keywords ? searchNotes(notes, keywords, 20) : [];

    const payload = relevant.map(n => ({
      tab: n['_tab'] || '', tag: n['Tag'] || '',
      scripture: n['Scripture / Reference'] || '',
      title: n['Note Title'] || '', content: n['Note Content'] || '',
    }));

    const res = await fetch('/.netlify/functions/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, notes: payload, history: AppState.chatHistory.slice(-10) }),
    });

    const data = await res.json();
    typing.remove();

    const reply = data.error ? `Sorry — ${data.error}` : data.reply;
    AppState.chatHistory.push({ role: 'assistant', content: reply });
    const replyBubble = appendBubble(reply, 'them');
    speakReply(reply, replyBubble);
    if (data.suggestions && data.suggestions.length > 0) appendSuggestions(data.suggestions);
    addHistory({ type: 'chat', title: msg.substring(0, 60), count: 0, payload: { message: msg, reply } });

  } catch (err) {
    typing.remove();
    AppState.chatHistory.pop();
    appendBubble(`Error: ${err.message || 'Could not connect. Check your internet and try again.'}`, 'them');
    console.error('sendChat error:', err);
  }
}

function clearChat() {
  AppState.set('chatHistory', []);
  AppState.set('notes', null);
  AppState.set('notesLoadedAt', null);
  const msgs = document.getElementById('chat-messages');
  msgs.innerHTML = '<div class="bubble-them">Hi Mickey! Tap the mic and speak, or type below. I\'ll search your notes and read the answer back to you.</div>';
}

function appendBubble(text, who) {
  const msgs = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = who === 'me' ? 'bubble-me' : 'bubble-them';
  div.textContent = text;
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function appendTyping() {
  const msgs = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'bubble-them typing';
  div.innerHTML = '<span></span><span></span><span></span>';
  msgs.appendChild(div);
  msgs.scrollTop = msgs.scrollHeight;
  return div;
}

function appendSuggestions(suggestions) {
  const msgs = document.getElementById('chat-messages');
  const row = document.createElement('div');
  row.className = 'suggestions-row';
  suggestions.forEach(s => {
    const chip = document.createElement('button');
    chip.className = 'suggestion-chip';
    chip.textContent = s;
    chip.onclick = () => { row.remove(); sendChat(s); };
    row.appendChild(chip);
  });
  msgs.appendChild(row);
  msgs.scrollTop = msgs.scrollHeight;
}

function prefillChat(text) {
  goTo('chat');
  document.getElementById('chat-input').value = text;
}

function autoGrowInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ── VOICE ──
function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showToast('Voice not supported — try Chrome'); return; }
  if (AppState.isListening) { stopListening(); return; }

  synth.cancel();
  AppState.set('recognition', new SR());
  AppState.recognition.continuous = false;
  AppState.recognition.interimResults = true;
  AppState.recognition.lang = 'en-US';

  AppState.recognition.onstart = () => {
    AppState.set('isListening', true);
    document.getElementById('voice-btn').classList.add('listening');
    setVoiceStatus('Listening…', true);
  };

  AppState.recognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    document.getElementById('chat-input').value = transcript;
    if (e.results[0].isFinal) setVoiceStatus('Got it — searching…', true);
  };

  AppState.recognition.onend = () => {
    AppState.set('isListening', false);
    document.getElementById('voice-btn').classList.remove('listening');
    setVoiceStatus('Tap the mic to speak', false);
    const msg = document.getElementById('chat-input').value.trim();
    if (msg) sendChat(msg);
  };

  AppState.recognition.onerror = (e) => {
    AppState.set('isListening', false);
    document.getElementById('voice-btn').classList.remove('listening');
    setVoiceStatus('Tap the mic to speak', false);
    if (e.error === 'aborted') return;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') showToast('Microphone access denied — check your settings');
    else if (e.error === 'network') showToast('Connection issue — try again');
    else if (e.error === 'no-speech') showToast('Didn\'t catch that — try again');
    else if (e.error === 'audio-capture') showToast('Mic unavailable — close other apps and try again');
    else showToast('Voice error: ' + e.error);
  };

  AppState.recognition.start();
}

function stopListening() {
  AppState.recognition?.stop();
  AppState.set('isListening', false);
  document.getElementById('voice-btn').classList.remove('listening');
  setVoiceStatus('Tap the mic to speak', false);
}

function setVoiceStatus(text, active) {
  const el = document.getElementById('voice-status');
  el.textContent = text;
  el.classList.toggle('active', active);
}

// ── TTS ──
async function speakReply(text, bubbleEl) {
  if (AppState.currentAudio) { AppState.currentAudio.pause(); AppState.set('currentAudio', null); }
  AppState.set('currentAudioQueue', []);

  try {
    const res = await fetch('/.netlify/functions/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) { console.error('TTS request failed', res.status); return; }

    const data = await res.json();
    if (data.error || !data.audioChunks || !data.audioChunks.length) { console.error('TTS error:', data.error); return; }

    AppState.set('currentAudioQueue', data.audioChunks.map(b64 => new Audio('data:audio/mpeg;base64,' + b64)));
    playQueue(AppState.currentAudioQueue, 0, bubbleEl);
  } catch (err) {
    console.error('speakReply error:', err);
  }
}

function playQueue(queue, index, bubbleEl) {
  if (index >= queue.length) return;
  const audio = queue[index];
  AppState.set('currentAudio', audio);
  audio.onended = () => playQueue(queue, index + 1, bubbleEl);
  audio.play().catch(() => {
    if (bubbleEl) showReplayButton(bubbleEl, () => playQueue(queue, index, bubbleEl));
  });
}

function showReplayButton(bubbleEl, onReplay) {
  const handleReplay = () => { onReplay(); removeButtons(); };
  const makeBtn = () => {
    const btn = document.createElement('button');
    btn.className = 'replay-btn';
    btn.innerHTML = `<svg viewBox="0 0 24 24"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg> Tap to hear`;
    btn.onclick = handleReplay;
    return btn;
  };
  const topBtn = makeBtn();
  const bottomBtn = makeBtn();
  function removeButtons() { topBtn.remove(); bottomBtn.remove(); }
  if (!bubbleEl.previousElementSibling?.classList?.contains('replay-btn')) bubbleEl.insertAdjacentElement('beforebegin', topBtn);
  if (!bubbleEl.nextElementSibling?.classList?.contains('replay-btn')) bubbleEl.insertAdjacentElement('afterend', bottomBtn);
}

// ── MODAL ──
function openModal() {
  document.getElementById('modal').classList.add('open');
  setTimeout(() => document.getElementById('new-name').focus(), 100);
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }
function handleOverlayClick(e) { if (e.target.id === 'modal') closeModal(); }

function saveTheme() {
  const name = document.getElementById('new-name').value.trim();
  if (!name) { document.getElementById('new-name').focus(); return; }
  const keywords = document.getElementById('new-keywords').value.trim() || name;
  AppState.themes.push({ name, keywords });
  AppState.save('themes');
  document.getElementById('new-name').value = '';
  document.getElementById('new-keywords').value = '';
  closeModal();
  showToast(`"${name}" saved`);
  openTheme(AppState.themes.length - 1);
}

// ── HISTORY ──
function addHistory(entry) {
  if (typeof entry === 'string') entry = { type: 'chat', title: entry, count: 0, payload: {} };
  entry.date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  AppState.history.unshift(entry);
  AppState.history = AppState.history.slice(0, 100);
  AppState.save('history');
}

function clearHistory() {
  if (!AppState.history.length) { showToast('Nothing to clear'); return; }
  if (!confirm('Clear all history? This cannot be undone.')) return;
  history = [];
  AppState.save('history');
  renderHistory();
  showToast('History cleared');
}

function deleteHistoryItem(index, e) {
  e.stopPropagation();
  history.splice(index, 1);
  AppState.save('history');
  renderHistory();
}

function toggleHistoryItem(i) {
  const body = document.getElementById('hbody-' + i);
  const chev = document.getElementById('hchev-' + i);
  const wasOpen = body.classList.contains('open');
  body.classList.toggle('open', !wasOpen);
  chev.classList.toggle('open', !wasOpen);
  if (!wasOpen && !body.dataset.loaded) {
    body.dataset.loaded = 'true';
    loadHistoryContent(i, body);
  }
}

async function loadHistoryContent(i, body) {
  const h = AppState.history[i];
  if (!h || !h.payload) return;

  if (h.type === 'theme') {
    body.innerHTML = `<div class="loading-state" style="padding:20px"><div class="spinner"></div>Loading notes…</div>`;
    try {
      const notes = await fetchNotes();
      const matches = searchNotes(notes, h.payload.keywords || h.payload.name, 20);
      const rerunBtn = `<button class="history-rerun-btn" onclick="openThemeByName('${esc(h.payload.name).replace(/'/g,"\\'")}','${esc(h.payload.keywords || h.payload.name).replace(/'/g,"\\'")}')"><svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>Search again</button>`;

      if (!matches.length) {
        body.innerHTML = `<p style="font-size:13px;color:var(--text3);padding:14px 14px 4px">No notes found.</p>${rerunBtn}`;
        return;
      }

      const cards = matches.map((note, ni) => {
        const tag = note['Tag'] || '';
        const title = note['Note Title'] || note['Scripture / Reference'] || `Note ${ni+1}`;
        const content = note['Note Content'] || '';
        const ref = note['Scripture / Reference'] || '';
        const tab = note['_tab'] || '';
        return `
          <div class="history-note-card">
            <div class="history-note-head" onclick="toggleHistoryNote('hn${i}-${ni}','hnc${i}-${ni}')">
              ${tag ? `<span class="note-tag-pill">${esc(tag)}</span>` : ''}
              <span class="note-summary" style="font-size:12px">${esc(title)}</span>
              <span class="history-note-chev" id="hnc${i}-${ni}">▼</span>
            </div>
            <div class="history-note-body" id="hn${i}-${ni}">
              <p class="note-full" style="font-size:12px">${esc(content) || 'No content recorded.'}</p>
              ${ref ? `<p class="note-ref">${esc(ref)}${tab ? ' · ' + esc(tab) : ''}</p>` : ''}
            </div>
          </div>`;
      }).join('');

      body.innerHTML = `<p style="font-size:11px;color:var(--text3);padding:10px 14px 4px">${matches.length} notes found</p>${cards}${rerunBtn}`;
    } catch(err) {
      body.innerHTML = `<p style="font-size:13px;color:var(--text3);padding:14px">Could not load notes.</p>`;
    }

  } else if (h.type === 'chat') {
    const rerunBtn = `<button class="history-rerun-btn" onclick="reaskChat(${JSON.stringify(h.payload.message || '')})"><svg viewBox="0 0 24 24"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4"/></svg>Ask again</button>`;
    body.innerHTML = `
      <div class="history-chat-q">${esc(h.payload.message || '')}</div>
      <div class="history-chat-r">${esc(h.payload.reply || 'No reply recorded.')}</div>
      ${rerunBtn}`;
  }
}

function toggleHistoryNote(bodyId, chevId) {
  document.getElementById(bodyId)?.classList.toggle('open');
  document.getElementById(chevId)?.classList.toggle('open');
}

function openThemeByName(name, keywords) {
  const idx = AppState.themes.findIndex(t => t.name === name);
  if (idx !== -1) {
    openTheme(idx);
  } else {
    AppState.set('currentTheme', { name, keywords });
    document.getElementById('detail-title').textContent = name;
    document.getElementById('detail-content').innerHTML = `<div class="loading-state"><div class="spinner"></div>Searching…</div>`;
    goTo('detail');
    fetchNotes().then(async notes => {
      AppState.set('detailAllMatches', await searchNotesSemantic(notes, keywords || name));
      renderDetail(AppState.currentTheme, AppState.detailAllMatches, 0);
    }).catch(err => {
      document.getElementById('detail-content').innerHTML =
        `<div class="empty-state"><p>Could not load notes.<br><small style="color:var(--text3)">${esc(err.message)}</small></p>
        <button class="note-action" style="margin-top:16px" onclick="fetchNotes({forceRefresh:true}).then(n=>renderDetail(AppState.currentTheme,searchNotes(n,${JSON.stringify(keywords||name)}),0))">
          Retry
        </button></div>`;
    });
  }
}

function reaskChat(msg) {
  goTo('chat');
  sendChat(msg);
}

function renderHistory() {
  const el = document.getElementById('history-content');
  if (!AppState.history.length) {
    el.innerHTML = '<div class="empty-state"><p>Your sessions will appear here as you explore themes and chat.</p></div>';
    return;
  }

  el.innerHTML = AppState.history.map((h, i) => {
    const isTheme = h.type === 'theme';
    const iconStyle = isTheme ? 'background:#E8F5EE;color:#0F6E56' : 'background:#FDF3E3;color:#854F0B';
    const iconSvg = isTheme
      ? `<svg viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`
      : `<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
    const subtitle = isTheme ? `Study notes search${h.count ? ' · ' + h.count + ' notes' : ''}` : 'Chat';

    return `
      <div class="history-item">
        <div class="history-head" onclick="toggleHistoryItem(${i})">
          <div class="history-type-icon" style="${iconStyle}">${iconSvg}</div>
          <div class="history-meta">
            <p class="history-date">${esc(h.date || '')}</p>
            <p class="history-title">${esc(h.title || '')}</p>
            <p class="history-preview">${esc(subtitle)}</p>
          </div>
          <button class="history-delete-btn" onclick="deleteHistoryItem(${i}, event)" aria-label="Delete">
            <svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
          <div class="history-chev" id="hchev-${i}">
            <svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
        </div>
        <div class="history-body" id="hbody-${i}"></div>
      </div>`;
  }).join('');
}

// ── EXPORT ──
function exportTheme() {
  if (!AppState.currentTheme) return;
  const cards = document.querySelectorAll('#detail-content .note-card');
  let text = `Deep Dive Export\nTheme: ${AppState.currentTheme.name}\nDate: ${new Date().toLocaleDateString()}\n${'─'.repeat(50)}\n\n`;
  cards.forEach((card, i) => {
    const tag     = card.querySelector('.note-tag-pill')?.textContent?.trim() || '';
    const summary = card.querySelector('.note-summary')?.textContent?.trim() || '';
    const full    = card.querySelector('.note-full')?.textContent?.trim() || '';
    const ref     = card.querySelector('.note-ref')?.textContent?.trim() || '';
    text += `${i + 1}. ${tag ? '[' + tag + '] ' : ''}${summary}\n\n${full}\n${ref ? 'Source: ' + ref : ''}\n\n${'─'.repeat(50)}\n\n`;
  });
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `deepdive-${AppState.currentTheme.name.replace(/\s+/g,'-').toLowerCase()}.txt`;
  a.click();
  showToast('Exported');
}

// ── COLOR THEMES ──
const THEMES = [
  { name: 'Midnight Ink', navy: '#0D1B2A', navyMid: '#152436', navySoft: '#1B2E42', accent: '#E8C060', accentDim: 'rgba(232,192,96,0.18)', accentLight: '#F5EDD6', bg: '#080F18', surface: '#111E2C', surface2: '#172538', surface3: '#1D2D44', text: '#EEF2F8', text2: '#A8C0D8', text3: '#5880A0', border: 'rgba(255,255,255,0.08)', borderStrong: 'rgba(255,255,255,0.15)', iconColors: [{ bg: 'rgba(232,192,96,0.20)', fg: '#E8C060' },{ bg: 'rgba(140,180,255,0.18)', fg: '#8CB4FF' },{ bg: 'rgba(80,210,160,0.18)', fg: '#50D2A0' },{ bg: 'rgba(255,130,110,0.18)', fg: '#FF9080' }] },
  { name: 'Forest Sage', navy: '#1C2B1E', navyMid: '#243826', navySoft: '#2C452E', accent: '#5A9E5A', accentDim: 'rgba(90,158,90,0.15)', accentLight: '#D8EDD8', bg: '#E8F0E8', surface: '#F2F7F2', surface2: '#D8E8D8', surface3: '#C8DCC8', text: '#142018', text2: '#304A34', text3: '#5A7860', border: 'rgba(20,32,24,0.09)', borderStrong: 'rgba(20,32,24,0.16)', iconColors: [{ bg: '#C4DCC4', fg: '#1C4020' },{ bg: '#BCD8CC', fg: '#183C28' },{ bg: '#D0DCC0', fg: '#2C3C18' },{ bg: '#BED0CC', fg: '#182C28' }] },
  { name: 'Dusty Rose', navy: '#4A2535', navyMid: '#5C3044', navySoft: '#6E3B53', accent: '#C8808C', accentDim: 'rgba(200,128,140,0.15)', accentLight: '#FDF5F6', bg: '#F8F8F8', surface: '#FFFFFF', surface2: '#F2F2F2', surface3: '#E8E8E8', text: '#1A1A1A', text2: '#4A4A4A', text3: '#8A8A8A', border: 'rgba(0,0,0,0.07)', borderStrong: 'rgba(0,0,0,0.13)', iconColors: [{ bg: '#FDEEF0', fg: '#5A2030' },{ bg: '#FAE8EC', fg: '#4A1C2C' },{ bg: '#FDE8E4', fg: '#5A1E18' },{ bg: '#FAE8F0', fg: '#48202A' }] },
  { name: 'Morning Light', navy: '#2C3E50', navyMid: '#384F62', navySoft: '#446074', accent: '#6B8CAE', accentDim: 'rgba(107,140,174,0.15)', accentLight: '#EAF0F6', bg: '#F8F6F2', surface: '#FFFFFF', surface2: '#F0EDE8', surface3: '#E8E4DE', text: '#1A1A18', text2: '#4A4A46', text3: '#8A8A84', border: 'rgba(26,26,24,0.08)', borderStrong: 'rgba(26,26,24,0.14)', iconColors: [{ bg: '#E8EFF5', fg: '#2C4A62' },{ bg: '#E8F0EC', fg: '#1E4030' },{ bg: '#F5EDE8', fg: '#5A3820' },{ bg: '#F0EAF0', fg: '#3A2840' }] },
];



function applyTheme(index) {
  const t = THEMES[index];
  AppState.set('themeIndex', index);
  AppState.save('themeIndex');
  const r = document.documentElement.style;
  r.setProperty('--navy', t.navy);
  r.setProperty('--navy-mid', t.navyMid);
  r.setProperty('--navy-soft', t.navySoft);
  r.setProperty('--gold', t.accent);
  r.setProperty('--gold-dim', t.accentDim);
  r.setProperty('--gold-light', t.accentLight);
  r.setProperty('--bg', t.bg);
  r.setProperty('--surface', t.surface);
  r.setProperty('--surface2', t.surface2);
  r.setProperty('--surface3', t.surface3);
  r.setProperty('--text', t.text);
  r.setProperty('--text2', t.text2);
  r.setProperty('--text3', t.text3);
  r.setProperty('--border', t.border);
  r.setProperty('--border-strong', t.borderStrong);
  try {
    const icons = document.querySelectorAll('.home-icon');
    icons.forEach((icon, i) => {
      const c = t.iconColors[i] || t.iconColors[0];
      icon.style.background = c.bg;
      icon.style.color = c.fg;
    });
  } catch(e) {}
  document.body.style.background = t.bg;
  document.documentElement.style.background = t.bg;
  THEMES.forEach((_, i) => {
    const s = document.getElementById('swatch-' + i);
    if (s) s.classList.toggle('active', i === index);
  });
  showToast(t.name);
}

// ── PIONEER UNITS DATA ──
const PIONEER_UNITS = [
  { id: "1b", title: "Fortify Your Relationship With Jehovah", questions: ["How does Isaiah's prophecy reveal the role of divine education in forging a close relationship between Jehovah and his only-begotten Son? (Isa. 50:4, 5)", "What should be our goal when engaging in personal study? (Matt. 22:37)", "What did Jehovah require of Israel's kings, and why? (Deut. 17:18-20)", "How can we cultivate a desire for Bible reading and personal study? (1 Pet. 2:2)", "Why is self-discipline needed? (w13 9/15 p. 30, par. 13)", "Why does daily Bible reading draw you closer to God? (Josh. 1:8; 2 Chron. 15:2)", "How would you define meditation, and on what should profitable meditation be focused? (Ps. 19:14; 77:12; 1 Tim. 4:13-15; it-2 p. 363)", "Why is coming to know God more than just an academic or intellectual study? (John 17:3; w13 10/15 p. 27, par. 7)", "How does the example of Samuel illustrate what it means to come to know Jehovah? (1 Sam. 3:7-10; w10 10/1 p. 17, pars. 1-2)", "What benefits come from investigating deep Bible truths? (Acts 4:13; Heb. 5:12-14)", "What should be our attitude about deeper Scriptural teachings? (Ps. 25:4)", "Why is dependence on the faithful and discreet slave so important in our grasping deeper Bible truths? (Matt. 24:45)", "How can reflecting on creation fortify our relationship with God? (Rom. 1:20; w13 8/1 p. 11)", "What indicates that our love for Jehovah is shown not only by the intensity of our feelings but also through our actions? (1 John 2:5; 5:3)"] },
  { id: "2a", title: "Using the New World Translation—Part 1", questions: ["Why was there a need for a new translation? (w15 12/15 p. 8, pars. 16-17)", "How long did it take to complete the New World Translation of the Holy Scriptures? (kr p. 39, par. 1)", "Why, especially, is the New World Translation superior to other Bible translations? (kr p. 39, par. 2)", "Why was there a need for a revised edition of the New World Translation? What was the goal of the New World Bible Translation Committee? (nwt p. 39)", "What are some of the reasons given as to why a strict, word-for-word translation is not always the most accurate translation?", "Give some examples of how a word-for-word translation can be misunderstood. How might doctrinal bias affect a translator's work?", "What liberties have some translators taken regarding Jehovah's name?", "Should the revised English New World Translation be considered a paraphrased edition?", "What must a reliable translation accomplish?", "Why have a number of style and vocabulary changes been made in the revised edition?"] },
  { id: "2b", title: "Using the New World Translation—Part 2", questions: ["Explain the value of the four categories of footnotes: Or, Or possibly, Lit., and Meaning and background information.", "What is the value of See Glossary which appears in some footnotes? (Matt. 24:3; Mark 8:34; nwt p. 1723)"] },
  { id: "3a", title: "Keep Pace With Spiritual Enlightenment", questions: ["Explain how Jehovah is the Source of all spiritual enlightenment. (Ps. 43:3; Isa. 42:6, 7)", "Why do you appreciate that Jehovah reveals his purpose progressively? (Prov. 4:18; John 16:12)"] },
  { id: "4a", title: "Uphold Jehovah's Sovereignty", questions: ["Give reasons why Jehovah is the rightful Universal Sovereign. (Job 41:11; Ps. 24:1)", "Why is Jehovah's sovereignty not dependent on our keeping integrity? (it-2 p. 1011, pars. 3-4)", "According to Acts 17:25, 28, to what extent are all people dependent on Jehovah?", "What evidence of independent thinking do you observe in the world around you today?", "As readily admitted by Jeremiah, why is man unable to direct his own step successfully? (Jer. 10:23)", "How can you show that you really want to subject yourself to Jehovah's sovereignty? (Ps. 119:105; 143:10; Isa. 54:13)", "Describe loyalty as used in the Bible. How has Jehovah demonstrated that he is loyal?", "How can we gain strength from reflecting on God's acts of loyalty? (w13 6/15 pp. 17-18, pars. 4-6)", "In times of persecution, how can we show that we are truly loyal? (John 15:13; Acts 9:23-25; Rev. 2:10)"] },
  { id: "4b", title: "Show Personal Interest in Others", questions: ["As you approach individuals, what clues might reveal their background, interests, or family situation?", "What current events are on the minds of people in your territory? How can events publicized in the media serve as a basis for conversation?", "If some have moved to your area from another land, what have you found to be an effective way to witness to them?", "What should you do if someone who answers the door speaks a language different from yours?", "How could you use jw.org when meeting someone who speaks another language?", "How do we follow up on any interest shown?"] },
  { id: "5a", title: "From House to House—Our Principal Way of Preaching", questions: ["How do Luke 4:43 and John 4:34 epitomize Jesus' lifework?", "What motivated Jesus to preach? (John 14:31)", "Discuss three significant ways Jesus showed his love for the preaching work.", "By what authority have we been commissioned to do this work, and what does this commission involve? (Matt. 28:18-20)", "How did Jesus view people to whom he preached?", "What does Jesus' positive view of people teach us? (John 1:47)"] },
  { id: "6a", title: "Women Who Make Jehovah's Heart Rejoice", questions: ["Why is the woman's role as a helper and a complement an honorable one? (Gen. 2:18, 23; Ps. 33:20)", "How did Jesus show respect for the dignity of women?", "How does Ephesians 5:28-31 show that God's view of the husband-and-wife relationship has not changed?", "What does it mean to assign them honor as to a weaker vessel? (1 Pet. 3:7)"] },
  { id: "7a", title: "Benefit From Counsel and Direction", questions: ["To whom did Jesus delegate oversight of the congregation? (Matt. 10:1; John 21:15-17; Acts 2:41, 42)"] },
  { id: "7b", title: "Resist the Spirit of the World", questions: ["What contrasting use of the word spirit is found at 1 Corinthians 2:12?", "How would you describe the spirit of the world? (w12 10/15 p. 13, par. 4)"] },
  { id: "8a", title: "Walk in the Way of Integrity", questions: ["What does the word integrity mean? (w19.02 p. 3, pars. 3-5)", "How does Psalm 119:1-3 describe a person who is walking in the way of integrity?", "What does Christian neutrality involve? In what ways have Christians always maintained neutrality?", "Why is close cooperation among the brothers especially important when we are threatened by our enemies? (1 Cor. 12:25, 26)"] },
  { id: "8b", title: "Participate in Various Forms of Our Ministry", questions: ["How did Jesus share the good news informally with a Samaritan woman?", "What is the natural result when the truth fills our heart? (Luke 6:45)", "How can wearing our badge cards for conventions, keeping our literature visible when traveling, and dressing neatly lead to a witness?", "How will having empathy help you make your sacrifice of praise more appealing? (1 Cor. 9:19-23)", "What does Colossians 4:6 teach us about the way we should converse?"] },
  { id: "10a", title: "Appreciate Jesus' Role", questions: ["How do we know that Jesus is God's firstborn Son? (Col. 1:15)", "Why does the Bible refer to Jesus as God's only-begotten Son? (John 1:3, 14; Heb. 11:17)", "How would you explain Jesus' role in creation as described at Colossians 1:16?"] },
  { id: "10b", title: "Think in Terms of Bible Principles", questions: ["What are principles, and how do they differ from laws?", "How would you illustrate to a Bible student the difference between principles and laws?"] },
  { id: "11a", title: "Examine Your Spiritual Progress", questions: ["Why is Bible reading essential in developing spirituality? (Ps. 119:105; John 17:17)", "According to 1 Corinthians 2:14-16, how does a spiritual man contrast with a physical man?", "What is the mind, or attitude, of Christ toward his Father and the doing of his Father's will? (John 4:34)", "What does Philippians 2:5-8 indicate will be necessary if we are to develop the mind of Christ?", "According to James 1:22-25, what tendency hinders spiritual progress?", "Why is meditation needed?", "How can meditation help us to avoid repeating past mistakes?"] },
  { id: "11b", title: "Make Effective Return Visits", questions: ["What is your attitude toward making return visits?", "Why is it important to return when we have promised to do so? (Luke 16:10)", "How can we lay the groundwork for a return visit?", "What is the advantage of building anticipation by leaving some questions unanswered until the next discussion?", "How does our researching a subject show sincere personal interest?", "Why might we call back even when no literature has been placed? (Matt. 10:13; Luke 10:5, 6)"] },
  { id: "13a", title: "Learn From the Master", questions: ["In what ways is Jesus qualified to be our Master? (Isa. 50:4)"] },
  { id: "13b", title: "Conduct Progressive Bible Studies—Part 1", questions: ["What is involved in teaching? (it-2 p. 1070)"] },
  { id: "14a", title: "Conduct Progressive Bible Studies—Part 2", questions: ["How did Jesus effectively use questions to convey truths and stimulate thinking?", "How could the use of auxiliary questions draw out the thoughts and feelings of the student? (Prov. 20:5)", "What should you do if your student answers incorrectly? How could you lead him to the appropriate conclusion?", "How does Proverbs 12:18 help us in using auxiliary questions with tact?"] },
  { id: "15a", title: "Help Others Press On to Maturity", questions: ["How do you help your Bible students to understand the importance of speaking to others about what they are learning right from the start?"] },
  { id: "16a", title: "The Joy of Jehovah Is Your Stronghold", questions: ["What is the definition of joy? (it-2 p. 119)", "What is the source of true joy, and how is God's holy spirit involved? (Deut. 28:47; Prov. 15:13; 17:22; Gal. 5:22)"] },
  { id: "16b", title: "Jehovah Blesses Those Trusting In Him", questions: ["What is meant by the expression loyal love as used in the Bible?", "How is Jehovah's trustworthiness and strength of character anchored in his loyal love? (Ex. 34:6, 7; Deut. 7:7-9)", "Explain why the meaning of Jehovah's name is a significant reason for putting trust in him? (Ex. 3:14; 6:2-8)", "Why is Jehovah the epitome of truth? Give examples of Jehovah's reliability and integrity. (1 Ki. 8:56; Ps. 31:5; Heb. 6:18)", "How did Jesus demonstrate that he trusted in Jehovah under challenging circumstances? (Matt. 26:52, 53)"] },
  { id: "17a", title: "Persevere in Prayer", questions: ["What convinces you that Jehovah hears your prayers? (1 Ki. 18:36-38; Acts 12:5-11; Heb. 5:7)"] },
  { id: "17b", title: "Endurance Leads to an Approved Condition", questions: ["Why did God include examples of the endurance of faithful servants of old in the Bible? (Heb. 12:1; Jas. 5:10, 11)", "What does Hebrews 5:7-9 tell us about Jesus' endurance? How do we benefit from his faithful course?", "What did Job learn through his endurance? (Job 42:2, 12; Jas. 5:10, 11)", "Why does God permit trials to come upon his servants? (Jas. 1:2-4)", "In what way do trials bring us joy?", "James says that endurance has a work that it is accomplishing. What is that work? How does endurance make us complete and sound in all respects?"] },
];

// ── INIT ──
applyTheme(AppState.themeIndex);
renderThemes();
if (synth) synth.getVoices();
