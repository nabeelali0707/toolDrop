// The fixture's single-page app. It loads invoices from the internal JSON API,
// like a real site would, so the browser_script strategy has something to drive.

const meta = (name) => document.querySelector(`meta[name="${name}"]`).content;
const csrf = meta('csrf-token');
const apiBase = meta('api-base');

const form = document.querySelector('#search');
const rows = document.querySelector('#invoices tbody');
const more = document.querySelector('#more');
const error = document.querySelector('#error');
let page = 1;

async function load(replace) {
  const fields = new FormData(form);
  const response = await fetch(`${apiBase}/invoices/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify({ status: fields.get('status') ?? '', from: fields.get('from') ?? '', page }),
  });
  if (!response.ok) {
    error.textContent = `Could not load invoices (${response.status})`;
    error.hidden = false;
    return;
  }
  error.hidden = true;
  const result = await response.json();
  if (replace) rows.replaceChildren();
  for (const item of result.items) {
    const row = rows.insertRow();
    for (const value of [
      item.invoiceNo,
      item.supplier,
      item.issuedOn,
      item.total.value.toFixed(2),
      item.state,
    ]) {
      row.insertCell().textContent = value;
    }
  }
  more.hidden = !result.hasMore;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  page = 1;
  void load(true);
});

more.addEventListener('click', () => {
  page += 1;
  void load(false);
});

void load(true);
