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
        sessionId
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

    return json(
      {
        success: response.ok,
        environment: NOVAPAY_ENV,
        sessionId,
        novapay_status:
          response.status,
        data: result
      },
      response.ok
        ? 200
        : response.status
    );

  } catch (error) {

    console.error(
      'NovaPay status error:',
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
