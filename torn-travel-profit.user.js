// ==UserScript==
// @name         Torn - Travel Best Profit Highlight
// @namespace    torn.toniballoni.travelprofit
// @author       Toni_Balloni [3853029]
// @version      0.1.0
// @description  When abroad, reads the foreign shop and highlights the 3 most profitable in-stock items: green (1st), orange (2nd), red (3rd).
// @match        https://www.torn.com/*
// @updateURL    https://github.com/soodohcool/torn-travel-profit/raw/refs/heads/main/torn-travel-profit.user.js
// @downloadURL  https://github.com/soodohcool/torn-travel-profit/raw/refs/heads/main/torn-travel-profit.user.js
// @grant        GM_xmlhttpRequest
// @connect      droqsdb.com
// @connect      yata.yt
// @connect      weav3r.dev
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STYLE_ID = 'tornsuite-travel-profit-style';
  const CACHE_KEY = 'tornsuite-travel-profit-cache';
  const CACHE_TTL_MS = 30 * 60 * 1000;
  const DEBOUNCE_MS = 150;

  const DROQS_EXPORT_URL = 'https://droqsdb.com/api/public/v1/export';
  const YATA_TRAVEL_EXPORT_URL = 'https://yata.yt/api/v1/travel/export/';
  const WEAV3R_CATALOG_URL = 'https://weav3r.dev/api/marketplace';

  const COUNTRY_NAME_TO_CODE = {
    mexico: 'mex',
    'cayman islands': 'cay',
    canada: 'can',
    hawaii: 'haw',
    'united kingdom': 'uni',
    argentina: 'arg',
    switzerland: 'swi',
    japan: 'jap',
    china: 'chi',
    uae: 'uae',
    'south africa': 'sou'
  };

  const RANK_COLORS = ['#69A829', '#E8860C', '#C0392B'];
  const RANK_CLASSES = ['ts-tp-1', 'ts-tp-2', 'ts-tp-3'];

  let cachedTop3 = [];
  let prefetchCountry = null;
  let prefetchPromise = null;
  let timer = null;
  let hasHighlighted = false;

  function httpGetJson(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'undefined') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          onload(resp) {
            if (resp.status >= 200 && resp.status < 300) {
              try {
                resolve(JSON.parse(resp.responseText));
              } catch (e) {
                reject(e);
              }
            } else {
              reject(new Error(`HTTP ${resp.status}`));
            }
          },
          onerror: () => reject(new Error('Network error'))
        });
        return;
      }
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then(resolve, reject);
    });
  }

  function itemLookupKey(code, name) {
    return `${code}|${String(name || '').trim().toLowerCase()}`;
  }

  function normalizeDroqsExport(droqs) {
    const stocks = {};
    if (!droqs || !droqs.ok || !Array.isArray(droqs.countries)) return stocks;
    for (const block of droqs.countries) {
      const label = String(block.country || '').trim().toLowerCase();
      const code = COUNTRY_NAME_TO_CODE[label];
      if (!code) continue;
      const last = block.lastUpdated ? Date.parse(block.lastUpdated) : NaN;
      const updateSec = !Number.isNaN(last) ? Math.floor(last / 1000) : Math.floor(Date.now() / 1000);
      stocks[code] = {
        update: updateSec,
        stocks: (block.items || []).map((raw) => ({
          id: null,
          name: String(raw.itemName || 'Unknown'),
          quantity: raw.stock ?? 0,
          cost: raw.buyPrice ?? 0,
          profitPerItem: raw.profitPerItem ?? null
        }))
      };
    }
    return stocks;
  }

  function mergeYataIntoStocks(stocks, yata) {
    if (!yata || !yata.stocks || typeof yata.stocks !== 'object') return;
    const lookup = new Map();
    for (const [code, block] of Object.entries(yata.stocks)) {
      for (const it of block.stocks || []) {
        if (!it) continue;
        const name = String(it.name ?? it.item_name ?? it.itemName ?? 'Unknown');
        lookup.set(itemLookupKey(code, name), it);
      }
    }
    const droqsNamesByCode = {};
    for (const [code, block] of Object.entries(stocks)) {
      const names = new Set();
      for (const item of block.stocks || []) {
        names.add(String(item.name || '').trim().toLowerCase());
        const y = lookup.get(itemLookupKey(code, item.name));
        if (y && y.id != null) {
          const idNum = typeof y.id === 'string' ? parseInt(y.id, 10) : y.id;
          if (!Number.isNaN(idNum)) item.id = idNum;
        }
        if (y && (item.quantity == null || item.quantity === 0) && y.quantity != null) {
          item.quantity = y.quantity;
        }
        if (y && !item.cost && y.cost != null) item.cost = y.cost;
      }
      droqsNamesByCode[code] = names;
    }
    for (const [code, block] of Object.entries(yata.stocks)) {
      if (!stocks[code]) {
        stocks[code] = { update: Math.floor(Date.now() / 1000), stocks: [] };
        droqsNamesByCode[code] = new Set();
      }
      const droqsNames = droqsNamesByCode[code] || new Set();
      for (const y of block.stocks || []) {
        if (!y) continue;
        const name = String(y.name ?? y.item_name ?? y.itemName ?? 'Unknown');
        const nameLower = name.trim().toLowerCase();
        if (droqsNames.has(nameLower)) continue;
        droqsNames.add(nameLower);
        const idNum = y.id != null ? (typeof y.id === 'string' ? parseInt(y.id, 10) : y.id) : null;
        stocks[code].stocks.push({
          id: Number.isNaN(idNum) ? null : idNum,
          name,
          quantity: y.quantity ?? 0,
          cost: y.cost ?? 0,
          profitPerItem: y.profit_per_item ?? y.profitPerItem ?? null
        });
      }
    }
  }

  function parseWeav3rCatalog(data) {
    const prices = new Map();
    const items = Array.isArray(data?.items) ? data.items : [];
    for (const it of items) {
      const id = typeof it.item_id === 'string' ? parseInt(it.item_id, 10) : it.item_id;
      if (!Number.isFinite(id) || it.market_price == null) continue;
      prices.set(id, it.market_price);
    }
    return prices;
  }

  function getTravelState() {
    const body = document.body;
    if (!body) {
      return { traveling: false, abroad: false, country: '', countryCode: null };
    }
    const country = (body.getAttribute('data-country') || '').trim().toLowerCase();
    const countryCode = country && country !== 'torn' ? COUNTRY_NAME_TO_CODE[country] || null : null;
    return {
      traveling: body.getAttribute('data-traveling') === 'true',
      abroad: body.getAttribute('data-abroad') === 'true',
      country,
      countryCode
    };
  }

  function saveCache(countryCode, top3) {
    try {
      sessionStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ countryCode, top3, at: Date.now() })
      );
    } catch (e) {
      /* ignore quota errors */
    }
  }

  function loadCache(countryCode) {
    try {
      const raw = sessionStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed.countryCode !== countryCode) return null;
      if (Date.now() - parsed.at > CACHE_TTL_MS) return null;
      return parsed.top3 || [];
    } catch (e) {
      return null;
    }
  }

  function clearCacheStorage() {
    try {
      sessionStorage.removeItem(CACHE_KEY);
    } catch (e) {
      /* ignore */
    }
  }

  async function prefetchTopProfit(countryCode) {
    if (prefetchPromise && prefetchCountry === countryCode) return prefetchPromise;

    prefetchCountry = countryCode;
    prefetchPromise = (async () => {
      const [droqs, yata, weav3r] = await Promise.all([
        httpGetJson(DROQS_EXPORT_URL),
        httpGetJson(YATA_TRAVEL_EXPORT_URL).catch(() => null),
        httpGetJson(WEAV3R_CATALOG_URL)
      ]);

      const stocks = normalizeDroqsExport(droqs);
      mergeYataIntoStocks(stocks, yata);
      const marketPrices = parseWeav3rCatalog(weav3r);
      const countryItems = stocks[countryCode]?.stocks || [];

      cachedTop3 = countryItems
        .map((item) => {
          const id = item.id != null ? (typeof item.id === 'string' ? parseInt(item.id, 10) : item.id) : null;
          const marketPrice = id != null ? marketPrices.get(id) : null;
          let profit = marketPrice != null ? marketPrice - (item.cost || 0) : null;
          if (profit == null && item.profitPerItem != null) profit = item.profitPerItem;
          return { name: item.name, id, profit, cost: item.cost || 0, quantity: item.quantity || 0 };
        })
        .filter((it) => it.profit != null && it.profit > 0 && it.quantity > 0)
        .sort((a, b) => b.profit - a.profit)
        .slice(0, 3);

      saveCache(countryCode, cachedTop3);

      // Fresh data for this country — allow one search/highlight pass
      hasHighlighted = false;
      schedule();
    })().catch((e) => {
      console.warn('[Torn Suite Travel Profit] Prefetch failed:', e.message || e);
      prefetchPromise = null;
    });

    return prefetchPromise;
  }

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = RANK_COLORS.map(
      (color, i) => `
      li.${RANK_CLASSES[i]} {
        box-shadow: 0 0 14px 4px ${color}, inset 0 0 10px 2px ${hexToRgba(color, 0.25)} !important;
        border: 2px solid ${color} !important;
        border-radius: 4px !important;
        position: relative;
        z-index: 10;
      }
    `
    ).join('\n');
    document.head.appendChild(style);
  }

  function hexToRgba(hex, alpha) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  function isUserAbroad() {
    const state = getTravelState();
    if (state.abroad && state.countryCode) return true;

    for (const h of document.querySelectorAll('h5')) {
      const t = h.textContent.trim().toLowerCase();
      if (t === 'general store' || t === 'arms dealer' || t === 'black market') return true;
    }
    if (document.querySelector('[data-tt-content-type="profit"]')) return true;
    return false;
  }

  function getRowName(row) {
    const tt = row.querySelector('[data-tt-content-type="name"] button');
    if (tt) return tt.textContent.trim();
    const btn = row.querySelector('[class*="itemNameButton"], [class*="itemName"] button, button');
    return btn ? btn.textContent.trim() : '';
  }

  // Torn shop rows expose the item id via the image path and aria-controls
  function getRowItemId(row) {
    const img = row.querySelector('img[src*="/images/items/"]');
    if (img) {
      const m = (img.getAttribute('src') || '').match(/\/images\/items\/(\d+)\//);
      if (m) return parseInt(m[1], 10);
    }
    const ctrl = row.querySelector('[aria-controls^="item-"]');
    if (ctrl) {
      const m = (ctrl.getAttribute('aria-controls') || '').match(/^item-(\d+)/);
      if (m) return parseInt(m[1], 10);
    }
    return null;
  }

  function getRowStock(row) {
    const stockCell = row.querySelector('[data-tt-content-type="stock"]');
    if (stockCell) {
      return parseInt(stockCell.textContent.replace(/[^0-9]/g, ''), 10) || 0;
    }
    // Native travel shop: the stock cell is marked by a screen-reader "stock" label
    for (const span of row.querySelectorAll('span')) {
      if (span.textContent.trim().toLowerCase().startsWith('stock')) {
        const parent = span.parentElement;
        if (parent) {
          const n = parseInt(parent.textContent.replace(/[^0-9]/g, ''), 10);
          if (!Number.isNaN(n)) return n;
        }
      }
    }
    return 0;
  }

  function findShopRows() {
    const rows = [];
    for (const li of document.querySelectorAll('li')) {
      if (!li.querySelector('img[src*="/images/items/"]')) continue;
      const name = getRowName(li);
      const id = getRowItemId(li);
      if (!name && id == null) continue;
      rows.push({ row: li, name, id, stock: getRowStock(li) });
    }
    return rows;
  }

  function findProfitItemsFromTornTools() {
    const items = [];
    for (const cell of document.querySelectorAll('[data-tt-content-type="profit"]')) {
      const value = parseInt(cell.getAttribute('data-tt-value'), 10);
      if (!Number.isFinite(value)) continue;
      const row = cell.closest('li');
      if (!row) continue;
      const stock = getRowStock(row);
      if (stock <= 0) continue;
      items.push({ row, value });
    }
    return items;
  }

  function clearHighlights() {
    for (const cls of RANK_CLASSES) {
      document.querySelectorAll(`li.${cls}`).forEach((el) => el.classList.remove(cls));
    }
  }

  function highlightFromTornTools() {
    const top3 = findProfitItemsFromTornTools()
      .filter((it) => it.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 3);

    clearHighlights();
    top3.forEach((it, i) => it.row.classList.add(RANK_CLASSES[i]));
    if (top3.length) hasHighlighted = true;
  }

  function highlightFromCache() {
    if (!cachedTop3.length) return false;

    const byId = new Map();
    const byName = new Map();
    cachedTop3.forEach((t, i) => {
      if (t.id != null) byId.set(t.id, i);
      byName.set(String(t.name || '').trim().toLowerCase(), i);
    });

    const matched = [];
    for (const shop of findShopRows()) {
      let rank = -1;
      if (shop.id != null && byId.has(shop.id)) rank = byId.get(shop.id);
      else if (shop.name && byName.has(shop.name.trim().toLowerCase())) {
        rank = byName.get(shop.name.trim().toLowerCase());
      }
      if (rank >= 0) matched.push({ row: shop.row, rank });
    }

    if (!matched.length) return false;

    clearHighlights();
    matched.sort((a, b) => a.rank - b.rank);
    matched.forEach((m) => m.row.classList.add(RANK_CLASSES[m.rank]));
    hasHighlighted = true;
    return true;
  }

  function highlight() {
    if (!isUserAbroad()) {
      clearHighlights();
      hasHighlighted = false;
      return;
    }

    if (document.querySelectorAll('[data-tt-content-type="profit"]').length > 0) {
      highlightFromTornTools();
      return;
    }

    if (highlightFromCache()) return;

    // No cache and no TornTools — fetch now (prefetch re-runs the search on completion)
    const state = getTravelState();
    if (state.countryCode) {
      prefetchTopProfit(state.countryCode);
    }
  }

  function schedule() {
    // Already highlighted for this country/dataset — don't recalculate on
    // unrelated DOM churn (e.g. the buy panel expanding on a Buy click)
    if (hasHighlighted) return;
    clearTimeout(timer);
    timer = setTimeout(highlight, DEBOUNCE_MS);
  }

  function onTravelStateChange() {
    const state = getTravelState();

    // Neither traveling nor abroad = back home, reset everything
    if (!state.traveling && !state.abroad) {
      cachedTop3 = [];
      prefetchCountry = null;
      prefetchPromise = null;
      clearCacheStorage();
      clearHighlights();
      hasHighlighted = false;
      return;
    }

    if (!state.countryCode) return;

    // Hydrate from sessionStorage if we don't have this country's data in memory yet
    if (!cachedTop3.length || prefetchCountry !== state.countryCode) {
      const stored = loadCache(state.countryCode);
      if (stored && stored.length) cachedTop3 = stored;
    }

    // Kick off prefetch when traveling (in flight) so it's ready on landing,
    // or on landing if it wasn't kicked off yet. Prefetch runs the DOM search
    // once the data lands.
    if (prefetchCountry !== state.countryCode || !prefetchPromise) {
      prefetchTopProfit(state.countryCode);
    }

    // Abroad = landed at shop, try to highlight with whatever we already have
    if (state.abroad) schedule();
  }

  function watchBodyAttributes() {
    const body = document.body;
    if (!body) return;

    const obs = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          onTravelStateChange();
          break;
        }
      }
    });

    obs.observe(body, {
      attributes: true,
      attributeFilter: ['data-traveling', 'data-abroad', 'data-country', 'data-page']
    });

    onTravelStateChange();
  }

  injectStyle();
  watchBodyAttributes();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  highlight();
})();

  