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

// Borra en lotes todos los documentos de una consulta.
async function borrarTodos(query) {
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const snap = await query.limit(300).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    total += snap.size;
  }
  return total;
}

// --- Handler: borra facturas_procesadas y facturas_pendientes_revision de UN proveedor,
//     para que la próxima corrida del background function de ese proveedor
//     vuelva a procesar todo desde cero (por ejemplo, después de corregir su prompt).
//     Uso: /.netlify/functions/limpiar-proveedor-background?proveedor=SIPE
//     NO toca la colección "compras" — esos datos ya validados quedan intactos. ---

exports.handler = async (event) => {
  const runId = `limpieza_${Date.now()}`;
  const runRef = db.collection('runs').doc(runId);

  const proveedor = (event.queryStringParameters || {}).proveedor;

  if (!proveedor) {
    await runRef.set({
      tipo: 'limpieza',
      estado: 'error',
      error: 'Falta el parámetro ?proveedor=NOMBRE en la URL',
      inicio: admin.firestore.FieldValue.serverTimestamp(),
    });
    return;
  }

  await runRef.set({
    tipo: 'limpieza',
    proveedor,
    estado: 'corriendo',
    inicio: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    const borradosProcesadas = await borrarTodos(
      db.collection('facturas_procesadas').where('proveedor', '==', proveedor)
    );
    const borradosPendientes = await borrarTodos(
      db.collection('facturas_pendientes_revision').where('proveedor', '==', proveedor)
    );

    await runRef.update({
      estado: 'terminado',
      borrados_facturas_procesadas: borradosProcesadas,
      borrados_facturas_pendientes_revision: borradosPendientes,
      mensaje: `Se borraron ${borradosProcesadas} registros de facturas_procesadas y ${borradosPendientes} de facturas_pendientes_revision para ${proveedor}. No se tocó la colección compras.`,
      fin: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    await runRef.update({
      estado: 'error',
      error: err.message,
      fin: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
};
