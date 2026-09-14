function pemToArrayBuffer(pem) {
  const base64 = pem
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
  const keyData = pemToArrayBuffer(privateKeyPem);

  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256'
    },
    false,
    ['sign']
  );

  const encoded = new TextEncoder().encode(body);

  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoded
  );

  const bytes = new Uint8Array(signature);

  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function getDiscount(quantity) {
  if (quantity >= 10) return 20;
  if (quantity >= 5) return 16;
  if (quantity >= 3) return 8;
  return 0;
}

export async function onRequestPost(context) {
  try {
    const env = context.env;

    const MERCHANT_ID =
      String(env.NOVAPAY_MERCHANT_ID || '');

    const PRIVATE_KEY =
      String(env.NOVAPAY_PRIVATE_KEY || '');

    const NOVAPAY_ENV =
      String(env.NOVAPAY_ENV || 'test');

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

    const requestData =
      await context.request.json();

    const sessionId =
      String(
        requestData.session_id ||
        requestData.sessionId ||
        ''
      ).trim();

    if (!sessionId) {
      return json(
        {
          success: false,
          error: 'session_id is required'
        },
        400
      );
    }

    /*
     * Кількість передаємо при перевірці статусу.
     * Для нашого поточного тесту це 1.
     *
     * На frontend потім автоматично передамо
     * фактичну кількість із калькулятора.
     */
    const quantity = Math.max(
      1,
      parseInt(requestData.quantity, 10) || 1
    );

    const API_BASE =
      NOVAPAY_ENV === 'production'
        ? 'https://api-ecom.novapay.ua'
        : 'https://api-qecom.novapay.ua';

    const payload = {
      merchant_id: MERCHANT_ID,
      session_id: sessionId
    };

    const body =
      JSON.stringify(payload);

    const signature =
      await createSignature(
        body,
        PRIVATE_KEY
      );

    console.log(
      'NovaPay status request:',
      JSON.stringify({
        environment: NOVAPAY_ENV,
        merchantId: MERCHANT_ID,
        sessionId,
        quantity
      })
    );

    const response =
      await fetch(
        `${API_BASE}/v1/get-status`,
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

    console.log(
      'NovaPay status response:',
      JSON.stringify(result)
    );

    if (!response.ok) {
      return json(
        {
          success: false,
          environment: NOVAPAY_ENV,
          sessionId,
          novapay_status:
            response.status,
          data: result
        },
        response.status
      );
    }

    // -------------------------
    // FIND PAID OPERATION
    // -------------------------

    const operations =
      Array.isArray(result.operations)
        ? result.operations
        : [];

    const paidOperation =
      operations.find(
        operation =>
          String(
            operation.status || ''
          ).toLowerCase() === 'paid'
      );

    /*
     * Якщо платіж ще не paid —
     * нічого в CRM не створюємо.
     */
    if (!paidOperation) {
      return json(
        {
          success: true,
          paid: false,
          syncedToCrm: false,
          environment: NOVAPAY_ENV,
          sessionId,
          data: result
        },
        200
      );
    }

    // -------------------------
    // PAYMENT DATA
    // -------------------------

    const externalId =
      String(
        paidOperation.external_id || ''
      ).trim();

    const paidAmount =
      Number(
        paidOperation.amount || 0
      );

    if (
      !Number.isFinite(paidAmount) ||
      paidAmount <= 0
    ) {
      throw new Error(
        'NovaPay returned invalid paid amount'
      );
    }

    const phone =
      String(
        result.client_phone || ''
      ).trim();

    const name = [
      result.client_first_name,
      result.client_last_name
    ]
      .filter(Boolean)
      .join(' ')
      .trim() || 'Клієнт NovaPay';

    if (!phone) {
      throw new Error(
        'NovaPay did not return client_phone'
      );
    }

    // -------------------------
    // SERVER-SIDE PRICE CHECK
    // -------------------------

    const BASE_PRICE = 200;

    const discount =
      getDiscount(quantity);

    const baseTotal =
      BASE_PRICE * quantity;

    const saving =
      Math.round(
        baseTotal * discount / 100
      );

    const expectedTotal =
      baseTotal - saving;

    /*
     * Не дозволяємо створити CRM-замовлення,
     * якщо оплачена сума не відповідає
     * нашій серверній ціні.
     */
    if (
      Math.abs(
        paidAmount - expectedTotal
      ) > 0.01
    ) {
      console.error(
        'NovaPay paid amount mismatch:',
        JSON.stringify({
          sessionId,
          externalId,
          quantity,
          expectedTotal,
          paidAmount
        })
      );

      return json(
        {
          success: false,
          error:
            'Paid amount does not match order total',
          expectedTotal,
          paidAmount
        },
        409
      );
    }

    console.log(
      'NovaPay payment confirmed:',
      JSON.stringify({
        sessionId,
        externalId,
        name,
        phone,
        quantity,
        discount,
        paidAmount
      })
    );

    // -------------------------
    // SEND PAID ORDER TO LP-CRM
    // -------------------------

    const origin =
      new URL(
        context.request.url
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

          body: JSON.stringify({
            name,
            phone,

            quantity,

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
              String(
                result.paytype ||
                result.payment_type ||
                paidOperation.payment_type ||
                ''
              )
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

    if (
      !crmResponse.ok ||
      crmData.success !== true
    ) {
      throw new Error(
        crmData?.error ||
        crmData?.crm_response?.message ||
        'LP-CRM did not accept paid order'
      );
    }

    // -------------------------
    // SUCCESS
    // -------------------------

    return json(
      {
        success: true,

        paid: true,

        syncedToCrm: true,

        environment:
          NOVAPAY_ENV,

        sessionId,

        orderId:
          externalId,

        amount:
          paidAmount,

        quantity,

        crm:
          crmData
      },
      200
    );

  } catch (error) {

    console.error(
      'NovaPay status error:',
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
