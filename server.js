/*
  Mi servidor backend — Pack de Cartas de Amor Premium.
  Integra: Mercado Pago (Checkout Pro) + Wompi (Widget con firma de integridad)

  Para correr localmente:  npm run dev
  Para producción Render:  npm start
*/

require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const crypto   = require('crypto'); // Nativo de Node — lo uso para la firma de Wompi
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

// ══════════════════════════════════════════════════════════════
// VALIDACIÓN DE VARIABLES DE ENTORNO AL ARRANCAR
// El servidor no arranca si falta alguna variable crítica
// ══════════════════════════════════════════════════════════════
const VARIABLES_REQUERIDAS = [
  'MP_ACCESS_TOKEN',
  'MP_PUBLIC_KEY',
  'WOMPI_PUBLIC_KEY',
  'WOMPI_PRIVATE_KEY',
  'WOMPI_INTEGRITY_KEY',
  'WOMPI_EVENTS_KEY',
  'FRONTEND_URL',
];

const VARIABLES_FALTANTES = VARIABLES_REQUERIDAS.filter(v => !process.env[v]);
if (VARIABLES_FALTANTES.length > 0) {
  console.error('❌ ERROR: Me faltan estas variables de entorno:');
  VARIABLES_FALTANTES.forEach(v => console.error(`   → ${v}`));
  console.error('📄 Agrega las variables faltantes en Render → Environment.');
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════
// MI CONFIGURACIÓN DE MERCADO PAGO (SDK v3)
// ══════════════════════════════════════════════════════════════
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 },
});

// ══════════════════════════════════════════════════════════════
// MIS CONSTANTES DE WOMPI
// Las leo del .env — nunca las escribo directo en el código
// ══════════════════════════════════════════════════════════════
const WOMPI_PUBLIC_KEY    = process.env.WOMPI_PUBLIC_KEY;
const WOMPI_INTEGRITY_KEY = process.env.WOMPI_INTEGRITY_KEY;
const WOMPI_EVENTS_KEY    = process.env.WOMPI_EVENTS_KEY;

// Mi precio del producto en CENTAVOS — Wompi siempre trabaja en centavos
// $15.000 COP × 100 = 1.500.000 centavos
const PRECIO_CENTAVOS = 1500000;
const MONEDA          = 'COP';

// ══════════════════════════════════════════════════════════════
// CONFIGURACIÓN DE EXPRESS Y CORS
// ══════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 3000;

// Limpio la URL del frontend: quito espacios y barra final
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
// MIS RUTAS
// ══════════════════════════════════════════════════════════════

// ── Salud del servidor ──
app.get('/', (req, res) => {
  res.json({
    estado:   'activo',
    servicio: 'Backend — Pack de Cartas de Amor Premium',
    version:  '2.0.0',
    pasarelas: ['mercadopago', 'wompi'],
  });
});


