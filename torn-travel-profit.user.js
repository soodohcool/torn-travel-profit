// ==UserScript==
// @name         Torn - Travel Profit 
// @namespace    torn.toniballoni.smartstock
// @author       Toni_Balloni [3853029]
// @version      0.0.1
// @description  When abroad, reads the foreign shop and highlights the 3 most profitable in-stock items: green (1st), orange (2nd), red (3rd).
// @match        https://www.torn.com/*
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
  
    const STYLE_ID = 'tornsuite-travel-profit-style';
    const DEBOUNCE_MS = 150;
  
    // Rank -> highlight color. Index 0 = most profitable.
    const RANK_COLORS = ['#69A829', '#E8860C', '#C0392B']; // green, orange, red
    const RANK_CLASSES = ['ts-tp-1', 'ts-tp-2', 'ts-tp-3'];
  
    function injectStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = RANK_COLORS.map((color, i) => `
        li.${RANK_CLASSES[i]} {
          box-shadow: 0 0 14px 4px ${color}, inset 0 0 10px 2px ${hexToRgba(color, 0.25)} !important;
          border: 2px solid ${color} !important;
          border-radius: 4px !important;
          position: relative;
          z-index: 10;
        }
      `).join('\n');
      document.head.appendChild(style);
    }
  
    function hexToRgba(hex, alpha) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
    }
  
    function isUserAbroad() {
      for (const h of document.querySelectorAll('h5')) {
        const t = h.textContent.trim().toLowerCase();
        if (t === 'general store' || t === 'arms dealer' || t === 'black market') return true;
      }
      if (document.querySelector('[data-tt-content-type="profit"]')) return true;
      return false;
    }
  
    function findProfitItems() {
      const items = [];
      for (const cell of document.querySelectorAll('[data-tt-content-type="profit"]')) {
        const value = parseInt(cell.getAttribute('data-tt-value'), 10);
        if (!Number.isFinite(value)) continue;
  
        const row = cell.closest('li');
        if (!row) continue;
  
        const stockCell = row.querySelector('[data-tt-content-type="stock"]');
        const stock = stockCell ? parseInt(stockCell.textContent.replace(/[^0-9]/g, ''), 10) || 0 : 0;
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
  
    function highlight() {
      if (!isUserAbroad()) {
        clearHighlights();
        return;
      }
  
      const top3 = findProfitItems()
        .filter((it) => it.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 3);
  
      clearHighlights();
      top3.forEach((it, i) => it.row.classList.add(RANK_CLASSES[i]));
    }
  
    let timer = null;
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(highlight, DEBOUNCE_MS);
    }
  
    injectStyle();
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
    highlight();
  })();
  