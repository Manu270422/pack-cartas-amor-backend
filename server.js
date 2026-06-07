/*
  Mi servidor backend para el Pack de Cartas de Amor Premium.
  Aquí vive la lógica que NO puede ir en el frontend:
  - Crear preferencias de pago con mi Access Token secreto
  - Recibir y validar webhooks de Mercado Pago
  - (Más adelante) Wompi y Bold

  Para correrlo localmente: npm run dev
  Para producción en Render: npm start
*/

// Cargo mis variables de entorno PRIMERO, antes de cualquier otra cosa
// El archivo .env solo existe localmente; en Render las configuro en el panel
require('dotenv').config();

const express  = require('express');
const cors     = require('cors');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

// ══════════════════════════════════════════════════════════════
// MI VALIDACIÓN DE VARIABLES DE ENTORNO AL ARRANCAR
// Si falta alguna variable crítica, el servidor no arranca y me avisa
// ══════════════════════════════════════════════════════════════
const VARIABLES_REQUERIDAS = ['MP_ACCESS_TOKEN', 'MP_PUBLIC_KEY', 'FRONTEND_URL'];
const VARIABLES_FALTANTES  = VARIABLES_REQUERIDAS.filter(v => !process.env[v]);

if (VARIABLES_FALTANTES.length > 0) {
  console.error('❌ ERROR: Me faltan estas variables de entorno:');
  VARIABLES_FALTANTES.forEach(v => console.error(`   → ${v}`));
  console.error('📄 Revisa el archivo .env.example y crea tu .env con los valores reales.');
  process.exit(1); // Detengo el servidor — no tiene sentido seguir sin credenciales
}

// ══════════════════════════════════════════════════════════════
// MI CONFIGURACIÓN DE MERCADO PAGO (SDK v3)
// Paso mi Access Token al cliente de MP — esto es lo que lo autoriza
// ══════════════════════════════════════════════════════════════
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: {
    timeout: 5000, // Mi timeout de 5 segundos para no dejar colgado al usuario
  }
});

// ══════════════════════════════════════════════════════════════
// MI CONFIGURACIÓN DE EXPRESS
// ══════════════════════════════════════════════════════════════
const app  = express();
const PORT = process.env.PORT || 3000;

