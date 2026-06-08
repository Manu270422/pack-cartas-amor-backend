/*
  Mi servidor backend — Pack de Cartas de Amor Premium v4.0
  Integra: Mercado Pago + Wompi + Bold + Supabase + Resend

  Flujo de acceso:
    1. Cliente paga
    2. Pasarela notifica al webhook
    3. Backend genera token único → guarda en Supabase → envía email al cliente
    4. Cliente abre el link del email → personalizar.html?token=XXX
    5. personalizar.html consulta /api/verificar-token → backend verifica en Supabase
    6. Si el token es válido → acceso concedido. Si no → redirige al index.
*/

require('dotenv').config();

const express              = require('express');
const cors                 = require('cors');
const crypto               = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { createClient }     = require('@supabase/supabase-js');
const { Resend }           = require('resend');

// ══════════════════════════════════════════════════════════════
// VALIDACIÓN DE VARIABLES AL ARRANCAR
// ══════════════════════════════════════════════════════════════
const VARIABLES_REQUERIDAS = [
  'MP_ACCESS_TOKEN', 'MP_PUBLIC_KEY',
  'WOMPI_PUBLIC_KEY', 'WOMPI_PRIVATE_KEY', 'WOMPI_INTEGRITY_KEY', 'WOMPI_EVENTS_KEY',
  'BOLD_IDENTITY_KEY', 'BOLD_SECRET_KEY',
  'SUPABASE_URL', 'SUPABASE_SERVICE_KEY',
  'RESEND_API_KEY', 'RESEND_FROM_EMAIL',
  'FRONTEND_URL',
];

const FALTANTES = VARIABLES_REQUERIDAS.filter(v => !process.env[v]);
if (FALTANTES.length > 0) {
  console.error('❌ Me faltan estas variables de entorno:');
  FALTANTES.forEach(v => console.error(`   → ${v}`));
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════
// MIS CLIENTES DE SERVICIOS EXTERNOS
// ══════════════════════════════════════════════════════════════

// Mercado Pago
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 },
});

// Supabase — uso la service_role key porque el backend necesita acceso total
// NUNCA expongo esta key en el frontend
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// Resend — para enviar emails de acceso
const resend = new Resend(process.env.RESEND_API_KEY);

// ══════════════════════════════════════════════════════════════
// CONSTANTES DEL PRODUCTO
// ══════════════════════════════════════════════════════════════
const WOMPI_PUBLIC_KEY    = process.env.WOMPI_PUBLIC_KEY;
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY;
const WOMPI_EVENTS_KEY    = process.env.WOMPI_EVENTS_KEY;
const BOLD_IDENTITY_KEY   = process.env.BOLD_IDENTITY_KEY;
const BOLD_SECRET_KEY     = process.env.BOLD_SECRET_KEY;
const PRECIO_PESOS        = 1000;
const PRECIO_CENTAVOS     = 100000;
const MONEDA              = 'COP';

// ══════════════════════════════════════════════════════════════
// EXPRESS Y CORS
// ══════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 3000;
const MI_FRONTEND_URL = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');

const ORIGENES_PERMITIDOS = [
  'https://pack-cartas-amor.netlify.app',
  MI_FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'null',
].filter(Boolean);

console.log('🌐 Orígenes CORS permitidos:');
ORIGENES_PERMITIDOS.forEach(o => console.log(`   ✓ ${o}`));

