export async function onRequestPost(context) {
  try {
    const requestData = await context.request.json();

    // LP-CRM settings: ONLY from Cloudflare Variables / Secret.
    const API_KEY = String(context.env.LPCRM_API_KEY || '');
    const CRM_SUBDOMAIN = String(context.env.LPCRM_SUBDOMAIN || '');
    const OFFICE_ID = String(context.env.LPCRM_OFFICE_ID || '');
    const PRODUCT_ID = String(context.env.LPCRM_PRODUCT_ID || '');

    if (!API_KEY) {
      return json(
        {
          success: false,
          error: 'LPCRM_API_KEY is not configured'
        },
        500
      );
    }

    if (!CRM_SUBDOMAIN) {
      return json(
        {
          success: false,
          error: 'LPCRM_SUBDOMAIN is not configured'
        },
        500
      );
    }

    if (!OFFICE_ID) {
      return json(
        {
          success: false,
          error: 'LPCRM_OFFICE_ID is not configured'
        },
        500
      );
    }

    if (!PRODUCT_ID) {
      return json(
        {
          success: false,
          error: 'LPCRM_PRODUCT_ID is not configured'
        },
        500
      );
    }

    // -------------------------
    // PRODUCT / PRICE
    // -------------------------

    const BASE_PRICE = 200;

    const name =
      String(requestData.name || '').trim();

    const phone =
      String(requestData.phone || '').trim();

    const email =
      String(requestData.email || '').trim();

    const quantity =
      Math.max(
        1,
        parseInt(requestData.quantity, 10) || 1
      );

    const discount =
      quantity >= 10 ? 20 :
      quantity >= 5 ? 16 :
      quantity >= 3 ? 8 : 0;

    const baseTotal =
      BASE_PRICE * quantity;

    const saving =
      Math.round(
        baseTotal * discount / 100
      );

    const total =
      baseTotal - saving;

    // -------------------------
    // PAYMENT DATA
    // -------------------------

    const payment =
      String(requestData.payment || 'cod');

    const paid =
      requestData.paid === true;

    const paymentStatus =
      String(
        requestData.paymentStatus || ''
      );

    const paymentProvider =
      String(
        requestData.paymentProvider || ''
      );

    const novapaySessionId =
      String(
        requestData.novapaySessionId || ''
      ).trim();

    const novapayOrderId =
      String(
        requestData.novapayOrderId || ''
      ).trim();

    const novapayPaytype =
      String(
        requestData.novapayPaytype || ''
      ).trim();

    let paymentLabel =
      'Оплата при отриманні';

    if (
      payment === 'online' &&
      paid === true
    ) {
      paymentLabel =
        'Оплачено онлайн через NovaPay';
    } else if (payment === 'online') {
      paymentLabel =
        'Онлайн-оплата NovaPay';
    }

    // -------------------------
    // PRODUCTS
    // -------------------------

    const discountedUnitPrice =
      String(total / quantity);

    const productsList = {
      0: {
        product_id: PRODUCT_ID,
        price: discountedUnitPrice,
        count: String(quantity)
      }
    };

    const products =
      encodeURIComponent(
        phpSerialize(productsList)
      );

    // -------------------------
    // SENDER
    // -------------------------

    const senderArray = {
      SERVER_NAME:
        new URL(
          context.request.url
        ).hostname,

      REMOTE_ADDR:
        context.request.headers.get(
          'cf-connecting-ip'
        ) ||
        context.request.headers.get(
          'x-forwarded-for'
        ) ||
        ''
    };

    const sender =
      encodeURIComponent(
        phpSerialize(senderArray)
      );

    // LP-CRM internal order ID.
    const orderId =
      `${Date.now()}${Math.floor(
        10000 + Math.random() * 90000
      )}`;

    // -------------------------
    // COMMENT
    // -------------------------

    let comment =
      `SPALSADZ | ${quantity} уп. | ` +
      `Знижка ${discount}% | ` +
      `Економія ${saving} грн | ` +
      `До сплати ${total} грн | ` +
      `Оплата: ${paymentLabel}`;

    // Для оплачених NovaPay замовлень
    // додаємо технічні ID для звірки.
    if (
      payment === 'online' &&
      paid === true
    ) {
      if (novapayOrderId) {
        comment +=
          ` | NovaPay Order: ${novapayOrderId}`;
      }

      if (novapaySessionId) {
        comment +=
          ` | NovaPay Session: ${novapaySessionId}`;
      }

      if (novapayPaytype) {
        comment +=
          ` | Тип оплати: ${novapayPaytype}`;
      }
    }

    // -------------------------
    // LP-CRM REQUEST
    // -------------------------

    const orderData =
      new FormData();

    orderData.append(
      'key',
      API_KEY
    );

    orderData.append(
      'order_id',
      orderId
    );

    orderData.append(
      'country',
      'UA'
    );

    orderData.append(
      'office',
      OFFICE_ID
    );

    orderData.append(
      'products',
      products
    );

    orderData.append(
      'bayer_name',
      name
    );

    orderData.append(
      'phone',
      phone
    );

    orderData.append(
      'email',
      email
    );

    orderData.append(
      'comment',
      comment
    );

    orderData.append(
      'notification',
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

    /*
     * Тут поки залишаємо порожньо.
     *
     * У LP-CRM поле payment очікує
     * ID способу оплати з самої CRM,
     * а не "online"/"cod".
     *
     * Статус оплати зараз коректно
     * передається через comment.
     */
    orderData.append(
      'payment',
      ''
    );

    orderData.append(
      'sender',
      sender
    );

    // -------------------------
    // UTM
    // -------------------------

    for (const field of [
      'utm_source',
      'utm_medium',
      'utm_term',
      'utm_content',
      'utm_campaign'
    ]) {
      orderData.append(
        field,
        String(
          requestData[field] || ''
        )
      );
    }

    // -------------------------
    // ADDITIONAL FIELDS
    // -------------------------

    for (let i = 1; i <= 4; i++) {
      orderData.append(
        `additional_${i}`,
        String(
          requestData[
            `additional_${i}`
          ] || ''
        )
      );
    }

    const url =
      `https://${CRM_SUBDOMAIN}.lp-crm.biz/api/addNewOrder.html`;

    console.log(
      'LPCRM request:',
      JSON.stringify({
        crm: CRM_SUBDOMAIN,

        productId:
          PRODUCT_ID,

        price:
          discountedUnitPrice,

        quantity,

        discount,

        baseTotal,

        saving,

        total,

        payment,

        paid,

        paymentStatus,

        paymentProvider,

        novapayOrderId,

        novapaySessionId,

        office:
          OFFICE_ID,

        hasApiKey:
          Boolean(API_KEY),

        hasProducts:
          Boolean(products),

        hasSender:
          Boolean(sender)
      })
    );

    const crmResponse =
      await fetch(
        url,
        {
          method: 'POST',
          body: orderData
        }
      );

    const responseText =
      await crmResponse.text();

    let result;

    try {
      result =
        JSON.parse(
          responseText
        );
    } catch {
      result = {
        raw_response:
          responseText
      };
    }

    console.log(
      'LPCRM response:',
      JSON.stringify(result)
    );

    const crmSuccess =
      result?.status === 'ok' ||
      result?.status === 'success' ||
      result?.success === true;

    return json(
      {
        success:
          crmSuccess,

        crm_status:
          crmResponse.status,

        crm_response:
          result,

        order: {
          productId:
            PRODUCT_ID,

          quantity,

          discount,

          baseTotal,

          saving,

          total,

          payment,

          paid,

          paymentStatus,

          paymentProvider,

          novapayOrderId,

          novapaySessionId
        }
      },

      crmSuccess
        ? 200
        : 502
    );

  } catch (error) {

    console.log(
      'LPCRM error:',
      error?.stack ||
      String(error)
    );

    return json(
      {
        success: false,
        error:
          error?.message ||
          String(error)
      },
      500
    );
  }
}

function json(
  data,
  status = 200
) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'Content-Type':
          'application/json; charset=utf-8'
      }
    }
  );
}


