let allOrders = [];
let filteredRows = [];
let sortField = 'date';
let sortAsc = false;
const checkedState = new Map();

async function init() {
  const data = await chrome.storage.local.get(['ozonOrders', 'ozonPageType']);
  window.ozonPageType = data.ozonPageType || 'e-check';
  allOrders = (data.ozonOrders || []).map(o => {
    let ts = o.timestamp;
    if (!ts && o.dateObj) {
      ts = new Date(o.dateObj).getTime();
    }
    if (!ts && o.dateStr) {
      const parsed = parseRussianDate(o.dateStr);
      if (parsed) ts = parsed.getTime();
    }
    return {
      ...o,
      dateObj: o.dateObj ? new Date(o.dateObj) : null,
      timestamp: ts || 0,
      price: o.price || 0,
      items: o.items || []
    };
  });

  const fromInput = document.getElementById('dateFrom');
  const toInput = document.getElementById('dateTo');

  if (allOrders.length > 0) {
    const timestamps = allOrders.map(o => o.timestamp).filter(Boolean);
    if (timestamps.length) {
      fromInput.min = formatInputDate(new Date(Math.min(...timestamps)));
      toInput.max = formatInputDate(new Date(Math.max(...timestamps)));
    }
  }

  document.getElementById('dateFrom').addEventListener('input', render);
  document.getElementById('dateTo').addEventListener('input', render);
  document.getElementById('priceFrom').addEventListener('input', render);
  document.getElementById('priceTo').addEventListener('input', render);
  document.getElementById('searchInput').addEventListener('input', render);
  document.getElementById('hideUnchecked').addEventListener('change', render);
  document.getElementById('downloadBtn').addEventListener('click', downloadHTML);
  document.getElementById('toggleAll').addEventListener('click', invertChecked);

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const field = th.dataset.sort;
      if (sortField === field) {
        sortAsc = !sortAsc;
      } else {
        sortField = field;
        sortAsc = field === 'price' || field === 'name' || field === 'status' || field === 'payment';
      }
      // Brief visual confirmation
      th.classList.add('sort-flash');
      setTimeout(() => th.classList.remove('sort-flash'), 300);
      render();
    });
  });

  render();
}

function formatInputDate(date) {
  return date.toISOString().split('T')[0];
}

function parseRussianDate(dateStr) {
  const months = {
    'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3, 'мая': 4, 'июня': 5,
    'июля': 6, 'августа': 7, 'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
  };
  const normalized = dateStr.replace(/[\u00A0\u202F\u200B\u200C\u200D\uFEFF]/g, ' ').trim();
  // E-check: "16 августа 2026 в 02:03"
  let match = normalized.match(/(\d{1,2})\s([а-яё]+)\s(\d{4})\sв\s(\d{2}):(\d{2})/);
  if (match) {
    const [, day, monthStr, year, hours, minutes] = match;
    const monthIndex = months[monthStr.toLowerCase()];
    if (monthIndex === undefined) return null;
    return new Date(
      parseInt(year, 10),
      monthIndex,
      parseInt(day, 10),
      parseInt(hours, 10),
      parseInt(minutes, 10)
    );
  }
  // Orderlist: "Ожидаем 16 августа", "15 – 21 сентября"
  match = normalized.match(/(\d{1,2})\s+([а-яё]+)/);
  if (match) {
    const [, day, monthStr] = match;
    const monthIndex = months[monthStr.toLowerCase()];
    if (monthIndex === undefined) return null;
    return new Date(new Date().getFullYear(), monthIndex, parseInt(day, 10));
  }
  return null;
}

function formatPrice(price) {
  return price.toLocaleString('ru-RU') + ' ₽';
}

function flattenOrders() {
  const rows = [];
  allOrders.forEach(order => {
    const ts = order.timestamp || 0;
    if (order.items && order.items.length) {
      order.items.forEach(item => {
        let name = item.name || '';
        const qty = item.qtyPayment || '';
        if (!name && qty) name = qty;
        let paid = 'НЕТ';
        if (window.ozonPageType === 'e-check') {
          paid = 'ДА';
        } else {
          const rawPayment = (item.payment || '').toLowerCase();
          if (rawPayment.includes('оплач') && !rawPayment.includes('не ')) paid = 'ДА';
        }
        const rowKey = `${order.id}|${name}|${item.price || 0}`;
        rows.push({
          img: item.img,
          name: name,
          price: item.price || 0,
          status: item.status || '—',
          paid: paid,
          orderId: order.id,
          orderLink: order.link,
          dateStr: order.dateStr || '—',
          timestamp: ts,
          key: rowKey,
          checked: checkedState.get(rowKey) !== false
        });
      });
    } else {
      const rowKey = `${order.id}|no-item|${order.price}`;
      rows.push({
        img: null,
        name: '',
        price: order.price,
        status: '—',
        paid: window.ozonPageType === 'e-check' ? 'ДА' : 'НЕТ',
        orderId: order.id,
        orderLink: order.link,
        dateStr: order.dateStr || '—',
        timestamp: ts,
        key: rowKey,
        checked: checkedState.get(rowKey) !== false
      });
    }
  });
  return rows;
}

