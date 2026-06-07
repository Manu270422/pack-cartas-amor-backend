/*
  Mi servidor backend — Pack de Cartas de Amor Premium.
  Integra: Mercado Pago + Wompi + Bold

  Para correr localmente:  npm run dev
  Para producción Render:  npm start
*/

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

// ══════════════════════════════════════════════════════════════
// VALIDACIÓN DE VARIABLES AL ARRANCAR
// ══════════════════════════════════════════════════════════════
const VARIABLES_REQUERIDAS = [
  'MP_ACCESS_TOKEN',
  'MP_PUBLIC_KEY',
  'WOMPI_PUBLIC_KEY',
  'WOMPI_PRIVATE_KEY',
  'WOMPI_INTEGRITY_KEY',
  'WOMPI_EVENTS_KEY',
  'BOLD_IDENTITY_KEY',
  'BOLD_SECRET_KEY',
  'FRONTEND_URL',
];

const VARIABLES_FALTANTES = VARIABLES_REQUERIDAS.filter(v => !process.env[v]);
if (VARIABLES_FALTANTES.length > 0) {
  console.error('❌ ERROR: Me faltan estas variables de entorno:');
  VARIABLES_FALTANTES.forEach(v => console.error(`   → ${v}`));
  console.error('📄 Agrégalas en Render → Environment.');
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════
// MERCADO PAGO
// ══════════════════════════════════════════════════════════════
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 },
});

// ══════════════════════════════════════════════════════════════
// WOMPI
// ══════════════════════════════════════════════════════════════
const WOMPI_PUBLIC_KEY    = process.env.WOMPI_PUBLIC_KEY;
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY;
const WOMPI_EVENTS_KEY    = process.env.WOMPI_EVENTS_KEY;

// ══════════════════════════════════════════════════════════════
// BOLD
// Bold usa su llave de identidad en el frontend para mostrar el botón,
// y la llave secreta en el backend para generar la firma SHA-256
// que protege cada transacción de manipulaciones.
// ══════════════════════════════════════════════════════════════
const BOLD_IDENTITY_KEY = process.env.BOLD_IDENTITY_KEY;
const BOLD_SECRET_KEY   = process.env.BOLD_SECRET_KEY;

// ══════════════════════════════════════════════════════════════
// PRECIO DEL PRODUCTO
// Lo centralizo aquí — un solo lugar para cambiarlo
// ══════════════════════════════════════════════════════════════
const PRECIO_PESOS    = 15000;         // Para Mercado Pago (pesos)
const PRECIO_CENTAVOS = 1500000;       // Para Wompi (centavos)
const MONEDA          = 'COP';

// ══════════════════════════════════════════════════════════════
// EXPRESS Y CORS
// ══════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 3000;

const MI_FRONTEND_URL = (process.env.FRONTEND_URL || '').trim().replace(/\/$/, '');

const MIS_ORIGENES_PERMITIDOS = [
  'https://pack-cartas-amor.netlify.app',
  MI_FRONTEND_URL,
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:3000',
  'null',
].filter(Boolean);

console.log('🌐 Orígenes CORS permitidos:');
MIS_ORIGENES_PERMITIDOS.forEach(o => console.log(`   ✓ ${o}`));

app.use(cors({
  origin: function (origen, callback) {
    console.log(`📡 Petición CORS desde: "${origen}"`);
    if (!origen) return callback(null, true);
    if (MIS_ORIGENES_PERMITIDOS.includes(origen)) return callback(null, true);
    console.warn(`🚫 CORS bloqueado para: "${origen}"`);
    return callback(new Error(`Origen no permitido: ${origen}`));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());

// ══════════════════════════════════════════════════════════════
// RUTA DE SALUD
// ══════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    estado:    'activo',
    servicio:  'Backend — Pack de Cartas de Amor Premium',
    version:   '3.0.0',
    pasarelas: ['mercadopago', 'wompi', 'bold'],
  });
});


