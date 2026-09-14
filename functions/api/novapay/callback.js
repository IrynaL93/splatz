function pemToArrayBuffer(pem) {
  const base64 = String(pem || '')
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s+/g, '');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes.buffer;
}

async function verifySignature(rawBody, signatureBase64, publicKeyPem) {
  if (!signatureBase64 || !publicKeyPem) {
    return false;
  }

  const keyData = pemToArrayBuffer(publicKeyPem);

  const publicKey = await crypto.subtle.importKey(
    'spki',
    keyData,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['verify']
  );

  const signatureBinary = atob(signatureBase64);
  const signatureBytes = new Uint8Array(signatureBinary.length);

  for (let i = 0; i < signatureBinary.length; i++) {
    signatureBytes[i] = signatureBinary.charCodeAt(i);
  }

  const data = new TextEncoder().encode(rawBody);

  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signatureBytes,
    data
  );
}

function getDiscount(quantity) {
  if (quantity >= 10) return 20;
  if (quantity >= 5) return 16;
  if (quantity >= 3) return 8;
  return 0;
}

export async function onRequestPost(context) {
  try {
    const request = context.request;
    const env = context.env;

    /*
     * ВАЖЛИВО:
     * тут потрібен ПУБЛІЧНИЙ КЛЮЧ NOVAPAY
     * для перевірки їхнього x-sign.
     *
     * Не публічний ключ із твоєї
     * merchant RSA-пари.
     */
    const NOVAPAY_CALLBACK_PUBLIC_KEY =
      env.NOVAPAY_CALLBACK_PUBLIC_KEY;

    if (!NOVAPAY_CALLBACK_PUBLIC_KEY) {
      throw new Error(
        'NOVAPAY_CALLBACK_PUBLIC_KEY is missing'
      );
    }

    /*
     * Підпис перевіряємо по сирому body.
     * Тому спочатку request.text(),
     * а вже потім JSON.parse().
     */
    const rawBody = await request.text();

    const xSign =
      request.headers.get('x-sign') ||
      request.headers.get('X-Sign') ||
      '';

    const signatureValid =
      await verifySignature(
        rawBody,
        xSign,
        NOVAPAY_CALLBACK_PUBLIC_KEY
      );

    if (!signatureValid) {
      console.error(
        'NovaPay callback: invalid signature'
      );

      return new Response(
        JSON.stringify({
          success: false,
          error: 'Invalid NovaPay signature'
        }),
        {
          status: 401,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    }

    let data;

    try {
      data = JSON.parse(rawBody);
    } catch {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Invalid JSON'
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    }

    console.log(
      'NovaPay callback:',
      JSON.stringify({
        id: data.id,
        status: data.status,
        paytype: data.paytype,
        phone: data.client_phone,
        payments: data.payments
      })
    );

    /*
     * NovaPay може надсилати callback
     * при різних змінах статусу.
     *
     * У CRM передаємо тільки
     * ПОВНІСТЮ ОПЛАЧЕНЕ замовлення.
     */
    if (data.status !== 'paid') {
      return new Response(
        JSON.stringify({
          success: true,
          ignored: true,
          status: data.status
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    }

    const payments =
      Array.isArray(data.payments)
        ? data.payments
        : [];

    if (!payments.length) {
      throw new Error(
        'NovaPay callback has no payments'
      );
    }

    /*
     * У нас одне замовлення SPALSADZ,
     * але NovaPay повертає payments[]
     * як масив.
     */
    const payment = payments[0];

    const products =
      Array.isArray(payment.products)
        ? payment.products
        : [];

    const product =
      products[0] || {};

    const quantity =
      Math.max(
        1,
        Number(product.count || 1)
      );

    /*
     * Наша базова ціна товару.
     * Не беремо product.price як
     * єдине джерело для калькуляції,
     * бо фінальна сума приходить
     * окремо в payment.amount.
     */
    const price = 200;

    const discount =
      getDiscount(quantity);

    const baseTotal =
      quantity * price;

    const saving =
      Math.round(
        baseTotal * discount / 100
      );

    const calculatedTotal =
      baseTotal - saving;

    const paidTotal =
      Number(payment.amount || 0);

    if (
      !Number.isFinite(paidTotal) ||
      paidTotal <= 0
    ) {
      throw new Error(
        'NovaPay callback has invalid payment amount'
      );
    }

    /*
     * Додаткова перевірка:
     * оплачена сума повинна збігатися
     * з нашим серверним розрахунком.
     */
    if (
      Math.abs(paidTotal - calculatedTotal) > 0.01
    ) {
      console.error(
        'NovaPay amount mismatch:',
        JSON.stringify({
          quantity,
          expected: calculatedTotal,
          received: paidTotal
        })
      );

      throw new Error(
        'NovaPay paid amount does not match order total'
      );
    }

    const phone =
      String(data.client_phone || '').trim();

    if (!phone) {
      throw new Error(
        'NovaPay callback has no client_phone'
      );
    }

    /*
     * NovaPay Checkout може отримати ім'я
     * вже на своїй сторінці оформлення.
     */
    const name = [
      data.client_first_name,
      data.client_last_name
    ]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Клієнт NovaPay';

    const externalId =
      String(
        payment.external_id || ''
      ).trim();

    const sessionId =
      String(data.id || '').trim();

    const paytype =
      String(data.paytype || '').trim();

    /*
     * Передаємо оплачений заказ
     * у вже існуючий /api/order.
     */
    const origin =
      new URL(request.url).origin;

    const crmResponse =
      await fetch(
        `${origin}/api/order`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json'
          },

          body: JSON.stringify({
            name,
            phone,

            price: String(price),

            country: 'UA',

            quantity,

            discount,

            baseTotal,

            saving,

            total: paidTotal,

            payment: 'online',

            paid: true,

            paymentStatus: 'paid',

            paymentProvider: 'NovaPay',

            novapaySessionId: sessionId,

            novapayOrderId: externalId,

            novapayPaytype: paytype
          })
        }
      );

    const crmData =
      await crmResponse
        .json()
        .catch(() => ({}));

    console.log(
      'LP-CRM paid order response:',
      JSON.stringify(crmData)
    );

    /*
     * LP-CRM може відповісти "duplicate",
     * якщо NovaPay повторив callback.
     *
     * У такому випадку НЕ треба
     * змушувати NovaPay слати webhook
     * ще 10 разів.
     */
    if (crmData.success !== true) {
      const crmMessage =
        JSON.stringify(
          crmData?.crm_response?.message ||
          crmData?.message ||
          crmData?.error ||
          ''
        );

      const duplicate =
        crmMessage
          .toLowerCase()
          .includes('дубл');

      if (duplicate) {
        console.log(
          'LP-CRM duplicate ignored:',
          externalId
        );

        return new Response(
          JSON.stringify({
            success: true,
            duplicate: true,
            orderId: externalId
          }),
          {
            status: 200,
            headers: {
              'Content-Type':
                'application/json'
            }
          }
        );
      }

      throw new Error(
        crmMessage ||
        'LP-CRM did not accept paid order'
      );
    }

    return new Response(
      JSON.stringify({
        success: true,

        status: 'paid',

        orderId: externalId,

        sessionId,

        amount: paidTotal,

        crm: true
      }),
      {
        status: 200,
        headers: {
          'Content-Type':
            'application/json'
        }
      }
    );

  } catch (error) {
    console.error(
      'NovaPay callback error:',
      error.message
    );

    /*
     * 500 потрібен навмисно:
     * NovaPay повторить callback,
     * якщо з нашого боку була
     * тимчасова помилка.
     */
    return new Response(
      JSON.stringify({
        success: false,
        error: error.message
      }),
      {
        status: 500,
        headers: {
          'Content-Type':
            'application/json'
        }
      }
    );
  }
}