function applyFiltersAndSort() {
  const dateFrom = document.getElementById('dateFrom').value;
  const dateTo = document.getElementById('dateTo').value;
  const priceFrom = document.getElementById('priceFrom').value;
  const priceTo = document.getElementById('priceTo').value;
  const searchRaw = document.getElementById('searchInput').value.trim();
  const negatedTerms = [];
  const positiveTerms = [];
  searchRaw.split(/\s+/).filter(Boolean).forEach(term => {
    if (term.startsWith('!')) {
      negatedTerms.push(term.slice(1).toLowerCase());
    } else {
      positiveTerms.push(term.toLowerCase());
    }
  });

  let rows = flattenOrders();

  const hideUnchecked = document.getElementById('hideUnchecked').checked;
  filteredRows = rows.filter(r => {
    if (hideUnchecked && !r.checked) return false;
    if (dateFrom && r.timestamp && r.timestamp < new Date(dateFrom).getTime()) return false;
    if (dateTo && r.timestamp && r.timestamp > new Date(dateTo + 'T23:59:59').getTime()) return false;
    if (priceFrom && r.price < +priceFrom) return false;
    if (priceTo && r.price > +priceTo) return false;
    if (searchRaw) {
      const haystack = [r.name, r.orderId, r.dateStr, String(r.price), r.status, r.paid].join(' ').toLowerCase();
      const hasNegated = negatedTerms.some(t => haystack.includes(t));
      if (hasNegated) return false;
      if (positiveTerms.length > 0 && !positiveTerms.some(t => haystack.includes(t))) return false;
    }
    return true;
  });

  console.log(`Sort: ${sortField} ${sortAsc ? 'ASC' : 'DESC'}`);
  filteredRows.sort((a, b) => {
    if (sortField === 'name') {
      const cmp = (a.name || '').localeCompare(b.name || '', 'ru');
      return sortAsc ? cmp : -cmp;
    }
    if (sortField === 'status') {
      const cmp = (a.status || '').localeCompare(b.status || '', 'ru');
      return sortAsc ? cmp : -cmp;
    }
    if (sortField === 'payment') {
      const cmp = (a.paid || '').localeCompare(b.paid || '', 'ru');
      return sortAsc ? cmp : -cmp;
    }
    if (sortField === 'id') {
      return sortAsc
        ? (a.orderId || '').localeCompare(b.orderId || '', 'ru', { numeric: true })
        : (b.orderId || '').localeCompare(a.orderId || '', 'ru', { numeric: true });
    }
    if (sortField === 'date') {
      const ta = a.timestamp || parseRussianDate(a.dateStr)?.getTime() || 0;
      const tb = b.timestamp || parseRussianDate(b.dateStr)?.getTime() || 0;
      return sortAsc ? ta - tb : tb - ta;
    }
    // price — numeric
    return sortAsc
      ? (a.price || 0) - (b.price || 0)
      : (b.price || 0) - (a.price || 0);
  });
}

function render() {
  applyFiltersAndSort();

  const tbody = document.getElementById('ordersBody');
  tbody.innerHTML = '';

  if (filteredRows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8">Нет позиций по заданным фильтрам</td></tr>';
    document.getElementById('summary').textContent = '0 позиций';
    updateSortArrows();
    return;
  }

  filteredRows.forEach((row, idx) => {
    const tr = document.createElement('tr');

    // Checkbox cell
    const cbTd = document.createElement('td');
    cbTd.style.cssText = 'text-align:center;width:36px;padding:8px;';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = row.checked;
    cb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:#ddd;';
    cb.addEventListener('change', () => {
      filteredRows[idx].checked = cb.checked;
      checkedState.set(row.key, cb.checked);
      updateSummary();
      setupSelectAll();
    });
    cbTd.appendChild(cb);

    // Image cell
    const imgTd = document.createElement('td');
    imgTd.className = 'images-cell';
    if (row.img) {
      const img = document.createElement('img');
      img.src = row.img;
      img.alt = row.name;
      img.title = row.name;
      img.className = 'product-img';
      img.loading = 'lazy';
       img.style.cursor = 'pointer';
       img.addEventListener('click', () => openImgModalByIndex(idx));
       imgTd.appendChild(img);
    } else {
      imgTd.appendChild(document.createTextNode('—'));
    }

    // Name cell
    const nameTd = document.createElement('td');
    nameTd.className = 'name-cell';
    nameTd.textContent = row.name || '—';

    // Order link cell
    const idTd = document.createElement('td');
    const idLink = document.createElement('a');
    idLink.href = row.orderLink;
    idLink.target = '_blank';
    idLink.textContent = row.orderId;
    idTd.appendChild(idLink);

    // Date cell
    const dateTd = document.createElement('td');
    dateTd.textContent = row.dateStr;

    // Status cell
    const statusTd = document.createElement('td');
    statusTd.className = 'status-cell';
    statusTd.textContent = row.status || '—';

    // Payment cell
    const paidTd = document.createElement('td');
    paidTd.className = 'status-cell';
    paidTd.textContent = row.paid || 'НЕТ';

    // Price cell
    const priceTd = document.createElement('td');
    priceTd.className = 'price-cell';
    priceTd.textContent = formatPrice(row.price);
    if (row.paid === 'ДА') {
      priceTd.style.color = '#16a34a';
    } else {
      priceTd.style.color = '#000';
    }

    tr.appendChild(cbTd);
    tr.appendChild(imgTd);
    tr.appendChild(nameTd);
    tr.appendChild(idTd);
    tr.appendChild(dateTd);
    tr.appendChild(statusTd);
    tr.appendChild(paidTd);
    tr.appendChild(priceTd);

    tbody.appendChild(tr);
  });

  updateSummary();

  updateSortArrows();
  setupSelectAll();
}

