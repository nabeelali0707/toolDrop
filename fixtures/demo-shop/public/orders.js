// The Demo Shop's orders page. Like many shops, it trades the session cookie
// for a short-lived bearer token, then calls the orders API with the token.

const ordersApi = document.querySelector('meta[name="orders-api"]').content;
const filters = document.querySelector('#filters');
const rows = document.querySelector('#orders tbody');
const more = document.querySelector('#more');
const error = document.querySelector('#error');
let token;
let page = 1;

async function bearerToken() {
  if (token) return token;
  const response = await fetch('/api/session/token');
  if (!response.ok) throw new Error(`Could not start a session (${response.status})`);
  token = (await response.json()).token;
  return token;
}

function delivery(fulfillment) {
  if (fulfillment.deliveredDate) return `Delivered ${fulfillment.deliveredDate}`;
  if (fulfillment.expectedDate) return `Expected ${fulfillment.expectedDate}`;
  return '-';
}

async function load(replace) {
  try {
    const status = new FormData(filters).get('status') ?? '';
    const query = new URLSearchParams({ page: String(page), ...(status && { status }) });
    const response = await fetch(`${ordersApi}?${query}`, {
      headers: { authorization: `Bearer ${await bearerToken()}` },
    });
    if (!response.ok) throw new Error(`Could not load orders (${response.status})`);
    const result = await response.json();
    error.hidden = true;
    if (replace) rows.replaceChildren();
    for (const order of result.data) {
      const row = rows.insertRow();
      const items = order.lines.map((line) => `${line.qty} × ${line.product}`).join(', ');
      for (const value of [
        order.orderId,
        order.placedAt,
        items,
        order.grandTotal.amount.toFixed(2),
        order.fulfillment.status,
        delivery(order.fulfillment),
      ]) {
        row.insertCell().textContent = value;
      }
    }
    more.hidden = !result.meta.hasNextPage;
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  }
}

filters.addEventListener('submit', (event) => {
  event.preventDefault();
  page = 1;
  void load(true);
});

more.addEventListener('click', () => {
  page += 1;
  void load(false);
});

void load(true);
