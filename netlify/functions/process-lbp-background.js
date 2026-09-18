const { google } = require('googleapis');
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

// --- El prompt de extracción que armamos para LBP ---

const LBP_PROMPT = `Sos un extractor de datos de facturas del proveedor LBP (CHIFUAJE SRL / AVM Mayorista).

Reglas específicas de este proveedor:
1. Los números usan formato argentino: punto de miles, coma decimal (ej. "20,20" = 20.20).
2. El PDF puede contener MÁS DE UNA factura concatenada (mismo o distinto número de comprobante). Devolvé una lista de facturas, no asumas que hay una sola.
3. El código de producto puede repetirse entre variantes distintas del mismo producto (ej. mismo código para "Coliflor Amarillo" y "Coliflor Morado"). Usá código + descripción juntos, nunca solo el código, para identificar el ítem.
4. Para cada línea, detectá si la descripción indica un empaque (palabras como BOLSON, CAJA, CAJON, MAPLE, PAQUETE, BULTO seguidas de un número + unidad). Si es así:
   - unidad_compra = el tipo de empaque (ej. "bolsón", "maple")
   - contenido_por_unidad = el número que acompaña al empaque en la descripción
   - contenido_unidad_medida = "kg" o "unidad" según corresponda
   Si NO hay palabra de empaque, unidad_compra = "kg", contenido_por_unidad = 1, contenido_unidad_medida = "kg".
5. Extraé descuento_pct incluso cuando es 0 — no lo omitas.

Devolvé SOLO este JSON, sin texto adicional, sin markdown, sin backticks:
{
  "facturas": [
    {
      "proveedor": "LBP",
      "razon_social": "",
      "comprobante_nro": "",
      "fecha": "YYYY-MM-DD",
      "total_factura": 0,
      "items": [ { "codigo": "", "descripcion": "", "cantidad_comprada": 0, "unidad_compra": "", "contenido_por_unidad": 0, "contenido_unidad_medida": "", "precio_unitario": 0, "descuento_pct": 0, "total": 0 } ]
    }
  ]
}`;

// --- Handler principal (BACKGROUND FUNCTION: el navegador recibe un 202 inmediato,
//     esto sigue corriendo por atrás hasta 15 minutos, sin depender de que el navegador espere) ---

