export async function onRequestPost(context) {
  try {
    const requestData = await context.request.json();

    // Cloudflare Secrets / Variables
    const API_KEY = context.env.LPCRM_API_KEY;
    const CRM_SUBDOMAIN = context.env.LPCRM_SUBDOMAIN;
    const OFFICE_ID = String(context.env.LPCRM_OFFICE_ID || '1');

    if (!API_KEY) {
      return json({ success: false, error: 'LPCRM_API_KEY is not configured' }, 500);
    }
    if (!CRM_SUBDOMAIN) {
      return json({ success: false, error: 'LPCRM_SUBDOMAIN is not configured' }, 500);
    }

    // Дані мають відповідати тому, що передає index.html
    const productId = String(requestData.productId || '5');
    const price = String(requestData.price || '200');
    const quantity = Math.max(1, parseInt(requestData.quantity, 10) || 1);
    const country = String(requestData.country || 'UA');
    const office = String(requestData.office || OFFICE_ID);

    // PHP serialize() для простих масивів LP-CRM.
    // LP-CRM очікує products саме у serialized PHP-форматі, а не JSON.
    const productsArray = {
      0: {
        product_id: productId,
        price: price,
        count: String(quantity),
        subs: {}
      }
    };
    const products = phpSerialize(productsArray);

    // Аналог $_SERVER для поля sender. Сам API-ключ сюди не потрапляє.
    const senderArray = {
      REQUEST_URI: new URL(context.request.url).pathname,
      HTTP_HOST: context.request.headers.get('host') || '',
      HTTP_USER_AGENT: context.request.headers.get('user-agent') || '',
      REMOTE_ADDR: context.request.headers.get('cf-connecting-ip') || ''
    };
    const sender = phpSerialize(senderArray);

    const orderId = `${Date.now()}${Math.floor(10000 + Math.random() * 90000)}`;
    const orderData = new URLSearchParams();

    orderData.append('key', API_KEY);
    orderData.append('order_id', orderId);
    orderData.append('country', country);
    orderData.append('office', office);
    orderData.append('products', products);
    orderData.append('bayer_name', String(requestData.name || ''));
    orderData.append('phone', String(requestData.phone || ''));
    orderData.append('email', String(requestData.email || ''));
    orderData.append(
      'comment',
      `SPALSADZ | ${quantity} уп. | Знижка ${requestData.discount || 0}% | Економія ${requestData.saving || 0} грн | До сплати ${requestData.total || Number(quantity) * Number(price)} грн | Оплата: ${requestData.payment === 'online' ? 'Онлайн-оплата' : 'Оплата при отриманні'}`
    );
    orderData.append('notification', '');
    orderData.append('delivery', '');
    orderData.append('delivery_adress', '');
    orderData.append('payment', String(requestData.payment || ''));
    orderData.append('sender', sender);

    // UTM-поля — передаємо навіть порожні, як у прикладі LP-CRM.
    for (const field of ['utm_source', 'utm_medium', 'utm_term', 'utm_content', 'utm_campaign']) {
      orderData.append(field, String(requestData[field] || ''));
    }
    for (let i = 1; i <= 4; i++) {
      orderData.append(`additional_${i}`, String(requestData[`additional_${i}`] || ''));
    }

    const url = `https://${CRM_SUBDOMAIN}.lp-crm.biz/api/addNewOrder.html`;

    console.log('LPCRM request:', JSON.stringify({
      crm: CRM_SUBDOMAIN,
      productId,
      price,
      quantity,
      country,
      office,
      hasApiKey: Boolean(API_KEY),
      hasProducts: Boolean(products),
      hasSender: Boolean(sender)
    }));

    const crmResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: orderData.toString()
    });

    const responseText = await crmResponse.text();
    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      result = { raw_response: responseText };
    }

    console.log('LPCRM response:', JSON.stringify(result));

    const crmSuccess = result?.status === 'success' || result?.success === true;

    return json({
      success: crmSuccess,
      crm_status: crmResponse.status,
      crm_response: result
    }, crmSuccess ? 200 : 502);
  } catch (error) {
    console.log('LPCRM error:', error?.stack || String(error));
    return json({ success: false, error: error?.message || String(error) }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Мінімальна реалізація PHP serialize() для scalar/array значень.
function phpSerialize(value) {
  if (value === null) return 'N;';
  if (typeof value === 'boolean') return `b:${value ? 1 : 0};`;
  if (typeof value === 'number' && Number.isInteger(value)) return `i:${value};`;
  if (typeof value === 'number') return `d:${value};`;
  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value).length;
    return `s:${bytes}:"${value}";`;
  }
  if (Array.isArray(value)) {
    let out = `a:${value.length}:{`;
    value.forEach((v, i) => { out += phpSerialize(i) + phpSerialize(v); });
    return out + '}';
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    let out = `a:${entries.length}:{`;
    for (const [key, val] of entries) {
      // Числові ключі PHP-масиву — integer, інші — string.
      if (/^(0|[1-9]\d*)$/.test(key)) out += phpSerialize(Number(key));
      else out += phpSerialize(key);
      out += phpSerialize(val);
    }
    return out + '}';
  }
  return 'N;';
}