// Mi configuración de CORS — solo permito peticiones desde mi frontend
// Esto evita que otros sitios usen mi backend sin permiso
const MI_FRONTEND_URL = process.env.FRONTEND_URL;
app.use(cors({
  origin: [
    MI_FRONTEND_URL,              // Mi sitio en producción (Netlify)
    'http://localhost:5500',       // Mi Live Server de VS Code
    'http://127.0.0.1:5500',       // Alternativa de Live Server
    'http://localhost:3001',       // Por si uso otro puerto local
    'null',                        // Para abrir el HTML directamente en el navegador
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

// Parseo JSON en el body de las peticiones (lo que llega del frontend)
app.use(express.json());

// ══════════════════════════════════════════════════════════════
// MIS RUTAS
// ══════════════════════════════════════════════════════════════

// ── Ruta de salud — para verificar que el servidor está vivo ──
app.get('/', (req, res) => {
  res.json({
    estado:   'activo',
    servicio: 'Backend — Pack de Cartas de Amor Premium',
    version:  '1.0.0',
  });
});

// ── Mi ruta principal: crear preferencia de pago de Mercado Pago ──
// La llama mi frontend cuando el usuario elige "Mercado Pago" en el modal
app.post('/api/crear-preferencia', async (req, res) => {
  try {
    // ── Mis datos del producto — los tengo hardcodeados aquí ──
    // No los recibo del frontend porque el frontend NO es de confianza
    // (cualquiera podría cambiar el precio en el navegador)
    const PRODUCTO = {
      title:       'Pack de Cartas de Amor Premium — El Mundo de Manu',
      quantity:    1,
      currency_id: 'COP',
      unit_price:  15000, // Precio en pesos colombianos — yo lo controlo aquí
    };

    // ── Creo la preferencia con el SDK de MP ──
    const preference = new Preference(mpClient);
    const resultado  = await preference.create({
      body: {
        items: [PRODUCTO],

        // Mis URLs de redirección — adonde MP lleva al usuario después del pago
        back_urls: {
          success: `${MI_FRONTEND_URL}/success.html`,
          failure: `${MI_FRONTEND_URL}/index.html?pago=error`,
          pending: `${MI_FRONTEND_URL}/index.html?pago=pendiente`,
        },

        // MP redirige automáticamente si el pago fue aprobado (no espera que el usuario haga clic)
        auto_return: 'approved',

        // Mi referencia externa — me sirve para identificar este pago en mis registros
        // Uso la fecha + un random para que sea único
        external_reference: `CARTAS-${Date.now()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`,

        // Mi URL de webhook — MP me avisa aquí cuando el pago cambia de estado
        // (Lo activo cuando tenga la URL de Render lista)
        // notification_url: `${process.env.RENDER_URL}/webhook/mercadopago`,

        // Los datos del pagador son opcionales pero mejoran la tasa de aprobación
        // payer: { name: 'Cliente', email: req.body.email }

        // Tiempo de expiración de la preferencia: 1 día
        expires:            true,
        expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }
    });

    // ── Le respondo al frontend con las URLs de pago ──
    // init_point     = URL de pago en PRODUCCIÓN (la que usan clientes reales)
    // sandbox_init_point = URL de pago en PRUEBAS (la que uso yo para probar)
    res.json({
      ok:                  true,
      init_point:          resultado.init_point,
      sandbox_init_point:  resultado.sandbox_init_point,
      preference_id:       resultado.id,
    });

    // ── Log para mis registros internos ──
    console.log(`✅ Preferencia creada: ${resultado.id} | Ref: ${resultado.external_reference}`);

  } catch (error) {
    // Si algo falla (credenciales malas, MP caído, etc.) le aviso al frontend
    console.error('❌ Error al crear preferencia de MP:', error?.message || error);
    res.status(500).json({
      ok:      false,
      mensaje: 'No se pudo crear la preferencia de pago. Intenta de nuevo.',
    });
  }
});


// ── Mi ruta de webhook de Mercado Pago ──
// MP llama aquí cada vez que un pago cambia de estado (aprobado, rechazado, etc.)
// Esto me sirve para llevar registro de mis ventas en el futuro
app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;

    // Solo proceso notificaciones de tipo "payment"
    if (type !== 'payment') {
      return res.sendStatus(200); // Le digo a MP que recibí el mensaje, aunque no lo procese
    }

    // Consulto el pago a la API de MP para verificar que es legítimo
    // (NUNCA confío ciegamente en lo que llega al webhook — podría ser falso)
    const pago = new Payment(mpClient);
    const detallePago = await pago.get({ id: data.id });

    console.log(`📦 Webhook MP | Pago: ${detallePago.id} | Estado: ${detallePago.status} | Ref: ${detallePago.external_reference}`);

    // Aquí puedo agregar lógica futura:
    // - Guardar el pago en una base de datos
    // - Enviar email de confirmación al cliente
    // - Llevar conteo de ventas
    if (detallePago.status === 'approved') {
      console.log(`✅ Pago APROBADO: $${detallePago.transaction_amount} COP`);
    }

    // Le respondo 200 a MP — si no lo hago, MP reintenta el webhook indefinidamente
    res.sendStatus(200);

  } catch (error) {
    console.error('❌ Error procesando webhook de MP:', error?.message);
    res.sendStatus(500);
  }
});


// ── Ruta para exponer mi clave pública al frontend de forma segura ──
// El frontend la necesita para inicializar el SDK de MP en el browser
app.get('/api/config', (req, res) => {
  res.json({
    mp_public_key: process.env.MP_PUBLIC_KEY,
    // Solo expongo lo que es público — nunca el Access Token
  });
});


// ══════════════════════════════════════════════════════════════
// ARRANCO MI SERVIDOR
// ══════════════════════════════════════════════════════════════
app.listen(PORT, () => {
  console.log('');
  console.log('🚀 ════════════════════════════════════════');
  console.log(`   Backend activo en http://localhost:${PORT}`);
  console.log(`   Frontend esperado: ${MI_FRONTEND_URL}`);
  console.log(`   Modo: ${process.env.MP_ACCESS_TOKEN?.includes('TEST') ? '🧪 PRUEBAS' : '💰 PRODUCCIÓN'}`);
  console.log('   ════════════════════════════════════════');
  console.log('');
});