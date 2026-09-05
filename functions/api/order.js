export async function onRequestPost(context) {
  try {
    // 1. Дані від форми
    const requestData = await context.request.json();

    // 2. Secrets Cloudflare
    const API_KEY = context.env.LPCRM_API_KEY;
    const CRM_SUBDOMAIN = context.env.LPCRM_SUBDOMAIN;
    const OFFICE_ID = context.env.LPCRM_OFFICE_ID || '1';
    const PRODUCT_ID = context.env.LPCRM_PRODUCT_ID || '5';

    if (!API_KEY) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'LPCRM_API_KEY is not configured'
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    // 3. Дані замовлення
    const quantity = Math.max(
      1,
      parseInt(requestData.quantity, 10) || 1
    );

    const price = 200;

    // 4. Формуємо products у JSON
    const products = JSON.stringify([
      {
        product_id: String(PRODUCT_ID),
        price: String(price),
        count: String(quantity)
      }
    ]);

    // 5. Формуємо запит LP-CRM
    const orderData = new URLSearchParams();

    orderData.append('key', API_KEY);
    orderData.append(
      'order_id',
      Date.now().toString()
    );

    orderData.append(
      'country',
      requestData.country || 'UA'
    );

    orderData.append(
      'office',
      requestData.office || OFFICE_ID
    );

    orderData.append(
      'products',
      products
    );

    orderData.append(
      'bayer_name',
      requestData.name || ''
    );

    orderData.append(
      'phone',
      requestData.phone || ''
    );

    orderData.append(
      'email',
      requestData.email || ''
    );

    orderData.append(
      'comment',
      `SPALSADZ | ${quantity} уп. | Знижка ${requestData.discount || 0}% | Економія ${requestData.saving || 0} грн | До сплати ${requestData.total || quantity * price} грн`
    );

    orderData.append(
      'payment',
      ''
    );

    orderData.append(
      'delivery',
      ''
    );

    orderData.append(
      'delivery_adress',
      ''
    );

    // 6. UTM
    if (requestData.utm_source) {
      orderData.append(
        'utm_source',
        requestData.utm_source
      );
    }

    if (requestData.utm_medium) {
      orderData.append(
        'utm_medium',
        requestData.utm_medium
      );
    }

    if (requestData.utm_term) {
      orderData.append(
        'utm_term',
        requestData.utm_term
      );
    }

    if (requestData.utm_content) {
      orderData.append(
        'utm_content',
        requestData.utm_content
      );
    }

    if (requestData.utm_campaign) {
      orderData.append(
        'utm_campaign',
        requestData.utm_campaign
      );
    }

    // 7. Відправляємо в LP-CRM
    const url =
      `https://${CRM_SUBDOMAIN}.lp-crm.biz/api/addNewOrder.html`;

    const crmResponse = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type':
          'application/x-www-form-urlencoded'
      },
      body: orderData.toString()
    });

    // 8. Читаємо відповідь
    const responseText =
      await crmResponse.text();

    let result;

    try {
      result = JSON.parse(responseText);
    } catch {
      result = {
        raw_response: responseText
      };
    }

    console.log(
      'LPCRM response:',
      JSON.stringify(result)
    );

    // 9. Перевіряємо не тільки HTTP 200,
    // а й статус, який повернув сам LP-CRM
    const crmSuccess =
      result?.status === 'success' ||
      result?.success === true;

    return new Response(
      JSON.stringify({
        success: crmSuccess,
        crm_status: crmResponse.status,
        crm_response: result
      }),
      {
        status: crmSuccess ? 200 : 502,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

  } catch (error) {

    console.log(
      'LPCRM error:',
      error?.stack || String(error)
    );

    return new Response(
      JSON.stringify({
        success: false,
        error: error?.message || String(error)
      }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  }
}