// PHP-compatible serialize()
// for LP-CRM.
function phpSerialize(value) {

  if (value === null) {
    return 'N;';
  }

  if (
    typeof value === 'boolean'
  ) {
    return `b:${value ? 1 : 0};`;
  }

  if (
    typeof value === 'number'
  ) {
    return Number.isInteger(value)
      ? `i:${value};`
      : `d:${value};`;
  }

  if (
    typeof value === 'string'
  ) {
    const bytes =
      new TextEncoder()
        .encode(value)
        .length;

    return (
      `s:${bytes}:"${value}";`
    );
  }

  if (
    Array.isArray(value)
  ) {
    let out =
      `a:${value.length}:{`;

    value.forEach(
      (item, index) => {

        out +=
          phpSerialize(index);

        out +=
          phpSerialize(item);
      }
    );

    return out + '}';
  }

  if (
    typeof value === 'object'
  ) {

    const entries =
      Object.entries(value);

    let out =
      `a:${entries.length}:{`;

    for (
      const [key, item]
      of entries
    ) {

      if (
        /^(0|[1-9]\d*)$/
          .test(key)
      ) {
        out +=
          phpSerialize(
            Number(key)
          );
      } else {
        out +=
          phpSerialize(key);
      }

      out +=
        phpSerialize(item);
    }

    return out + '}';
  }

  return 'N;';
}
