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

async function novapayRequest(url, data, privateKey) {
  // ВАЖЛИВО: підписуємо саме той JSON-рядок,
  // який потім відправляємо в body.
  const body = JSON.stringify(data);

  const signature = await createSignature(
    body,
    privateKey
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'x-sign': signature
    },
    body
  });

  const responseText = await response.text();

  let result;

  try {
    result = JSON.parse(responseText);
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
  let value = String(phone || '')
    .replace(/[^\d+]/g, '');

  if (value.startsWith('0')) {
    value = '+38' + value;
  }

  if (value.startsWith('380')) {
    value = '+' + value;
  }

  return value;
}

export async function onRequestPost(context) {
  try {
    const env = context.env;

    const MERCHANT_ID =
      env.NOVAPAY_MERCHANT_ID;

    const PRIVATE_KEY =
      env.NOVAPAY_PRIVATE_KEY;

    const NOVAPAY_ENV =
      env.NOVAPAY_ENV || 'test';

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

    const API_BASE =
      NOVAPAY_ENV === 'production'
        ? 'https://api-ecom.novapay.ua'
        : 'https://api-qecom.novapay.ua';

    const requestData =
      await context.request.json();

    const phone =
      normalizePhone(requestData.phone);

    if (!phone) {
      return new Response(
        JSON.stringify({
          success: false,
          error: 'Phone is required'
        }),
        {
          status: 400,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );
    }

    /*
     * ПЕРШИЙ ТЕСТ:
     * передаємо amount із запиту,
     * але якщо його немає — 1 грн.
     *
     * Після успішного тесту ми
     * перенесемо розрахунок ціни
     * на сервер і не будемо довіряти
     * сумі з браузера.
     */
    const amount =
      Number(requestData.amount || 1);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      throw new Error('Invalid amount');
    }

    const origin =
      new URL(context.request.url).origin;

    const orderId =
      `SPALSADZ-${Date.now()}`;

    // -------------------------
    // 1. CREATE CHECKOUT SESSION
    // -------------------------

    const sessionData = {
      merchant_id: String(MERCHANT_ID),

      client_phone: phone,

      callback_url:
        `${origin}/api/novapay/callback`,

      success_url:
        `${origin}/?payment=success`,

      fail_url:
        `${origin}/?payment=fail`,

      create_express_waybill: false
    };

    console.log(
      'NovaPay create session:',
      JSON.stringify({
        environment: NOVAPAY_ENV,
        merchantId: String(MERCHANT_ID),
        phone,
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
      return new Response(
        JSON.stringify({
          success: false,
          stage: 'session',
          error:
            'NovaPay did not return session_id',
          novapay: session
        }),
        {
          status: 502,
          headers: {
            'Content-Type':
              'application/json'
          }
        }
      );
    }

    // -------------------------
    // 2. ADD CHECKOUT PAYMENT
    // -------------------------

    const paymentData = {
      merchant_id: String(MERCHANT_ID),

      session_id: String(sessionId),

      external_id: orderId,

      amount: amount,

      use_hold: false
    };

    console.log(
      'NovaPay payment request:',
      JSON.stringify({
        merchantId: String(MERCHANT_ID),
        sessionId,
        externalId: orderId,
        amount
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

    /*
     * Поки повертаємо всю відповідь,
     * щоб точно побачити,
     * як NovaPay називає payment URL
     * у твоєму акаунті/API.
     */

    return new Response(
      JSON.stringify({
        success: true,
        environment: NOVAPAY_ENV,
        orderId,
        sessionId,
        session,
        payment
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
      'NovaPay error:',
      error.message
    );

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