app.use(cors({
  origin: (origen, cb) => {
    console.log(`📡 CORS desde: "${origen}"`);
    if (!origen || ORIGENES_PERMITIDOS.includes(origen)) return cb(null, true);
    console.warn(`🚫 Bloqueado: "${origen}"`);
    cb(new Error(`Origen no permitido: ${origen}`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// ══════════════════════════════════════════════════════════════
// MI FUNCIÓN CENTRAL — Registrar compra y enviar acceso
// La llaman todos mis webhooks cuando confirman un pago
// ══════════════════════════════════════════════════════════════
async function procesarPagoAprobado({ email, nombre, pasarela, referenciaPago }) {
  try {
    // Verifico si este cliente ya compró antes (mismo email)
    // Si ya tiene un token válido, le reenvío el mismo para no duplicar
    const { data: compraExistente } = await supabase
      .from('compras')
      .select('token, email')
      .eq('email', email.toLowerCase().trim())
      .eq('estado', 'aprobado')
      .single();

    let token;

    if (compraExistente) {
      // Ya compró antes — uso su token existente
      token = compraExistente.token;
      console.log(`♻️  Cliente ya tiene acceso: ${email} | Token: ${token.slice(0,8)}...`);
    } else {
      // Nueva compra — genero token único y guardo en Supabase
      token = crypto.randomBytes(32).toString('hex'); // 64 caracteres hexadecimales

      const { error } = await supabase.from('compras').insert({
        email:          email.toLowerCase().trim(),
        nombre:         nombre || '',
        token,
        pasarela,
        referencia_pago: referenciaPago,
        estado:         'aprobado',
      });

      if (error) throw new Error(`Supabase error: ${error.message}`);
      console.log(`✅ Compra registrada: ${email} | Pasarela: ${pasarela} | Token: ${token.slice(0,8)}...`);
    }

    // Envío el email de acceso al cliente
    await enviarEmailAcceso({ email, nombre, token });

    return { ok: true, token };

  } catch (error) {
    console.error('❌ Error procesando pago:', error.message);
    return { ok: false, error: error.message };
  }
}

// ══════════════════════════════════════════════════════════════
// MI FUNCIÓN DE EMAIL — El email que recibe el cliente
// ══════════════════════════════════════════════════════════════
async function enviarEmailAcceso({ email, nombre, token }) {
  const urlAcceso = `${MI_FRONTEND_URL}/personalizar.html?token=${token}`;
  const nombreMostrar = nombre || 'amigo/a';

  const { error } = await resend.emails.send({
    from:    process.env.RESEND_FROM_EMAIL, // Ej: hola@elmundomanu.com
    to:      email,
    subject: '💌 Tu Pack de Cartas de Amor Premium está listo',
    html: `
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tu Pack de Cartas de Amor Premium</title>
</head>
<body style="margin:0;padding:0;background:#FAF7F2;font-family:'Georgia',serif;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="580" cellpadding="0" cellspacing="0" style="background:#FFFFFF;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

          <!-- Cabecera dorada -->
          <tr>
            <td style="background:linear-gradient(135deg,#B8862A,#E8C97D,#B8862A);padding:32px 40px;text-align:center;">
              <p style="margin:0;color:rgba(255,255,255,0.8);font-size:12px;letter-spacing:0.2em;text-transform:uppercase;font-family:Arial,sans-serif;">El Mundo de Manu</p>
              <h1 style="margin:8px 0 0;color:#FFFFFF;font-size:28px;font-weight:normal;font-style:italic;">Pack de Cartas de Amor Premium</h1>
            </td>
          </tr>

          <!-- Cuerpo -->
          <tr>
            <td style="padding:40px;">

              <p style="margin:0 0 16px;font-size:18px;color:#1C1A17;">
                Hola, <strong>${nombreMostrar}</strong> 👋
              </p>

              <p style="margin:0 0 16px;font-size:16px;color:#6B6560;line-height:1.7;">
                ¡Tu pago fue confirmado exitosamente! Tu Pack de Cartas de Amor Premium está listo y esperándote.
              </p>

              <p style="margin:0 0 32px;font-size:16px;color:#6B6560;line-height:1.7;">
                Tienes acceso permanente a las <strong style="color:#1C1A17;">6 cartas premium</strong> y al personalizador interactivo. Puedes volver cuando quieras usando el botón de abajo.
              </p>

              <!-- Botón de acceso -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center" style="padding:8px 0 32px;">
                    <a href="${urlAcceso}"
                       style="display:inline-block;background:#B8862A;color:#FFFFFF;text-decoration:none;font-size:16px;font-weight:bold;padding:16px 40px;border-radius:50px;font-family:Arial,sans-serif;letter-spacing:0.03em;">
                      ✨ Abrir mi personalizador de cartas
                    </a>
                  </td>
                </tr>
              </table>

              <!-- Qué incluye -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#FAF7F2;border-radius:12px;margin-bottom:32px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 12px;font-size:12px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:#B8862A;font-family:Arial,sans-serif;">Tu pack incluye</p>
                    <table width="100%" cellpadding="4" cellspacing="0">
                      <tr><td style="font-size:14px;color:#1C1A17;">💌</td><td style="font-size:14px;color:#6B6560;">Carta Romántica — para enamorar en el día a día</td></tr>
                      <tr><td style="font-size:14px;color:#1C1A17;">🔥</td><td style="font-size:14px;color:#6B6560;">Carta Intensa — pasional y profunda</td></tr>
                      <tr><td style="font-size:14px;color:#1C1A17;">🌧️</td><td style="font-size:14px;color:#6B6560;">Carta Nostálgica — amor a distancia</td></tr>
                      <tr><td style="font-size:14px;color:#1C1A17;">🕊️</td><td style="font-size:14px;color:#6B6560;">Carta de Reconciliación — pedir perdón de verdad</td></tr>
                      <tr><td style="font-size:14px;color:#1C1A17;">🥂</td><td style="font-size:14px;color:#6B6560;">Carta de Aniversario — celebrar lo construido</td></tr>
                      <tr><td style="font-size:14px;color:#1C1A17;">🎂</td><td style="font-size:14px;color:#6B6560;">Carta de Cumpleaños — celebrar su vida</td></tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Instrucciones -->
              <p style="margin:0 0 8px;font-size:14px;font-weight:bold;color:#1C1A17;font-family:Arial,sans-serif;">¿Cómo uso mi pack?</p>
              <ol style="margin:0 0 32px;padding-left:20px;font-size:14px;color:#6B6560;line-height:2;">
                <li>Haz clic en el botón de arriba</li>
                <li>Elige la carta que necesitas</li>
                <li>Escribe con tus palabras y personaliza</li>
                <li>Cópiala, descárgala o compártela directo</li>
              </ol>

              <!-- Link de acceso visible -->
              <div style="background:#FAF7F2;border:1px solid #E8E0D5;border-radius:8px;padding:16px;margin-bottom:32px;">
                <p style="margin:0 0 6px;font-size:11px;font-weight:bold;letter-spacing:0.1em;text-transform:uppercase;color:#B8862A;font-family:Arial,sans-serif;">Tu link de acceso permanente</p>
                <p style="margin:0;font-size:12px;color:#6B6560;word-break:break-all;font-family:monospace;">${urlAcceso}</p>
                <p style="margin:6px 0 0;font-size:11px;color:#B0A89E;font-family:Arial,sans-serif;">💡 Guarda este email — es tu acceso de por vida desde cualquier dispositivo</p>
              </div>

              <p style="margin:0;font-size:13px;color:#B0A89E;line-height:1.7;font-family:Arial,sans-serif;">
                ¿Tienes alguna pregunta? Responde este email y te ayudo con gusto.<br>
                Con cariño, <strong style="color:#B8862A;">El Mundo de Manu</strong>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#1C1A17;padding:20px 40px;text-align:center;">
              <p style="margin:0;font-size:11px;color:#6B6560;font-family:Arial,sans-serif;letter-spacing:0.05em;">
                © 2025 El Mundo de Manu · Carlos Manuel Turizo Hernández<br>
                Este email confirma tu compra del Pack de Cartas de Amor Premium
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>
    `,
  });

  if (error) {
    console.error('❌ Error enviando email:', error);
    throw new Error(`Resend error: ${error.message}`);
  }

  console.log(`📧 Email de acceso enviado a: ${email}`);
}

// ══════════════════════════════════════════════════════════════
// RUTAS
// ══════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({
  estado: 'activo',
  servicio: 'Backend — Pack de Cartas de Amor Premium',
  version: '4.0.0',
  pasarelas: ['mercadopago', 'wompi', 'bold'],
}));


// ── Verificar token de acceso ──
// El personalizar.html llama aquí para saber si el token es válido
app.get('/api/verificar-token', async (req, res) => {
  const { token } = req.query;

  if (!token || token.length < 10) {
    return res.status(400).json({ ok: false, razon: 'sin_token' });
  }

  try {
    const { data, error } = await supabase
      .from('compras')
      .select('id, email, nombre, estado, accesos')
      .eq('token', token)
      .eq('estado', 'aprobado')
      .single();

    if (error || !data) {
      return res.status(401).json({ ok: false, razon: 'token_invalido' });
    }

    // Actualizo el contador de accesos y la fecha de último acceso
    await supabase.from('compras').update({
      accesos:       (data.accesos || 0) + 1,
      ultimo_acceso: new Date().toISOString(),
      updated_at:    new Date().toISOString(),
    }).eq('token', token);

    console.log(`🔓 Acceso verificado: ${data.email} | Acceso #${(data.accesos || 0) + 1}`);

    return res.json({
      ok:     true,
      nombre: data.nombre || '',
    });

  } catch (error) {
    console.error('❌ Error verificando token:', error.message);
    return res.status(500).json({ ok: false, razon: 'error_servidor' });
  }
});


// ── MERCADO PAGO — Crear preferencia ──
app.post('/api/crear-preferencia', async (req, res) => {
  // Requiero el email del cliente para poder enviarle el acceso después del pago
  const { email, nombre } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ ok: false, mensaje: 'Necesito tu email para enviarte el acceso.' });
  }

  try {
    const preference = new Preference(mpClient);
    const resultado  = await preference.create({
      body: {
        items: [{
          title:       'Pack de Cartas de Amor Premium — El Mundo de Manu',
          quantity:    1,
          currency_id: MONEDA,
          unit_price:  PRECIO_PESOS,
        }],
        payer: { email, name: nombre || '' },
        back_urls: {
          success: `${MI_FRONTEND_URL}/success.html`,
          failure: `${MI_FRONTEND_URL}/error.html?razon=pago_fallido`,
          pending: `${MI_FRONTEND_URL}/error.html?razon=pago_pendiente`,
        },
        auto_return:        'approved',
        external_reference: `CARTAS-MP-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,
        expires:            true,
        expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        // Guardo el email en metadata para usarlo en el webhook
        metadata: { email, nombre: nombre || '' },
      }
    });

    console.log(`✅ MP Preferencia creada: ${resultado.id} | Cliente: ${email}`);
    res.json({ ok: true, init_point: resultado.init_point, preference_id: resultado.id });

  } catch (error) {
    console.error('❌ Error MP:', error?.message);
    res.status(500).json({ ok: false, mensaje: 'No se pudo crear el pago. Intenta de nuevo.' });
  }
});

// ── Webhook Mercado Pago ──
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return res.sendStatus(200);

    const pago    = new Payment(mpClient);
    const detalle = await pago.get({ id: data.id });

    console.log(`📦 Webhook MP | ID: ${detalle.id} | Estado: ${detalle.status}`);

    if (detalle.status === 'approved') {
      const email  = detalle.payer?.email || detalle.metadata?.email;
      const nombre = detalle.payer?.first_name || detalle.metadata?.nombre || '';

      if (email) {
        await procesarPagoAprobado({
          email,
          nombre,
          pasarela:       'mercadopago',
          referenciaPago: detalle.external_reference || String(detalle.id),
        });
      } else {
        console.warn('⚠️ Pago MP aprobado pero sin email del cliente');
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook MP error:', error?.message);
    res.sendStatus(500);
  }
});


// ── WOMPI — Firma de integridad ──
app.post('/api/wompi-firma', (req, res) => {
  try {
    const referencia  = `CARTAS-W-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    const cadena      = `${referencia}${PRECIO_CENTAVOS}${MONEDA}${WOMPI_INTEGRITY_KEY}`;
    const firma       = crypto.createHash('sha256').update(cadena).digest('hex');

    console.log(`🔐 Wompi firma | Ref: ${referencia}`);

    res.json({
      ok: true, referencia, firma,
      monto_centavos: PRECIO_CENTAVOS,
      moneda:         MONEDA,
      llave_publica:  WOMPI_PUBLIC_KEY,
      redirect_url:   `${MI_FRONTEND_URL}/success.html`,
    });
  } catch (error) {
    console.error('❌ Error firma Wompi:', error?.message);
    res.status(500).json({ ok: false, mensaje: 'No se pudo iniciar el pago con Wompi.' });
  }
});

// ── Webhook Wompi ──
app.post('/webhook/wompi', async (req, res) => {
  try {
    const { data, timestamp, signature } = req.body;
    const tx = data?.transaction;

    // Verifico autenticidad del webhook
    const propiedades   = tx ? Object.values(tx).join('') : '';
    const cadenaVerif   = `${propiedades}${timestamp}${WOMPI_EVENTS_KEY}`;
    const firmaEsperada = crypto.createHash('sha256').update(cadenaVerif).digest('hex');

    if (signature?.checksum !== firmaEsperada) {
      console.warn('⚠️ Webhook Wompi con firma inválida');
      return res.sendStatus(401);
    }

    console.log(`📦 Webhook Wompi | ID: ${tx?.id} | Estado: ${tx?.status}`);

    if (tx?.status === 'APPROVED') {
      const email  = tx.customer_email || tx.customer_data?.email;
      const nombre = tx.customer_data?.full_name || '';

      if (email) {
        await procesarPagoAprobado({
          email, nombre,
          pasarela:       'wompi',
          referenciaPago: tx.reference,
        });
      } else {
        console.warn('⚠️ Pago Wompi aprobado pero sin email');
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook Wompi error:', error?.message);
    res.sendStatus(500);
  }
});


// ── BOLD — Firma de integridad ──
app.post('/api/bold-firma', (req, res) => {
  try {
    const orderId = `CARTAS-B-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    const cadena  = `${orderId}${PRECIO_PESOS}${MONEDA}${BOLD_SECRET_KEY}`;
    const firma   = crypto.createHash('sha256').update(cadena).digest('hex');

    console.log(`🔐 Bold firma | Order: ${orderId}`);

    res.json({
      ok: true, orderId, firma,
      monto:        PRECIO_PESOS,
      moneda:       MONEDA,
      identity_key: BOLD_IDENTITY_KEY,
      redirect_url: `${MI_FRONTEND_URL}/success.html`,
    });
  } catch (error) {
    console.error('❌ Error firma Bold:', error?.message);
    res.status(500).json({ ok: false, mensaje: 'No se pudo iniciar el pago con Bold.' });
  }
});

// ── Webhook Bold ──
// Según la documentación oficial de Bold, la verificación del webhook usa:
// 1. Convertir el cuerpo recibido a Base64
// 2. Cifrar ese Base64 con HMAC-SHA256 usando la llave secreta
// 3. Comparar con el header X-BoldSignature
app.post('/webhook/bold', async (req, res) => {
  try {
    // Leo el header de firma que Bold envía
    const boldSignature = req.headers['x-boldsignature'] || req.headers['X-BoldSignature'];
    const { order_id, status, amount, currency, metadata } = req.body;

    // Verifico autenticidad con HMAC-SHA256 según doc oficial Bold
    if (boldSignature) {
      const cuerpoBase64  = Buffer.from(JSON.stringify(req.body)).toString('base64');
      const firmaEsperada = crypto
        .createHmac('sha256', BOLD_SECRET_KEY)
        .update(cuerpoBase64)
        .digest('hex');

      if (boldSignature !== firmaEsperada) {
        console.warn('⚠️ Webhook Bold con firma inválida');
        return res.sendStatus(401);
      }
    }

    console.log(`📦 Webhook Bold | Order: ${order_id} | Estado: ${status}`);

    if (status === 'APPROVED') {
      const email  = metadata?.email || req.body.customer_email;
      const nombre = metadata?.nombre || req.body.customer_name || '';

      if (email) {
        await procesarPagoAprobado({
          email, nombre,
          pasarela:       'bold',
          referenciaPago: order_id,
        });
      } else {
        console.warn('⚠️ Pago Bold aprobado pero sin email');
      }
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook Bold error:', error?.message);
    res.sendStatus(500);
  }
});


// ══════════════════════════════════════════════════════════════
// ARRANQUE
// ══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ════════════════════════════════════════════');
  console.log(`   Backend activo en http://localhost:${PORT}`);
  console.log(`   FRONTEND_URL: "${MI_FRONTEND_URL}"`);
  console.log(`   Modo MP:    ${process.env.MP_ACCESS_TOKEN?.includes('TEST') ? '🧪 PRUEBAS' : '💰 PRODUCCIÓN'}`);
  console.log(`   Modo Wompi: ${WOMPI_PUBLIC_KEY?.includes('prod') ? '💰 PRODUCCIÓN' : '🧪 PRUEBAS'}`);
  console.log(`   Modo Bold:  ${BOLD_IDENTITY_KEY?.length >= 20 ? '💰 PRODUCCIÓN' : '🧪 PRUEBAS'}`);
  console.log(`   Supabase:   ✅ ${process.env.SUPABASE_URL}`);
  console.log(`   Email:      ✅ ${process.env.RESEND_FROM_EMAIL}`);
  console.log('   ════════════════════════════════════════════');
  console.log('');
});