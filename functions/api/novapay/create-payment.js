function pemToArrayBuffer(pem) {
  const base64 = String(pem || '')
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function createSignature(body, privateKeyPem) {
  const keyData =
    pemToArrayBuffer(privateKeyPem);

  const privateKey =
    await crypto.subtle.importKey(
      'pkcs8',
      keyData,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256'
      },
      false,
      ['sign']
    );

  const encoded =
    new TextEncoder().encode(body);

  const signature =
    await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5',
      privateKey,
      encoded
    );

  const bytes =
    new Uint8Array(signature);

  let binary = '';

  for (const byte of bytes) {
    binary +=
      String.fromCharCode(byte);
  }

  return btoa(binary);
}

async function novapayRequest(
  url,
  data,
  privateKey
) {
  /*
   * Підписуємо саме той JSON-рядок,
   * який потім відправляємо NovaPay.
   */
  const body =
    JSON.stringify(data);

  const signature =
    await createSignature(
      body,
      privateKey
    );

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          'Accept':
            'application/json',

          'x-sign':
            signature
        },

        body
      }
    );

  const responseText =
    await response.text();

  let result;

  try {
    result =
      JSON.parse(responseText);
  } catch {
    result = {
      raw: responseText
    };
  }

  if (!response.ok) {
    throw new Error(
      `NovaPay ${response.status}: ${responseText}`
    );
  }

  return result;
}

function normalizePhone(phone) {
  let value =
    String(phone || '')
      .replace(/[^\d+]/g, '');

  if (value.startsWith('0')) {
    value =
      '+38' + value;
  }

  if (value.startsWith('380')) {
    value =
      '+' + value;
  }

  return value;
}