exports.handler = async (event, context) => {
  const runId = `run_${Date.now()}`;
  const runRef = db.collection('runs').doc(runId);
  await runRef.set({
    proveedor: 'LBP',
    estado: 'corriendo',
    inicio: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: getServiceAccount(),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // 1. Encontrar la carpeta "LBP" más reciente (la del mes actual)
    const foldersRes = await drive.files.list({
      q: "name = 'LBP' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 1,
    });

    if (!foldersRes.data.files.length) {
      await runRef.update({ estado: 'error', error: 'No se encontró ninguna carpeta llamada LBP en Drive' });
      return;
    }
    const folderId = foldersRes.data.files[0].id;

    // 2. Listar los PDFs dentro de esa carpeta
    const filesRes = await drive.files.list({
      q: `'${folderId}' in parents and mimeType = 'application/pdf' and trashed = false`,
      fields: 'files(id, name, modifiedTime)',
      pageSize: 200,
    });
    const files = filesRes.data.files || [];

    const MAX_POR_EJECUCION = 15; // límite de seguridad, no de tiempo (ahora tenemos hasta 15 min)
    const resumen = { procesadas: 0, ya_existian: 0, pendientes_revision: 0, errores: 0, detalle: [] };

    for (const file of files) {
      if (resumen.procesadas >= MAX_POR_EJECUCION) break;

      // 3. Saltar si ya lo procesamos antes (idempotencia)
      const yaExiste = await db.collection('facturas_procesadas').doc(file.id).get();
      if (yaExiste.exists) {
        resumen.ya_existian++;
        continue;
      }

      try {
        console.log(`[${file.name}] empezando`);
        const t0 = Date.now();

        // 4. Descargar el PDF como binario
        const fileRes = await drive.files.get(
          { fileId: file.id, alt: 'media' },
          { responseType: 'arraybuffer' }
        );
        const base64Pdf = Buffer.from(fileRes.data).toString('base64');
        console.log(`[${file.name}] PDF descargado, t=${Date.now() - t0}ms`);

        // 5. Mandarlo a la API de Anthropic, como documento (no como texto)
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 4096,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf } },
                  { type: 'text', text: LBP_PROMPT },
                ],
              },
            ],
          }),
        });

        console.log(`[${file.name}] respuesta de Anthropic recibida, t=${Date.now() - t0}ms`);
        const claudeData = await claudeRes.json();
        const textBlock = (claudeData.content || []).find((b) => b.type === 'text');

        if (!textBlock) {
          throw new Error('La API no devolvió texto: ' + JSON.stringify(claudeData));
        }

        let parsed;
        try {
          parsed = JSON.parse(textBlock.text);
        } catch (e) {
          await db.collection('facturas_pendientes_revision').add({
            proveedor: 'LBP',
            archivo: file.name,
            fileId: file.id,
            motivo: 'La respuesta de la API no era JSON válido',
            respuesta_cruda: textBlock.text,
            fecha_procesado: admin.firestore.FieldValue.serverTimestamp(),
          });
          resumen.pendientes_revision++;
          continue;
        }

        // 6. Validar cada línea y guardar
        let lineasValidas = 0;
        let lineasInvalidas = 0;

        for (const factura of parsed.facturas || []) {
          for (const item of factura.items || []) {
            const descuento = item.descuento_pct || 0;
            const calculado = item.cantidad_comprada * item.precio_unitario * (1 - descuento / 100);
            const diferencia = Math.abs(calculado - item.total);
            const valido = diferencia < 2; // tolerancia de redondeo

            const compra = {
              proveedor: 'LBP',
              comprobante_nro: factura.comprobante_nro || null,
              fecha: factura.fecha || null,
              codigo: item.codigo || null,
              descripcion: item.descripcion,
              cantidad_comprada: item.cantidad_comprada,
              unidad_compra: item.unidad_compra,
              contenido_por_unidad: item.contenido_por_unidad,
              contenido_unidad_medida: item.contenido_unidad_medida,
              precio_unitario: item.precio_unitario,
              descuento_pct: descuento,
              total: item.total,
              fileId: file.id,
              archivo_origen: file.name,
              fecha_procesado: admin.firestore.FieldValue.serverTimestamp(),
            };

            if (valido) {
              await db.collection('compras').add(compra);
              lineasValidas++;
            } else {
              await db.collection('facturas_pendientes_revision').add({
                ...compra,
                motivo: `No cierra la validación: cantidad×precio×(1-desc%) = ${calculado.toFixed(2)}, pero el total dice ${item.total}`,
              });
              lineasInvalidas++;
            }
          }
        }

        // 7. Marcar el archivo como procesado (para no reprocesarlo la próxima vez)
        await db.collection('facturas_procesadas').doc(file.id).set({
          archivo: file.name,
          proveedor: 'LBP',
          lineas_validas: lineasValidas,
          lineas_pendientes_revision: lineasInvalidas,
          fecha_procesado: admin.firestore.FieldValue.serverTimestamp(),
        });

        resumen.procesadas++;
        if (lineasInvalidas > 0) resumen.pendientes_revision += lineasInvalidas;
        resumen.detalle.push({ archivo: file.name, lineas_validas: lineasValidas, lineas_pendientes: lineasInvalidas });

        // Actualizamos el progreso en Firestore después de CADA factura, no solo al final,
        // así podés ver el avance en tiempo real aunque la corrida entera tarde varios minutos.
        await runRef.update({ ...resumen, estado: 'corriendo' });
      } catch (err) {
        resumen.errores++;
        resumen.detalle.push({ archivo: file.name, error: err.message });
        await runRef.update({ ...resumen, estado: 'corriendo' });
      }
    }

    const restantes = files.length - resumen.procesadas - resumen.ya_existian;
    resumen.mensaje = restantes > 0
      ? `Procesadas ${resumen.procesadas}. Quedan ${restantes} facturas nuevas sin procesar — volvé a disparar la función para seguir.`
      : `Procesadas ${resumen.procesadas}. No quedan facturas nuevas.`;

    await runRef.update({ ...resumen, estado: 'terminado', fin: admin.firestore.FieldValue.serverTimestamp() });
  } catch (err) {
    console.error('ERROR COMPLETO:', err);
    await runRef.update({
      estado: 'error',
      error: err.message,
      code: err.code || null,
      fin: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
};
