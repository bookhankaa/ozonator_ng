const MAX_ORDERS = 100;

const MONTH_NAMES = {
  'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3,
  'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7,
  'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
};

let orders = [];
let isCollecting = false;
let pageType = 'e-check';

function detectPageType() {
  if (window.location.href.includes('/my/orderlist')) return 'orderlist';
  return 'e-check';
}

function normalizeWhitespace(text) {
  return text.replace(/[\u00A0\u202F\u200B\u200C\u200D\uFEFF]/g, ' ').trim();
}

function parseDateECheck(text) {
  const normalized = normalizeWhitespace(text);
  const match = normalized.match(/(\d{1,2})\s+([а-яё]+)\s+(\d{4})\s+в\s+(\d{2}):(\d{2})/i);
  if (!match) return null;
  const [, day, monthWord, year, hour, minute] = match;
  const month = MONTH_NAMES[monthWord.toLowerCase()];
  if (month === undefined) return null;
  return new Date(+year, month, +day, +hour, +minute);
}

function parseDateOrderlist(text) {
  const normalized = normalizeWhitespace(text);
  const relative = normalized.match(/^(сегодня|завтра)\s*(?:с\s+(\d{2}):(\d{2}))?/i);
  if (relative) {
    const now = new Date();
    const shift = relative[1].toLowerCase() === 'завтра' ? 1 : 0;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + shift);
    if (relative[2]) d.setHours(+relative[2], +(relative[3] || 0), 0, 0);
    return d;
  }
  let match = normalized.match(/(\d{1,2})\s+([а-яё]+)\s*,/);
  if (!match) {
    match = normalized.match(/(\d{1,2})\s+([а-яё]+)/);
  }
  if (!match) return null;
  const [, day, monthWord] = match;
  const month = MONTH_NAMES[monthWord];
  if (month === undefined) return null;
  const year = new Date().getFullYear();
  return new Date(year, month, +day);
}

function parsePrice(text) {
  const clean = text.replace(/[\s\u00A0\u202F]/g, '').replace(/[^\d.]/g, '');
  return parseFloat(clean) || 0;
}

function extractOrderFromHref(href) {
  const url = new URL(href, window.location.origin);
  return url.searchParams.get('order') || url.pathname.split('/').pop();
}

function isCancelled(statusText) {
  if (!statusText) return false;
  return statusText.toLowerCase().includes('отмен');
}

function isReceived(statusText) {
  if (!statusText) return false;
  return statusText.toLowerCase().includes('получен');
}

// ---- E-check page functions ----

function findOrderRowsECheck() {
  let rows = document.querySelectorAll('[data-widget="cheques"] li, li.dh8_12');
  if (rows.length === 0) {
    const links = document.querySelectorAll('a[href*="orderdetails"]');
    const found = [];
    links.forEach(link => {
      const li = link.closest('li');
      if (li && !found.includes(li)) found.push(li);
    });
    return found;
  }
  return [...rows];
}

function parseOrderRowECheck(li) {
  const linkEl = li.querySelector('a[href*="orderdetails"]');
  if (!linkEl) return null;

  const link = linkEl.href;
  const orderNum = extractOrderFromHref(link);
  if (!orderNum) return null;

  const dateEl = Array.from(li.querySelectorAll('span')).find(sp =>
    /^\d{1,2}\s+[а-яё]+\s+\d{4}\s+в\s+\d{2}:\d{2}$/i.test(normalizeWhitespace(sp.textContent))
  );
  const dateStr = dateEl ? normalizeWhitespace(dateEl.textContent) : '';
  const dateObj = dateStr ? parseDateECheck(dateStr) : null;

  const priceEl = Array.from(li.querySelectorAll('strong')).find(sp => /\d/.test(sp.textContent));
  const priceText = priceEl ? normalizeWhitespace(priceEl.textContent) : '';
  const price = priceText ? parsePrice(priceText) : 0;

  return {
    id: orderNum,
    link: link,
    dateStr: dateStr,
    timestamp: dateObj ? dateObj.getTime() : 0,
    price: price,
    items: []
  };
}