function getDiscount(quantity) {
  if (quantity >= 10) {
    return 20;
  }

  if (quantity >= 5) {
    return 16;
  }

  if (quantity >= 3) {
    return 8;
  }

  return 0;
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

export async function onRequestPost(context) {
  try {
    const env =
      context.env;

    // -------------------------
    // ENV
    // -------------------------

    const MERCHANT_ID =
      String(
        env.NOVAPAY_MERCHANT_ID || ''
      ).trim();

    const PRIVATE_KEY =
      String(
        env.NOVAPAY_PRIVATE_KEY || ''
      ).trim();

    const NOVAPAY_ENV =
      String(
        env.NOVAPAY_ENV || ''
      ).trim();

    if (!MERCHANT_ID) {
      throw new Error(
        'NOVAPAY_MERCHANT_ID is missing'
      );
    }

    if (!PRIVATE_KEY) {
      throw new Error(
        'NOVAPAY_PRIVATE_KEY is missing'
      );
    }

    /*
     * В production НЕ робимо
     * автоматичний fallback у sandbox.
     *
     * Якщо змінна налаштована неправильно,
     * краще отримати явну помилку.
     */
    if (
      NOVAPAY_ENV !== 'production' &&
      NOVAPAY_ENV !== 'test'
    ) {
      throw new Error(
        'NOVAPAY_ENV must be "production" or "test"'
      );
    }

    const API_BASE =
      NOVAPAY_ENV === 'production'
        ? 'https://api-ecom.novapay.ua'
        : 'https://api-qecom.novapay.ua';

    // -------------------------
    // REQUEST
    // -------------------------

    const requestData =
      await context.request.json();

    const phone =
      normalizePhone(
        requestData.phone
      );

    const name =
      String(
        requestData.name || ''
      ).trim();

    if (!phone) {
      return json(
        {
          success: false,
          error: 'Phone is required'
        },
        400
      );
    }

    // -------------------------
    // SERVER-SIDE PRICE CALC
    // -------------------------

    /*
     * Не довіряємо amount / price /
     * discount із frontend.
     */

    const parsedQuantity =
      Math.floor(
        Number(
          requestData.quantity || 1
        )
      );

    const quantity =
      Number.isFinite(parsedQuantity) &&
      parsedQuantity > 0
        ? parsedQuantity
        : 1;

    const price =
      200;

    const discount =
      getDiscount(quantity);

    const baseTotal =
      price * quantity;

    const saving =
      Math.round(
        baseTotal *
        discount /
        100
      );

    const total =
      baseTotal - saving;

    /*
     * NovaPay products[] повинні
     * відповідати фактичній сумі платежу.
     *
     * Наприклад:
     * 3 × 200 = 600
     * -8% = 552
     * unit price = 184
     */
    const discountedUnitPrice =
      Number(
        (
          total /
          quantity
        ).toFixed(2)
      );

    /*
     * Додаткова серверна перевірка,
     * що products[] не розходяться
     * із загальною сумою.
     */
    const productsTotal =
      Number(
        (
          discountedUnitPrice *
          quantity
        ).toFixed(2)
      );

    if (
      Math.abs(
        productsTotal - total
      ) > 0.01
    ) {
      throw new Error(
        'Product total does not match order total'
      );
    }

    // -------------------------
    // URL / ORDER ID
    // -------------------------

    const origin =
      new URL(
        context.request.url
      ).origin;

    const orderId =
      `SPALSADZ-${Date.now()}`;

    // -------------------------
    // 1. CREATE CHECKOUT SESSION
    // -------------------------

    const sessionData = {
      merchant_id:
        MERCHANT_ID,

      client_phone:
        phone,

      callback_url:
        `${origin}/api/novapay/callback`,

      success_url:
        `${origin}/?payment=success`,

      fail_url:
        `${origin}/?payment=fail`,

      create_express_waybill:
        false
    };

    console.log(
      'NovaPay create session:',
      JSON.stringify({
        environment:
          NOVAPAY_ENV,

        merchantId:
          MERCHANT_ID,

        name,

        phone,

        quantity,

        price,

        discountedUnitPrice,

        discount,

        baseTotal,

        saving,

        total,

        callback:
          sessionData.callback_url
      })
    );

    const session =
      await novapayRequest(
        `${API_BASE}/v1/checkout/session`,
        sessionData,
        PRIVATE_KEY
      );

    console.log(
      'NovaPay session response:',
      JSON.stringify(session)
    );

    const sessionId =
      session.id ||
      session.session_id ||
      session.data?.id ||
      session.data?.session_id;

    if (!sessionId) {
      return json(
        {
          success: false,

          stage:
            'session',

          error:
            'NovaPay did not return session_id',

          novapay:
            session
        },
        502
      );
    }

    // -------------------------
    // 2. ADD CHECKOUT PAYMENT
    // -------------------------

    const paymentData = {
      merchant_id:
        MERCHANT_ID,

      session_id:
        String(sessionId),

      external_id:
        orderId,

      amount:
        total,

      use_hold:
        false,

      products: [
        {
          description:
            'SPALSADZ — 1 кг',

          count:
            quantity,

          /*
           * Тут уже ціна зі знижкою,
           * щоб products[] == amount.
           */
          price:
            discountedUnitPrice
        }
      ]
    };

    console.log(
      'NovaPay payment request:',
      JSON.stringify({
        environment:
          NOVAPAY_ENV,

        merchantId:
          MERCHANT_ID,

        sessionId,

        externalId:
          orderId,

        quantity,

        price,

        discountedUnitPrice,

        discount,

        baseTotal,

        saving,

        total
      })
    );

    const payment =
      await novapayRequest(
        `${API_BASE}/v1/checkout/payment`,
        paymentData,
        PRIVATE_KEY
      );

    console.log(
      'NovaPay payment response:',
      JSON.stringify(payment)
    );

    // -------------------------
    // SUCCESS
    // -------------------------

    return json(
      {
        success: true,

        environment:
          NOVAPAY_ENV,

        /*
         * Ці значення frontend
         * збереже перед redirect.
         *
         * sessionId потім потрібен
         * для /api/novapay/status.
         */
        orderId,

        sessionId,

        order: {
          name,

          phone,

          quantity,

          price,

          discountedUnitPrice,

          discount,

          baseTotal,

          saving,

          total
        },

        session,

        payment
      },
      200
    );

  } catch (error) {

    console.error(
      'NovaPay create payment error:',
      error?.stack ||
      error?.message ||
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