function setupSelectAll() {
  const parent = document.getElementById('selectAll').parentNode;
  const checkedCount = filteredRows.filter(r => r.checked).length;
  const allChecked = checkedCount === filteredRows.length;
  const someChecked = checkedCount > 0 && checkedCount < filteredRows.length;
  const newValue = allChecked || someChecked;

  // Create fresh element to avoid stale listeners
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.id = 'selectAll';
  cb.style.cssText = 'width:16px;height:16px;cursor:pointer;accent-color:#ddd;';
  cb.checked = newValue;
  cb.indeterminate = someChecked;

  cb.addEventListener('change', () => {
    filteredRows.forEach(r => {
      r.checked = cb.checked;
      checkedState.set(r.key, cb.checked);
    });
    render();
  });

  parent.replaceChild(cb, document.getElementById('selectAll'));
}

function updateSummary() {
  const total = filteredRows.filter(r => r.checked).reduce((sum, r) => sum + r.price, 0);
  const checkedCount = filteredRows.filter(r => r.checked).length;
  document.getElementById('summary').textContent =
    `${checkedCount} из ${filteredRows.length} на сумму ${formatPrice(total)}`;
}

function updateSortArrows() {
  const ths = document.querySelectorAll('th[data-sort]');
  for (let i = 0; i < ths.length; i++) {
    const th = ths[i];
    const arrow = th.querySelector('.sort-arrow');
    if (th.dataset.sort === sortField) {
      th.classList.add('active-sort');
      if (arrow) arrow.className = `sort-arrow ${sortAsc ? 'asc' : 'desc'}`;
    } else {
      th.classList.remove('active-sort');
      if (arrow) arrow.className = 'sort-arrow';
    }
  }
}

function invertChecked() {
  filteredRows.forEach(r => {
    r.checked = !r.checked;
    checkedState.set(r.key, r.checked);
  });
  render();
}

function downloadHTML() {
  const clone = document.documentElement.cloneNode(true);
  clone.querySelectorAll('script').forEach(s => s.remove());
  clone.querySelectorAll('meta[name]').forEach(m => m.remove());
  const html = '<!DOCTYPE html>\n' + clone.outerHTML;
  const blob = new Blob(['\uFEFF' + html], { type: 'text/html; charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ozon-orders-${new Date().toISOString().split('T')[0]}.html`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function openImgModal(src, title) {
  const existing = document.querySelector('.img-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.className = 'img-modal';

  const img = document.createElement('img');
  img.src = src;
  img.alt = title || '';

  modal.appendChild(img);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.remove();
  });
  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', handler);
    }
  });
  document.body.appendChild(modal);
}

function openImgModalByIndex(startIndex) {
  const checkedWithImages = filteredRows
    .map((r, i) => ({ row: r, idx: i }))
    .filter(p => p.row.checked && p.row.img);

  if (!checkedWithImages.length) return;

  let currentPos = 0;
  for (let i = 0; i < checkedWithImages.length; i++) {
    if (checkedWithImages[i].idx === startIndex) {
      currentPos = i;
      break;
    }
  }

  const modal = document.createElement('div');
  modal.className = 'img-modal';

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:12px;';

  const img = document.createElement('img');

  const caption = document.createElement('div');
  caption.style.cssText = 'color:white;font-size:14px;text-align:center;max-width:90vw;';

  function slideTo(pos) {
    currentPos = pos;
    const p = checkedWithImages[pos];
    img.src = p.row.img;
    img.alt = p.row.name || '';
    caption.textContent = `${p.row.name || '—'}  (${pos + 1} / ${checkedWithImages.length})`;
  }

  slideTo(currentPos);

  wrapper.appendChild(img);
  wrapper.appendChild(caption);
  modal.appendChild(wrapper);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      modal.remove();
      document.removeEventListener('keydown', handler);
    }
  });

  function handler(e) {
    if (e.key === 'Escape') {
      modal.remove();
      document.removeEventListener('keydown', handler);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      slideTo((currentPos + 1) % checkedWithImages.length);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      slideTo((currentPos - 1 + checkedWithImages.length) % checkedWithImages.length);
    }
  }
  document.addEventListener('keydown', handler);
  document.body.appendChild(modal);
}

document.addEventListener('DOMContentLoaded', init);
