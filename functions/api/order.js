function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=UTF-8" }
  });
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    const email = String(body.email || '').trim();
    const quantity = Math.max(1, Number.parseInt(body.quantity, 10) || 1);
    const discount = Number(body.discount) || 0;
    const total = Number(body.total) || 0;
    const saving = Number(body.saving) || 0;
    const payment = body.payment === 'online' ? 'Онлайн-оплата' : 'Оплата при отриманні';

    if (!name || !phone) return json({ error: 'Name and phone are required' }, 400);

    const apiKey = context.env.LPCRM_API_KEY;
    const subdomain = context.env.LPCRM_SUBDOMAIN || 'ajarmass';
    const productId = context.env.LPCRM_PRODUCT_ID || '5';
    const office = context.env.LPCRM_OFFICE_ID || '1';

    if (!apiKey) return json({ error: 'LPCRM_API_KEY is not configured' }, 500);

    // LP-CRM expects the products array in PHP serialized format.
    const phpSerialize = (value) => {
      if (Array.isArray(value)) {
        let out = `a:${value.length}:{`;
        value.forEach((v, i) => { out += `i:${i};${phpSerialize(v)}`; });
        return out + '}';
      }
      if (value && typeof value === 'object') {
        const keys = Object.keys(value);
        let out = `a:${keys.length}:{`;
        keys.forEach((key) => { out += `s:${key.length}:\"${key}\";${phpSerialize(value[key])}`; });
        return out + '}';
      }
      if (typeof value === 'string') return `s:${value.length}:\"${value}\";`;
      if (Number.isInteger(value)) return `i:${value};`;
      return `s:0:\"\";`;
    };
    const productsList = [{ product_id: String(productId), count: String(quantity) }];
    const products = phpSerialize(productsList);
    const orderId = String(Math.floor(Date.now() / 100));
    const comment = `SPALSADZ | ${quantity} уп. | Знижка ${discount}% | Економія ${saving} грн | До сплати ${total} грн | Оплата: ${payment}`;

    const form = new URLSearchParams();
    form.set('key', apiKey);
    form.set('order_id', orderId);
    form.set('country', 'UA');
    form.set('office', office);
    form.set('products', products);
    form.set('bayer_name', name);
    form.set('phone', phone);
    form.set('email', email);
    form.set('comment', comment);
    form.set('payment', payment);
    form.set('delivery', '');
    form.set('delivery_adress', '');
    form.set('additional_1', String(quantity));
    form.set('additional_2', String(discount));
    form.set('additional_3', String(total));
    form.set('additional_4', payment);

    const crmResponse = await fetch(`https://${subdomain}.lp-crm.biz/api/addNewOrder.html`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: form.toString()
    });

    const crmText = await crmResponse.text();
    if (!crmResponse.ok) return json({ error: 'LP-CRM request failed' }, 502);

    return json({ ok: true, order_id: orderId, crm: crmText });
  } catch (error) {
    return json({ error: 'Invalid request' }, 400);
  }
}