async function fetchPage(url) {
  try {
    const resp = await fetch(url, { credentials: 'same-origin' });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function isLikelyName(text) {
  const t = (text || '').trim();
  if (t.length < 4) return false;
  if (t.includes('\u20BD') || /руб/i.test(t)) return false;
  const digits = (t.match(/\d/g) || []).length;
  return digits * 2 < t.length;
}

function matchWidgetItems(widget) {
  const isOzonImg = im => ((im.src || im.getAttribute('src') || im.getAttribute('data-src')) || '').includes('ir.ozone.ru');
  const imgs = Array.from(widget.querySelectorAll('img')).filter(isOzonImg);
  const nameSpans = Array.from(widget.querySelectorAll('span.tsCompact500Medium')).filter(s => isLikelyName(s.textContent));
  const priceSpans = Array.from(widget.querySelectorAll('span.tsHeadline400Small'));

  return imgs.map((img, i) => {
    const next = imgs[i + 1];
    const inWindow = el => {
      if (!(img.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      return !next || !!(el.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING);
    };
    let imgSrc = img.src || img.getAttribute('src') || img.getAttribute('data-src');
    if (imgSrc.startsWith('//')) imgSrc = 'https:' + imgSrc;
    else if (imgSrc.startsWith('/')) imgSrc = 'https://www.ozon.ru' + imgSrc;

    const nameEl = nameSpans.find(inWindow);
    const priceEl = priceSpans.find(inWindow);
    return {
      imgSrc: imgSrc,
      name: nameEl ? nameEl.textContent.trim() : '',
      priceText: priceEl ? normalizeWhitespace(priceEl.textContent) : ''
    };
  });
}

async function fetchItemNames(order) {
  if (!order.link) return;
  const html = await fetchPage(order.link);
  if (!html) return;

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const nameMap = new Map();
  const nameByImgId = new Map();
  const widgets = doc.querySelectorAll('[data-widget="shipmentWidget"]');
  for (const widget of widgets) {
    for (const info of matchWidgetItems(widget)) {
      if (!info.name) continue;
      nameMap.set(info.imgSrc, info.name);
      nameByImgId.set(info.imgSrc.split('/').pop(), info.name);
    }
  }

  for (const item of (order.items || [])) {
    const bySrc = nameMap.get(item.img);
    const byId = nameByImgId.get((item.img || '').split('/').pop());
    item.name = bySrc || byId || '';
  }
}

async function fetchOrderDetails(order) {
  const html = await fetchPage(order.link);
  if (!html) return;

  order.items = [];
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const seenImages = new Set();

  const widgets = doc.querySelectorAll('[data-widget="shipmentWidget"]');
  for (const widget of widgets) {
    let widgetStatus = '';
    let widgetCancelled = false;
    const headlines = Array.from(widget.querySelectorAll('span.tsHeadline550Medium'))
      .map(s => normalizeWhitespace(s.textContent)).filter(Boolean);
    if (headlines.length) {
      widgetStatus = headlines.join(' ');
      if (widgetStatus.toLowerCase().includes('отмен')) widgetCancelled = true;
    }
    if (!widgetStatus && !widgetCancelled) {
      const dateSpan = widget.querySelector('.tsBodyControl500Medium');
      if (dateSpan) {
        widgetStatus = dateSpan.textContent.trim().replace(/^Ожидаемая дата:\s*/, '');
      }
    }

    if (widgetCancelled) {
      order.cancelled = true;
      continue;
    }

    for (const info of matchWidgetItems(widget)) {
      const imgHash = info.imgSrc.split('/').pop();
      if (seenImages.has(imgHash)) continue;
      seenImages.add(imgHash);

      order.items.push({
        img: info.imgSrc,
        name: info.name,
        price: info.priceText ? parsePrice(info.priceText) : 0,
        status: widgetStatus || '—'
      });
    }
  }
}

// ---- Orderlist page functions ----

function getOrderlistRoot() {
  return document.querySelector('[data-widget="orderList"]') || document.querySelector('[data-widget="paginator"]') || document;
}

function findOrderRowsOrderlist() {
  const markerSel = 'a[href*="orderdetails"], img[src*="ir.ozone.ru"], img[data-src*="ir.ozone.ru"], span.tsHeadline550Medium';
  const cards = [];
  document.querySelectorAll('[data-widget="orderList"]').forEach(section => {
    for (const child of section.children) {
      if (child.matches('[data-widget]')) continue;
      if (!child.querySelector(markerSel)) continue;
      if (child.querySelectorAll('a[href*="orderdetails"]').length >= 3) {
        for (const sub of child.children) {
          if (!sub.matches('[data-widget]') && sub.querySelector(markerSel)) cards.push(sub);
        }
      } else {
        cards.push(child);
      }
    }
  });
  if (cards.length > 0) return cards;
  const root = getOrderlistRoot();
  if (root === document) return [];
  const fallback = new Set();
  root.querySelectorAll('a[href*="orderdetails"]').forEach(link => {
    let el = link.parentElement;
    while (el && el !== root && el.querySelectorAll('a[href*="orderdetails"]').length > 1) {
      el = el.parentElement;
    }
    if (el && el !== root) fallback.add(el);
  });
  return [...fallback];
}

function parseOrderStatusOrderlist(container) {
  const els = container.querySelectorAll('span.tsHeadline550Medium');
  if (!els.length) return '';
  return Array.from(els).map(e => normalizeWhitespace(e.textContent)).join(' ');
}

function parseItemsFromOrderlist(container, orderStatus) {
  const items = [];
  const imgs = Array.from(container.querySelectorAll('img')).filter(im =>
    ((im.src || im.getAttribute('src')) || '').includes('ir.ozone.ru')
  );

  for (const img of imgs) {
    let cell = img.parentElement;
    while (cell && cell !== container && !cell.querySelector('span.tsHeadline400Small')) {
      cell = cell.parentElement;
    }
    if (!cell || cell === container) continue;

    let imgSrc = img.src || img.getAttribute('src') || img.getAttribute('data-src');
    if (!imgSrc) continue;

    if (imgSrc.startsWith('//')) imgSrc = 'https:' + imgSrc;
    else if (imgSrc.startsWith('/')) imgSrc = 'https://www.ozon.ru' + imgSrc;

    const priceEl = cell.querySelector('span.tsHeadline400Small');
    const priceText = priceEl ? normalizeWhitespace(priceEl.textContent) : '';
    const itemPrice = priceText ? parsePrice(priceText) : 0;

    // Payment badge: "Оплачен" / "Не оплачен"
    let payment = '';
    cell.querySelectorAll('[title]').forEach(badge => {
      const title = normalizeWhitespace(badge.getAttribute('title') || badge.textContent);
      if (title.toLowerCase().includes('оплач')) {
        payment = title;
      }
    });

    items.push({
      img: imgSrc,
      name: '',
      price: itemPrice,
      status: orderStatus || '—',
      payment: payment
    });
  }

  return items;
}

function djb2Hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function synthesizeOrderId(items, status, dateStr) {
  const imgs = (items || []).map(it => (it.img || '').split('/').pop()).join(',');
  const total = (items || []).reduce((s, it) => s + (it.price || 0), 0);
  return 'local-' + djb2Hash(`${imgs}|${total}|${status || ''}|${dateStr || ''}`);
}

function parseOrderTotalPrice(items) {
  return (items || []).reduce((sum, it) => sum + (it.price || 0), 0);
}

function parseOrderRowOrderlist(container) {
  const linkEl = container.querySelector('a.d8w_12[href*="orderdetails"], a[href*="orderdetails"]');
  const link = linkEl ? linkEl.href : '';
  const orderNum = link ? extractOrderFromHref(link) : '';

  const status = parseOrderStatusOrderlist(container);

  if (isCancelled(status) || isReceived(status)) {
    return { id: orderNum || synthesizeOrderId([], status, ''), cancelled: true };
  }

  // «Можно забирать»: в tsCompactControl500Medium указаны часы работы пункта, а не дата — не показываем
  const pickupReady = status.toLowerCase().includes('можно забирать');
  const dateEl = pickupReady ? null : container.querySelector('span.tsCompactControl500Medium');
  const dateStr = dateEl ? normalizeWhitespace(dateEl.textContent) : '';
  const dateObj = dateStr ? parseDateOrderlist(dateStr) : null;

  const items = parseItemsFromOrderlist(container, status);

  return {
    id: orderNum || synthesizeOrderId(items, status, dateStr),
    link: link,
    dateStr: dateStr,
    timestamp: dateObj ? dateObj.getTime() : 0,
    price: parseOrderTotalPrice(items),
    items: items
  };
}

// ---- Shared utilities ----

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function updateProgress(current, total, action) {
  if (!window._ozonBtn) return;
  const btn = window._ozonBtn;
  btn.disabled = true;
  let suffix = '';
  if (total) suffix = ` ${current}/${total}`;
  else if (current) suffix = ` ${current}`;
  btn.innerHTML = `<span class="ozon-spinner"></span> ${action}...${suffix}`;
}

function resetButton() {
  if (!window._ozonBtn) return;
  const btn = window._ozonBtn;
  btn.disabled = false;
  btn.innerHTML = '\u2713 Открыть таблицу';
}

function injectButton() {
  if (document.getElementById('ozon-extend-btn')) return;

  pageType = detectPageType();

  const hasChequesWidget = document.querySelector('[data-widget="cheques"]');
  const hasOrderlistWidget = document.querySelector('[data-widget="orderList"]');
  const hasOrderText = document.body && document.body.textContent.includes('Заказ \u2116');

  if (!hasChequesWidget && !hasOrderlistWidget && !hasOrderText) return;

  const container = document.createElement('div');
  container.id = 'ozon-extend-btn';

  const selectContainer = document.createElement('span');
  selectContainer.style.cssText = 'display:flex;gap:4px;';

  const select = document.createElement('select');
  select.id = 'ozon-limit-select';
  select.className = 'ozon-select';
  select.style.maxWidth = '70px';
  const limits = [10, 20, 50, 100, 500];
  limits.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    if (n === 100) opt.selected = true;
    select.appendChild(opt);
  });
  const customOpt = document.createElement('option');
  customOpt.value = 'custom';
  customOpt.textContent = '...';
  customOpt.disabled = true;
  customOpt.hidden = true;
  select.appendChild(customOpt);

  const input = document.createElement('input');
  input.type = 'number';
  input.id = 'ozon-limit-input';
  input.className = 'ozon-select';
  input.style.cssText = 'width:60px;padding:10px 8px !important;border:1px solid #ccc;border-radius:8px;font-size:14px;font-weight:600;font-family:system-ui,-apple-system,sans-serif;background:white;color:#333;cursor:text;outline:none;text-align:center;';
  input.min = 1;
  input.max = 1000;
  input.placeholder = '—';
  input.title = 'Введите вручную';

  // Sync select ↔ input, select is just a quick picker, input is source of truth
  let syncing = false;
  input.value = select.value;
  select.addEventListener('change', () => {
    if (syncing || select.value === 'custom') return;
    input.value = select.value;
  });
  input.addEventListener('input', () => {
    syncing = true;
    const val = parseInt(input.value, 10);
    if (val && limits.includes(val)) select.value = String(val);
    else select.value = 'custom';
    syncing = false;
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  input.addEventListener('focus', () => {
    input.style.borderColor = '#005bff';
    input.style.boxShadow = '0 0 0 2px rgba(0,91,255,0.15)';
  });
  input.addEventListener('blur', () => {
    input.style.borderColor = '#ccc';
    input.style.boxShadow = 'none';
  });

  selectContainer.appendChild(select);
  selectContainer.appendChild(input);

  const label = document.createElement('span');
  label.className = 'ozon-label';
  label.textContent = 'заказов';

  const btn = document.createElement('button');
  btn.id = 'ozon-collect-btn';
  btn.textContent = 'Построить таблицу';

  btn.onclick = async () => {
    if (isCollecting) return;
    let limit = parseInt(input.value || select.value, 10);
    if (!limit || limit < 1) limit = 100;
    await collectOrders(limit);
  };

  container.appendChild(selectContainer);
  container.appendChild(label);
  container.appendChild(btn);
  document.body.appendChild(container);
  window._ozonBtn = btn;
}

// ---- Main collection logic ----

async function collectOrders(limit) {
  const maxOrders = limit || MAX_ORDERS;
  isCollecting = true;
  orders = [];

  if (pageType === 'orderlist') {
    await collectFromOrderlist(maxOrders);
  } else {
    await collectFromECheck(maxOrders);
  }
}

async function collectFromECheck(maxOrders) {
  let noNewContentCount = 0;

  while (orders.length < maxOrders && noNewContentCount < 5) {
    const rows = findOrderRowsECheck();
    let addedCount = 0;

    for (const row of rows) {
      const parsed = parseOrderRowECheck(row);
      if (!parsed) continue;
      if (orders.find(o => o.id === parsed.id)) continue;

      orders.push(parsed);
      addedCount++;
    }

    const uniqueMap = new Map();
    orders.forEach(o => {
      const existing = uniqueMap.get(o.id);
      if (!existing || o.timestamp > existing.timestamp) {
        uniqueMap.set(o.id, o);
      }
    });
    orders = [...uniqueMap.values()];

    if (orders.length === maxOrders) break;
    if (addedCount === 0) {
      noNewContentCount++;
      if (noNewContentCount >= 3 && !document.querySelector('[data-widget="cheques"] li')) break;
    } else {
      noNewContentCount = 0;
    }

    if (orders.length < maxOrders && addedCount > 0) {
      window.scrollBy({ top: 1200, behavior: 'smooth' });
      await sleep(1200);
      updateProgress(orders.length, maxOrders, 'Сбор заказов');
    }
  }

  if (orders.length === 0) {
    showErrorMessage();
    isCollecting = false;
    return;
  }

  for (let i = 0; i < orders.length; i++) {
    updateProgress(i + 1, orders.length, 'Загрузка деталей');
    await fetchOrderDetails(orders[i]);
  }

  orders = orders.filter(o => !o.cancelled);
  saveAndShowResult();
}

async function preloadOrderlist() {
  let prevCount = findOrderRowsOrderlist().length;
  let stableRounds = 0;
  const maxRounds = 60;

  for (let round = 0; round < maxRounds; round++) {
    updateProgress(prevCount, 0, 'Загрузка списка');
    window.scrollBy({ top: 1500, behavior: 'smooth' });
    await sleep(2500);

    const count = findOrderRowsOrderlist().length;
    if (count === prevCount) {
      stableRounds++;
      if (stableRounds >= 3) break;
    } else {
      stableRounds = 0;
      prevCount = count;
    }
  }
}

async function collectFromOrderlist(maxOrders) {
  await preloadOrderlist();

  const containers = findOrderRowsOrderlist();
  const seenIds = new Set();
  const seenImgSets = new Set();
  for (const container of containers) {
    const parsed = parseOrderRowOrderlist(container);
    if (!parsed || parsed.cancelled) continue;
    if (!parsed.link && !(parsed.items || []).length) continue;
    if (seenIds.has(parsed.id)) continue;
    const imgSet = (parsed.items || []).map(it => (it.img || '').split('/').pop()).sort().join(',');
    if (!parsed.link && imgSet && seenImgSets.has(imgSet)) continue;
    seenIds.add(parsed.id);
    if (imgSet) seenImgSets.add(imgSet);
    orders.push(parsed);
  }

  if (orders.length === 0) {
    showErrorMessage();
    isCollecting = false;
    return;
  }

  if (orders.length > maxOrders) orders = orders.slice(0, maxOrders);

  for (let i = 0; i < orders.length; i++) {
    updateProgress(i + 1, orders.length, 'Загрузка названий');
    await fetchItemNames(orders[i]);
  }

  saveAndShowResult();
}

function showErrorMessage() {
  if (window._ozonBtn) {
    window._ozonBtn.innerHTML = '\u26A0 Не найдено заказов';
    window._ozonBtn.disabled = false;
    setTimeout(() => {
      if (window._ozonBtn) window._ozonBtn.textContent = 'Построить таблицу';
    }, 3000);
  }
}

function saveAndShowResult() {
  const serialized = orders.map(o => {
    const { cancelled, ...rest } = o;
    return {
      ...rest,
      dateObj: o.timestamp ? new Date(o.timestamp).toISOString() : null
    };
  });

  chrome.storage.local.set({ ozonOrders: serialized, ozonPageType: pageType });

  if (window._ozonBtn) {
    updateProgress('\u2713', '\u2713', 'Готово');
    setTimeout(resetButton, 500);
    window._ozonBtn.onclick = openResult;
  }

  setTimeout(() => {
    chrome.runtime.sendMessage({ action: 'showResult' });
  }, 300);

  isCollecting = false;
}

function openResult() {
  chrome.runtime.sendMessage({ action: 'showResult' });
}

const waitForAndInject = () => {
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(injectButton, 2000);
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(injectButton, 2000);
    });
  }
};

const observer = new MutationObserver(() => {
  const hasCheques = document.querySelector('[data-widget="cheques"]');
  const hasOrderlist = document.querySelector('[data-widget="orderList"]');
  const hasOrderText = document.body && document.body.textContent.includes('Заказ \u2116');
  if (hasCheques || hasOrderlist || hasOrderText) {
    injectButton();
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

waitForAndInject();
