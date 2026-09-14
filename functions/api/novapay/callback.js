function publicPemToArrayBuffer(pem) {
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

async function verifySignature(
  rawBody,
  signatureBase64,
  publicKeyPem
) {
  if (!signatureBase64 || !publicKeyPem) {
    return false;
  }

  const keyData =
    publicPemToArrayBuffer(publicKeyPem);

  const publicKey =
    await crypto.subtle.importKey(
      'spki',
      keyData,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256'
      },
      false,
      ['verify']
    );

  let signatureBinary;

  try {
    signatureBinary =
      atob(
        String(signatureBase64)
          .replace(/\s+/g, '')
      );
  } catch {
    return false;
  }

  const signatureBytes =
    new Uint8Array(
      signatureBinary.length
    );

  for (
    let i = 0;
    i < signatureBinary.length;
    i++
  ) {
    signatureBytes[i] =
      signatureBinary.charCodeAt(i);
  }

  const data =
    new TextEncoder().encode(rawBody);

  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signatureBytes,
    data
  );
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
    const request =
      context.request;

    const env =
      context.env;

    // -------------------------
    // NOVAPAY PUBLIC KEY
    // -------------------------

    /*
     * Це саме public key NovaPay
     * для перевірки callback x-sign.
     *
     * Preview -> test key NovaPay
     * Production -> production key NovaPay
     */
    const CALLBACK_PUBLIC_KEY =
      String(
        env.NOVAPAY_CALLBACK_PUBLIC_KEY || ''
      ).trim();

    if (!CALLBACK_PUBLIC_KEY) {
      throw new Error(
        'NOVAPAY_CALLBACK_PUBLIC_KEY is missing'
      );
    }

    // -------------------------
    // RAW BODY + SIGNATURE
    // -------------------------

    /*
     * Підпис перевіряється по
     * оригінальному body.
     *
     * Тому JSON.parse робимо
     * тільки після verifySignature().
     */
    const rawBody =
      await request.text();

    const xSign =
      request.headers.get('x-sign') ||
      '';

    const signatureValid =
      await verifySignature(
        rawBody,
        xSign,
        CALLBACK_PUBLIC_KEY
      );

    if (!signatureValid) {
      console.error(
        'NovaPay callback: invalid signature'
      );

      return json(
        {
          success: false,
          error:
            'Invalid NovaPay signature'
        },
        401
      );
    }

    // -------------------------
    // PARSE JSON
    // -------------------------

    let data;

    try {
      data =
        JSON.parse(rawBody);
    } catch {
      return json(
        {
          success: false,
          error: 'Invalid JSON'
        },
        400
      );
    }

    const status =
      String(
        data.status || ''
      )
        .trim()
        .toLowerCase();

    console.log(
      'NovaPay callback:',
      JSON.stringify({
        id:
          data.id || '',

        status,

        paytype:
          data.paytype || '',

        phone:
          data.client_phone || '',

        payments:
          data.payments || []
      })
    );

    // -------------------------
    // ONLY PAID
    // -------------------------

    /*
     * NovaPay може надсилати
     * callback кілька разів при
     * зміні статусу.
     *
     * До CRM відправляємо тільки paid.
     */
    if (status !== 'paid') {
      return json(
        {
          success: true,
          ignored: true,
          status
        },
        200
      );
    }

    // -------------------------
    // PAYMENT
    // -------------------------

    const payments =
      Array.isArray(data.payments)
        ? data.payments
        : [];

    if (!payments.length) {
      throw new Error(
        'NovaPay callback has no payments'
      );
    }

    const payment =
      payments[0];

    const externalId =
      String(
        payment.external_id || ''
      ).trim();

    if (!externalId) {
      throw new Error(
        'NovaPay callback has no external_id'
      );
    }

    const products =
      Array.isArray(payment.products)
        ? payment.products
        : [];

    const product =
      products[0] || {};

    // -------------------------
    // QUANTITY
    // -------------------------

    const parsedQuantity =
      Math.floor(
        Number(
          product.count || 1
        )
      );

    const quantity =
      Number.isFinite(parsedQuantity) &&
      parsedQuantity > 0
        ? parsedQuantity
        : 1;

    // -------------------------
    // SERVER PRICE CHECK
    // -------------------------

    /*
     * Базова ціна — наша серверна.
     * product.price після знижки
     * не використовуємо як джерело
     * правил ціноутворення.
     */
    const BASE_PRICE =
      200;

    const discount =
      getDiscount(quantity);

    const baseTotal =
      BASE_PRICE * quantity;

    const saving =
      Math.round(
        baseTotal *
        discount /
        100
      );

    const expectedTotal =
      baseTotal - saving;

    const paidTotal =
      Number(
        payment.amount || 0
      );

    if (
      !Number.isFinite(paidTotal) ||
      paidTotal <= 0
    ) {
      throw new Error(
        'NovaPay callback has invalid payment amount'
      );
    }

    /*
     * У CRM відправляємо тільки
     * замовлення, де фактично сплачена
     * сума збігається з нашою ціною.
     */
    if (
      Math.abs(
        paidTotal -
        expectedTotal
      ) > 0.01
    ) {
      console.error(
        'NovaPay amount mismatch:',
        JSON.stringify({
          externalId,
          quantity,
          expected:
            expectedTotal,
          received:
            paidTotal
        })
      );

      return json(
        {
          success: false,
          error:
            'NovaPay paid amount does not match order total',

          expectedTotal,

          paidTotal
        },
        409
      );
    }

    // -------------------------
    // CUSTOMER
    // -------------------------

    const phone =
      String(
        data.client_phone || ''
      ).trim();

    if (!phone) {
      throw new Error(
        'NovaPay callback has no client_phone'
      );
    }

    const name =
      [
        data.client_first_name,
        data.client_last_name
      ]
        .filter(Boolean)
        .join(' ')
        .trim() ||
      'Клієнт NovaPay';

    const sessionId =
      String(
        data.id || ''
      ).trim();

    const paytype =
      String(
        data.paytype || ''
      ).trim();

    console.log(
      'NovaPay payment confirmed:',
      JSON.stringify({
        externalId,
        sessionId,
        name,
        phone,
        quantity,
        discount,
        expectedTotal,
        paidTotal
      })
    );

    // -------------------------
    // LP-CRM
    // -------------------------

    const origin =
      new URL(
        request.url
      ).origin;

    const crmResponse =
      await fetch(
        `${origin}/api/order`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json'
          },

          body:
            JSON.stringify({
              name,

              phone,

              quantity,

              /*
               * Передаємо external_id
               * NovaPay як наш стабільний
               * ID онлайн-замовлення.
               */
              orderId:
                externalId,

              payment:
                'online',

              paid:
                true,

              paymentStatus:
                'paid',

              paymentProvider:
                'NovaPay',

              novapaySessionId:
                sessionId,

              novapayOrderId:
                externalId,

              novapayPaytype:
                paytype
            })
        }
      );

    const crmResponseText =
      await crmResponse.text();

    let crmData;

    try {
      crmData =
        JSON.parse(
          crmResponseText
        );
    } catch {
      crmData = {
        raw:
          crmResponseText
      };
    }

    console.log(
      'LP-CRM paid order response:',
      JSON.stringify(crmData)
    );

    // -------------------------
    // CRM SUCCESS / DUPLICATE
    // -------------------------

    if (
      !crmResponse.ok ||
      crmData.success !== true
    ) {
      const crmMessage =
        JSON.stringify(
          crmData?.crm_response?.message ||
          crmData?.message ||
          crmData?.error ||
          ''
        );

      /*
       * Callback може повторитися.
       * Дубль уже створеного paid-order
       * не вважаємо серверною помилкою.
       */
      const duplicate =
        crmMessage
          .toLowerCase()
          .includes('дубл');

      if (duplicate) {
        console.log(
          'LP-CRM duplicate ignored:',
          externalId
        );

        return json(
          {
            success: true,
            duplicate: true,
            status: 'paid',
            orderId:
              externalId,
            sessionId,
            amount:
              paidTotal
          },
          200
        );
      }

      throw new Error(
        crmMessage ||
        'LP-CRM did not accept paid order'
      );
    }

    // -------------------------
    // SUCCESS
    // -------------------------

    return json(
      {
        success: true,

        status:
          'paid',

        orderId:
          externalId,

        sessionId,

        amount:
          paidTotal,

        crm:
          true
      },
      200
    );

  } catch (error) {

    console.error(
      'NovaPay callback error:',
      error?.stack ||
      error?.message ||
      String(error)
    );

    /*
     * 500 залишаємо навмисно:
     * якщо виникла тимчасова
     * серверна помилка, callback
     * не позначається успішним.
     */
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