// ══════════════════════════════════════════════════════════════
// MERCADO PAGO — Crear preferencia de pago
// ══════════════════════════════════════════════════════════════
app.post('/api/crear-preferencia', async (req, res) => {
  try {
    const PRODUCTO = {
      title:       'Pack de Cartas de Amor Premium — El Mundo de Manu',
      quantity:    1,
      currency_id: MONEDA,
      unit_price:  15000, // En pesos — MP no usa centavos
    };

    const preference = new Preference(mpClient);
    const resultado  = await preference.create({
      body: {
        items: [PRODUCTO],
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

    res.json({
      ok:           true,
      init_point:   resultado.init_point,
      preference_id: resultado.id,
    });

  } catch (error) {
    console.error('❌ Error MP:', error?.message || error);
    res.status(500).json({ ok: false, mensaje: 'No se pudo crear el pago. Intenta de nuevo.' });
  }
});


// ── Webhook de Mercado Pago ──
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return res.sendStatus(200);

    const pago        = new Payment(mpClient);
    const detallePago = await pago.get({ id: data.id });
    console.log(`📦 Webhook MP | ID: ${detallePago.id} | Estado: ${detallePago.status}`);
    if (detallePago.status === 'approved') {
      console.log(`💰 Pago MP APROBADO: $${detallePago.transaction_amount} COP`);
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook MP error:', error?.message);
    res.sendStatus(500);
  }
});


// ══════════════════════════════════════════════════════════════
// WOMPI — Generar firma de integridad
//
// ¿Por qué necesito esto?
// Wompi exige que cada transacción tenga una firma SHA-256 calculada
// con mi llave de integridad (que es secreta). Si esta firma no coincide,
// Wompi rechaza el pago. Por eso NUNCA puedo calcularla en el frontend
// — cualquiera podría ver la llave y falsificar transacciones.
//
// Fórmula oficial de Wompi:
//   SHA256( referencia + monto_en_centavos + moneda + llave_integridad )
// ══════════════════════════════════════════════════════════════
app.post('/api/wompi-firma', (req, res) => {
  try {
    // Genero una referencia única para esta transacción
    // Wompi la usa para identificar el pago en su sistema
    const referencia = `CARTAS-W-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;

    // Construyo la cadena exacta que Wompi espera para calcular la firma
    // ⚠️ El orden importa: referencia + monto + moneda + llave_integridad
    const cadenaFirma = `${referencia}${PRECIO_CENTAVOS}${MONEDA}${WOMPI_INTEGRITY_KEY}`;

    // Calculo el hash SHA-256 — este es el "sello" que Wompi verifica
    const firma = crypto
      .createHash('sha256')
      .update(cadenaFirma)
      .digest('hex');

    console.log(`🔐 Wompi firma generada | Ref: ${referencia}`);

    // Le devuelvo al frontend todo lo que necesita para abrir el Widget
    res.json({
      ok:              true,
      referencia,                    // Identificador único de esta transacción
      firma,                         // El hash SHA-256 que Wompi verifica
      monto_centavos:  PRECIO_CENTAVOS,
      moneda:          MONEDA,
      llave_publica:   WOMPI_PUBLIC_KEY,   // La llave pública también la sirvo desde aquí
      redirect_url:    `${MI_FRONTEND_URL}/success.html`,
    });

  } catch (error) {
    console.error('❌ Error generando firma Wompi:', error?.message);
    res.status(500).json({ ok: false, mensaje: 'No se pudo iniciar el pago con Wompi.' });
  }
});


// ── Webhook de Wompi ──
// Wompi llama aquí cuando el estado de un pago cambia
app.post('/webhook/wompi', (req, res) => {
  try {
    const { event, data, sent_at, timestamp, signature } = req.body;

    // Verifico que el webhook es legítimo usando mi llave de eventos
    // Fórmula: SHA256( propiedades_del_evento + timestamp + llave_eventos )
    const propiedades = data?.transaction
      ? Object.values(data.transaction).join('')
      : '';
    const cadenaVerif = `${propiedades}${timestamp}${WOMPI_EVENTS_KEY}`;
    const firmaEsperada = crypto.createHash('sha256').update(cadenaVerif).digest('hex');

    if (signature?.checksum !== firmaEsperada) {
      console.warn('⚠️ Webhook Wompi con firma inválida — ignorado');
      return res.sendStatus(401);
    }

    const transaccion = data?.transaction;
    console.log(`📦 Webhook Wompi | ID: ${transaccion?.id} | Estado: ${transaccion?.status}`);

    if (transaccion?.status === 'APPROVED') {
      console.log(`💰 Pago Wompi APROBADO: $${transaccion.amount_in_cents / 100} COP`);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('❌ Webhook Wompi error:', error?.message);
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
  console.log(`   FRONTEND_URL procesada: "${MI_FRONTEND_URL}"`);
  console.log(`   Modo MP:    ${process.env.MP_ACCESS_TOKEN?.includes('TEST') ? '🧪 PRUEBAS' : '💰 PRODUCCIÓN'}`);
  console.log(`   Modo Wompi: ${WOMPI_PUBLIC_KEY?.includes('prod') ? '💰 PRODUCCIÓN' : '🧪 PRUEBAS'}`);
  console.log('   ════════════════════════════════════════════');
  console.log('');
});