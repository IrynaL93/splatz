export async function onRequestPost(context) {
  try {
    const requestData = await context.request.json();

    // LP-CRM settings: ONLY from Cloudflare Variables / Secret.
    const API_KEY = String(context.env.LPCRM_API_KEY || '');
    const CRM_SUBDOMAIN = String(context.env.LPCRM_SUBDOMAIN || '');
    const OFFICE_ID = String(context.env.LPCRM_OFFICE_ID || '');
    const PRODUCT_ID = String(context.env.LPCRM_PRODUCT_ID || '');

    if (!API_KEY) {
      return json({ success: false, error: 'LPCRM_API_KEY is not configured' }, 500);
    }
    if (!CRM_SUBDOMAIN) {
      return json({ success: false, error: 'LPCRM_SUBDOMAIN is not configured' }, 500);
    }
    if (!OFFICE_ID) {
      return json({ success: false, error: 'LPCRM_OFFICE_ID is not configured' }, 500);
    }
    if (!PRODUCT_ID) {
      return json({ success: false, error: 'LPCRM_PRODUCT_ID is not configured' }, 500);
    }

    // The base price belongs to the product, not to the browser.
    // Discount rules are duplicated on the server so the amount cannot
    // be changed by editing the frontend request.
    const BASE_PRICE = 200;

    const name = String(requestData.name || '').trim();
    const phone = String(requestData.phone || '').trim();
    const email = String(requestData.email || '').trim();
    const quantity = Math.max(1, parseInt(requestData.quantity, 10) || 1);

    const discount =
      quantity >= 10 ? 20 :
      quantity >= 5 ? 16 :
      quantity >= 3 ? 8 : 0;

    const baseTotal = BASE_PRICE * quantity;
    const saving = Math.round(baseTotal * discount / 100);
    const total = baseTotal - saving;

    // LP-CRM's official landing integration uses PHP serialize()
    // + urlencode() for the products field.
    // We send the request as multipart/form-data (FormData), matching
    // PHP cURL's behavior when CURLOPT_POSTFIELDS receives an array.
    const discountedUnitPrice = String(total / quantity);

    const productsList = {
      0: {
        product_id: PRODUCT_ID,
        price: discountedUnitPrice,
        count: String(quantity)
      }
    };

    const products = encodeURIComponent(phpSerialize(productsList));

    // Approximation of PHP's serialized $_SERVER for the sender field.
    const senderArray = {
      REQUEST_URI: new URL(context.request.url).pathname,
      HTTP_HOST: context.request.headers.get('host') || '',
      HTTP_USER_AGENT: context.request.headers.get('user-agent') || '',
      REMOTE_ADDR: context.request.headers.get('cf-connecting-ip') || ''
    };
    const sender = encodeURIComponent(phpSerialize(senderArray));

    const orderId = `${Date.now()}${Math.floor(10000 + Math.random() * 90000)}`;

    const paymentLabel =
      requestData.payment === 'online'
        ? 'Онлайн-оплата'
        : 'Оплата при отриманні';

    const comment =
      `SPALSADZ | ${quantity} уп. | ` +
      `Знижка ${discount}% | ` +
      `Економія ${saving} грн | ` +
      `До сплати ${total} грн | ` +
      `Оплата: ${paymentLabel}`;

    // Official LP-CRM API expects these fields in a POST request.
    // Payment is intentionally left empty until the actual payment ID
    // from the CRM is configured; "online"/"cod" are frontend values,
    // not guaranteed LP-CRM payment IDs.
    const orderData = new FormData();

    orderData.append('key', API_KEY);
    orderData.append('order_id', orderId);
    orderData.append('country', 'UA');
    orderData.append('office', OFFICE_ID);
    orderData.append('products', products);
    orderData.append('bayer_name', name);
    orderData.append('phone', phone);
    orderData.append('email', email);
    orderData.append('comment', comment);
    orderData.append('notification', '');
    orderData.append('delivery', '');
    orderData.append('delivery_adress', '');
    orderData.append('payment', '');
    orderData.append('sender', sender);

    // UTM and additional fields.
    for (const field of [
      'utm_source',
      'utm_medium',
      'utm_term',
      'utm_content',
      'utm_campaign'
    ]) {
      orderData.append(field, String(requestData[field] || ''));
    }

    for (let i = 1; i <= 4; i++) {
      orderData.append(
        `additional_${i}`,
        String(requestData[`additional_${i}`] || '')
      );
    }

    const url = `https://${CRM_SUBDOMAIN}.lp-crm.biz/api/addNewOrder.html`;

    console.log('LPCRM request:', JSON.stringify({
      crm: CRM_SUBDOMAIN,
      productId: PRODUCT_ID,
      price: discountedUnitPrice,
      quantity,
      discount,
      baseTotal,
      saving,
      total,
      office: OFFICE_ID,
      hasApiKey: Boolean(API_KEY),
      hasProducts: Boolean(products),
      hasSender: Boolean(sender)
    }));

    const crmResponse = await fetch(url, {
      method: 'POST',
      body: orderData
    });

    const responseText = await crmResponse.text();

    let result;
    try {
      result = JSON.parse(responseText);
    } catch {
      result = { raw_response: responseText };
    }

    console.log('LPCRM response:', JSON.stringify(result));

    // LP-CRM returns status: "ok" for a successfully created order.
    const crmSuccess =
      result?.status === 'ok' ||
      result?.status === 'success' ||
      result?.success === true;

    return json(
      {
        success: crmSuccess,
        crm_status: crmResponse.status,
        crm_response: result,
        order: {
          productId: PRODUCT_ID,
          quantity,
          discount,
          baseTotal,
          saving,
          total
        }
      },
      crmSuccess ? 200 : 502
    );
  } catch (error) {
    console.log('LPCRM error:', error?.stack || String(error));
    return json(
      { success: false, error: error?.message || String(error) },
      500
    );
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8'
    }
  });
}

// PHP-compatible serialize() for the arrays/scalars used by LP-CRM.
function phpSerialize(value) {
  if (value === null) return 'N;';
  if (typeof value === 'boolean') return `b:${value ? 1 : 0};`;

  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? `i:${value};`
      : `d:${value};`;
  }

  if (typeof value === 'string') {
    const bytes = new TextEncoder().encode(value).length;
    return `s:${bytes}:"${value}";`;
  }

  if (Array.isArray(value)) {
    let out = `a:${value.length}:{`;
    value.forEach((item, index) => {
      out += phpSerialize(index);
      out += phpSerialize(item);
    });
    return out + '}';
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value);
    let out = `a:${entries.length}:{`;

    for (const [key, item] of entries) {
      if (/^(0|[1-9]\d*)$/.test(key)) {
        out += phpSerialize(Number(key));
      } else {
        out += phpSerialize(key);
      }
      out += phpSerialize(item);
    }

    return out + '}';
  }

  return 'N;';
}
