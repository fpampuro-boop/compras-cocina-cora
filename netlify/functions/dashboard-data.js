const admin = require('firebase-admin');

// --- Inicialización (se ejecuta una sola vez por "cold start" de la función) ---

function getServiceAccount() {
  const json = Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_KEY, 'base64').toString('utf-8');
  return JSON.parse(json);
}

if (!admin.apps.length) {
  const serviceAccount = getServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
  });
}
const db = admin.firestore();

// --- Handler: devuelve TODAS las compras validadas (colección "compras") como JSON,
//     para que el dashboard haga los cálculos y gráficos del lado del navegador.
//     Es una función NORMAL (no background) porque solo lee y devuelve datos,
//     no llama a la API de Anthropic — debería responder en menos de un par de segundos
//     salvo que la colección crezca mucho, en cuyo caso conviene paginar. ---

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  try {
    const snap = await db.collection('compras').orderBy('fecha', 'asc').get();
    const compras = snap.docs.map((doc) => {
      const d = doc.data();
      return {
        id: doc.id,
        proveedor: d.proveedor || null,
        comprobante_nro: d.comprobante_nro || null,
        fecha: d.fecha || null,
        codigo: d.codigo || null,
        descripcion: d.descripcion || null,
        cantidad_comprada: d.cantidad_comprada ?? null,
        unidad_compra: d.unidad_compra || null,
        contenido_por_unidad: d.contenido_por_unidad ?? null,
        contenido_unidad_medida: d.contenido_unidad_medida || null,
        precio_unitario: d.precio_unitario ?? null,
        descuento_pct: d.descuento_pct ?? null,
        total: d.total ?? null,
      };
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ compras, generado: new Date().toISOString() }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
