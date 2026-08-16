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
  const match = normalized.match(/(\d{1,2})\s+(\w+)\s+(\d{4})\s+в\s+(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, day, monthWord, year, hour, minute] = match;
  const month = MONTH_NAMES[monthWord];
  if (month === undefined) return null;
  return new Date(+year, month, +day, +hour, +minute);
}

function parseDateOrderlist(text) {
  const normalized = normalizeWhitespace(text);
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

  const dateEl = li.querySelector('span.hd8_12');
  const dateStr = dateEl ? normalizeWhitespace(dateEl.textContent) : '';
  const dateObj = dateStr ? parseDateECheck(dateStr) : null;

  const priceEl = li.querySelector('strong.h8d_12');
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

async function fetchItemNames(order) {
  const html = await fetchPage(order.link);
  if (!html) return;

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Build map: img src hash -> name
  const nameMap = new Map();
  const widgets = doc.querySelectorAll('[data-widget="shipmentWidget"]');
  for (const widget of widgets) {
    const rows = widget.querySelectorAll('.ek3_12');
    for (const row of rows) {
      const img = row.querySelector('.aw15_5_2-a img');
      if (!img) continue;
      let imgSrc = img.src || img.getAttribute('data-src');
      if (!imgSrc) continue;
      if (imgSrc.startsWith('//')) imgSrc = 'https:' + imgSrc;
      else if (imgSrc.startsWith('/')) imgSrc = 'https://www.ozon.ru' + imgSrc;
      const nameEl = row.querySelector('.e5k_12.k5e_12 span.tsCompact500Medium');
      const name = nameEl ? nameEl.textContent.trim() : '';
      if (name) {
        nameMap.set(imgSrc, name);
      }
    }
  }

  // Match items by img src
  for (const item of (order.items || [])) {
    if (nameMap.has(item.img)) {
      item.name = nameMap.get(item.img);
    }
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
    const statusContainers = widget.querySelectorAll('.cy2_12');
    for (const container of statusContainers) {
      const texts = [];
      container.querySelectorAll('.tsHeadline550Medium').forEach(span => {
        texts.push(span.textContent.trim());
      });
      if (texts.length && texts.join(' ').toLowerCase().includes('отмен')) {
        widgetCancelled = true;
        widgetStatus = texts.join(' ');
        break;
      }
      if (texts.length && !widgetStatus) {
        widgetStatus = texts.join(' ');
      }
    }
    if (!widgetStatus && !widgetCancelled) {
      const headline = widget.querySelector('.tsHeadline550Medium');
      if (headline) {
        const cy3 = headline.closest('.cy2_12');
        if (cy3) {
          const allSpans = cy3.querySelectorAll('.tsHeadline550Medium');
          widgetStatus = Array.from(allSpans).map(s => s.textContent.trim()).join(' ');
          if (widgetStatus.toLowerCase().includes('отмен')) {
            widgetCancelled = true;
          }
        }
      }
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

    const productRows = widget.querySelectorAll('.ek3_12');
    for (const row of productRows) {
      const img = row.querySelector('.aw15_5_2-a img');
      if (!img) continue;

      let imgSrc = img.src || img.getAttribute('data-src');
      if (!imgSrc) continue;

      if (imgSrc.startsWith('//')) imgSrc = 'https:' + imgSrc;
      else if (imgSrc.startsWith('/')) imgSrc = 'https://www.ozon.ru' + imgSrc;

      const imgHash = imgSrc.split('/').pop();
      if (seenImages.has(imgHash)) continue;
      seenImages.add(imgHash);

      const nameEl = row.querySelector('.e5k_12.k5e_12 span.tsCompact500Medium');
      const productName = nameEl ? nameEl.textContent.trim() : '';

      const priceEl = row.querySelector('.c35_5_2-a1.tsHeadline400Small');
      const priceText = priceEl ? priceEl.textContent.trim() : '';
      const itemPrice = priceText ? parsePrice(priceText) : 0;

      order.items.push({
        img: imgSrc,
        name: productName,
        price: itemPrice,
        status: widgetStatus || '—'
      });
    }
  }
}

// ---- Orderlist page functions ----

function findOrderRowsOrderlist() {
  return [...document.querySelectorAll('div.dw8_12')];
}

function parseOrderStatusOrderlist(container) {
  const statusEl = container.querySelector('.cy2_12');
  if (statusEl) {
    const children = statusEl.querySelectorAll('.tsHeadline550Medium');
    if (children.length) {
      return Array.from(children).map(c => normalizeWhitespace(c.textContent)).join(' ');
    }
    return normalizeWhitespace(statusEl.textContent);
  }
  return '';
}

function parseItemsFromOrderlist(container, orderStatus) {
  const items = [];
  const itemContainers = container.querySelectorAll('.h0c5_5_3-a1');

  itemContainers.forEach(itemContainer => {
    const img = itemContainer.querySelector('.aw15_5_2-a img');
    if (!img) return;

    let imgSrc = img.src || img.getAttribute('data-src');
    if (!imgSrc) return;

    if (imgSrc.startsWith('//')) imgSrc = 'https:' + imgSrc;
    else if (imgSrc.startsWith('/')) imgSrc = 'https://www.ozon.ru' + imgSrc;

    const priceEl = itemContainer.querySelector('.c35_5_2-a0 span.tsHeadline400Small');
    const priceText = priceEl ? normalizeWhitespace(priceEl.textContent) : '';
    const itemPrice = priceText ? parsePrice(priceText) : 0;

    // Payment badge: "Оплачен" / "Не оплачен"
    let payment = '';
    const badges = itemContainer.querySelectorAll('.b5_7_3-a4[title]');
    badges.forEach(badge => {
      const title = normalizeWhitespace(badge.textContent);
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
  });

  return items;
}

function parseOrderRowOrderlist(container) {
  const linkEl = container.querySelector('a.d8w_12[href*="orderdetails"], a[href*="orderdetails"]');
  if (!linkEl) return null;

  const link = linkEl.href;
  const orderNum = extractOrderFromHref(link);
  if (!orderNum) return null;

  const status = parseOrderStatusOrderlist(container);

  if (isCancelled(status) || isReceived(status)) {
    return { id: orderNum, cancelled: true };
  }

  const dateEl = container.querySelector('.dw9_12 span.tsCompactControl500Medium');
  const dateStr = dateEl ? normalizeWhitespace(dateEl.textContent) : '';
  const dateObj = dateStr ? parseDateOrderlist(dateStr) : null;

  const items = parseItemsFromOrderlist(container, status);

  return {
    id: orderNum,
    link: link,
    dateStr: dateStr,
    timestamp: dateObj ? dateObj.getTime() : 0,
    price: 0,
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
  btn.innerHTML = `<span class="ozon-spinner"></span> ${action}... ${current}/${total}`;
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
  const hasOrderlistWidget = document.querySelector('div.dw8_12');
  const hasOrderText = document.body && document.body.textContent.includes('Заказ \u2116');

  if (!hasChequesWidget && !hasOrderlistWidget && !hasOrderText) return;

  const container = document.createElement('div');
  container.id = 'ozon-extend-btn';

  const select = document.createElement('select');
  select.id = 'ozon-limit-select';
  select.className = 'ozon-select';
  const limits = pageType === 'orderlist' ? [25, 50, 100, 200, 500] : [25, 50, 100];
  limits.forEach(n => {
    const opt = document.createElement('option');
    opt.value = n;
    opt.textContent = n;
    if (n === (pageType === 'orderlist' ? 100 : 100)) opt.selected = true;
    select.appendChild(opt);
  });

  const label = document.createElement('span');
  label.className = 'ozon-label';
  label.textContent = 'заказов';

  const btn = document.createElement('button');
  btn.id = 'ozon-collect-btn';
  btn.textContent = 'Построить таблицу';

  btn.onclick = async () => {
    if (isCollecting) return;
    await collectOrders(parseInt(select.value, 10));
  };

  container.appendChild(select);
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

async function collectFromOrderlist(maxOrders) {
  updateProgress(0, maxOrders, 'Сбор заказов');

  let noNewContentCount = 0;
  const seenContainers = new Set();

  while (orders.length < maxOrders && noNewContentCount < 5) {
    const containers = findOrderRowsOrderlist();
    let addedCount = 0;

    for (const container of containers) {
      const parsed = parseOrderRowOrderlist(container);
      if (!parsed || parsed.cancelled) continue;

      // Skip if this exact DOM element was already processed
      if (seenContainers.has(container)) continue;
      seenContainers.add(container);

      orders.push(parsed);
      addedCount++;
    }

    if (orders.length === maxOrders) break;
    if (addedCount === 0) {
      noNewContentCount++;
    } else {
      noNewContentCount = 0;
    }

    if (orders.length < maxOrders && addedCount > 0) {
      window.scrollBy({ top: 800, behavior: 'smooth' });
      await sleep(1000);
      updateProgress(orders.length, maxOrders, 'Сбор заказов');
    }
  }

  if (orders.length === 0) {
    showErrorMessage();
    isCollecting = false;
    return;
  }

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
  const hasOrderlist = document.querySelector('div.dw8_12');
  const hasOrderText = document.body && document.body.textContent.includes('Заказ \u2116');
  if (hasCheques || hasOrderlist || hasOrderText) {
    injectButton();
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

waitForAndInject();