// ══════════════════════════════════════════════════════════════
// MERCADO PAGO — Crear preferencia
// ══════════════════════════════════════════════════════════════
app.post('/api/crear-preferencia', async (req, res) => {
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
        back_urls: {
          success: `${MI_FRONTEND_URL}/success.html`,
          failure: `${MI_FRONTEND_URL}/index.html?pago=error`,
          pending: `${MI_FRONTEND_URL}/index.html?pago=pendiente`,
        },
        auto_return:        'approved',
        external_reference: `CARTAS-MP-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,
        expires:            true,
        expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }
    });

    console.log(`✅ MP Preferencia creada: ${resultado.id}`);
    res.json({ ok: true, init_point: resultado.init_point, preference_id: resultado.id });

  } catch (error) {
    console.error('❌ Error MP:', error?.message || error);
    res.status(500).json({ ok: false, mensaje: 'No se pudo crear el pago. Intenta de nuevo.' });
  }
});

// Webhook MP
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return res.sendStatus(200);
    const pago = new Payment(mpClient);
    const detalle = await pago.get({ id: data.id });
    console.log(`📦 Webhook MP | ID: ${detalle.id} | Estado: ${detalle.status}`);
    if (detalle.status === 'approved') console.log(`💰 Pago MP APROBADO: $${detalle.transaction_amount} COP`);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook MP error:', error?.message);
    res.sendStatus(500);
  }
});


// ══════════════════════════════════════════════════════════════
// WOMPI — Generar firma de integridad
// ══════════════════════════════════════════════════════════════
app.post('/api/wompi-firma', (req, res) => {
  try {
    const referencia   = `CARTAS-W-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    const cadenaFirma  = `${referencia}${PRECIO_CENTAVOS}${MONEDA}${WOMPI_INTEGRITY_KEY}`;
    const firma        = crypto.createHash('sha256').update(cadenaFirma).digest('hex');

    console.log(`🔐 Wompi firma generada | Ref: ${referencia}`);

    res.json({
      ok:             true,
      referencia,
      firma,
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

// Webhook Wompi
app.post('/webhook/wompi', (req, res) => {
  try {
    const { data, timestamp, signature } = req.body;
    const propiedades   = data?.transaction ? Object.values(data.transaction).join('') : '';
    const cadenaVerif   = `${propiedades}${timestamp}${WOMPI_EVENTS_KEY}`;
    const firmaEsperada = crypto.createHash('sha256').update(cadenaVerif).digest('hex');
    if (signature?.checksum !== firmaEsperada) {
      console.warn('⚠️ Webhook Wompi con firma inválida');
      return res.sendStatus(401);
    }
    const tx = data?.transaction;
    console.log(`📦 Webhook Wompi | ID: ${tx?.id} | Estado: ${tx?.status}`);
    if (tx?.status === 'APPROVED') console.log(`💰 Pago Wompi APROBADO: $${tx.amount_in_cents / 100} COP`);
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook Wompi error:', error?.message);
    res.sendStatus(500);
  }
});


// ══════════════════════════════════════════════════════════════
// BOLD — Generar firma de integridad
//
// Bold exige que cada transacción esté firmada con mi llave secreta.
// La firma se calcula así (documentación oficial Bold):
//   SHA256( orderId + amount + currency + secretKey )
//
// Donde:
//   orderId  = mi referencia única (la genero yo)
//   amount   = precio en PESOS (Bold NO usa centavos, a diferencia de Wompi)
//   currency = 'COP'
//   secretKey = mi llave secreta de Bold
//
// El frontend recibe la firma y la llave de identidad (pública)
// para inicializar el botón de Bold en la página.
// ══════════════════════════════════════════════════════════════
app.post('/api/bold-firma', (req, res) => {
  try {
    // Mi referencia única para esta transacción Bold
    const orderId = `CARTAS-B-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

    // Construyo la cadena según la documentación oficial de Bold
    // ⚠️ Bold usa PESOS, no centavos (diferente a Wompi)
    const cadenaFirma = `${orderId}${PRECIO_PESOS}${MONEDA}${BOLD_SECRET_KEY}`;

    // Calculo SHA-256 — el sello que Bold verifica en cada transacción
    const firma = crypto
      .createHash('sha256')
      .update(cadenaFirma)
      .digest('hex');

    console.log(`🔐 Bold firma generada | Order: ${orderId}`);

    // Devuelvo al frontend todo lo que necesita para el botón de Bold
    res.json({
      ok:           true,
      orderId,                          // ID único de la orden
      firma,                            // Hash SHA-256 para validar la transacción
      monto:        PRECIO_PESOS,       // En pesos (Bold no usa centavos)
      moneda:       MONEDA,
      identity_key: BOLD_IDENTITY_KEY,  // Llave pública para el botón de Bold
      redirect_url: `${MI_FRONTEND_URL}/success.html`,
    });

  } catch (error) {
    console.error('❌ Error firma Bold:', error?.message);
    res.status(500).json({ ok: false, mensaje: 'No se pudo iniciar el pago con Bold.' });
  }
});

// Webhook Bold
// Bold envía una notificación cuando el estado del pago cambia
app.post('/webhook/bold', (req, res) => {
  try {
    const { order_id, status, amount, currency, signature } = req.body;

    // Verifico la autenticidad del webhook con mi llave secreta
    // Fórmula: SHA256( orderId + status + secretKey )
    const cadenaVerif   = `${order_id}${status}${BOLD_SECRET_KEY}`;
    const firmaEsperada = crypto.createHash('sha256').update(cadenaVerif).digest('hex');

    if (signature !== firmaEsperada) {
      console.warn('⚠️ Webhook Bold con firma inválida — ignorado');
      return res.sendStatus(401);
    }

    console.log(`📦 Webhook Bold | Order: ${order_id} | Estado: ${status}`);

    if (status === 'APPROVED') {
      console.log(`💰 Pago Bold APROBADO: $${amount} ${currency}`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook Bold error:', error?.message);
    res.sendStatus(500);
  }
});


// ══════════════════════════════════════════════════════════════
// ARRANCO EL SERVIDOR
// ══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ════════════════════════════════════════════');
  console.log(`   Backend activo en http://localhost:${PORT}`);
  console.log(`   FRONTEND_URL: "${MI_FRONTEND_URL}"`);
  console.log(`   Modo MP:    ${process.env.MP_ACCESS_TOKEN?.includes('TEST') ? '🧪 PRUEBAS' : '💰 PRODUCCIÓN'}`);
  console.log(`   Modo Wompi: ${WOMPI_PUBLIC_KEY?.includes('prod') ? '💰 PRODUCCIÓN' : '🧪 PRUEBAS'}`);
  // Bold no usa 'prod' en sus llaves — detecto producción por longitud mínima
  console.log(`   Modo Bold:  ${BOLD_IDENTITY_KEY?.length >= 20 ? '💰 PRODUCCIÓN' : '🧪 PRUEBAS'}`);
  console.log('   ════════════════════════════════════════════');
  console.log('');
});