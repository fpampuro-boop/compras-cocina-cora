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

// Algunas respuestas de la API vienen envueltas en un bloque de código markdown
// (```json ... ``` o ``` ... ```) a pesar de que el prompt pide que no lo haga.
function limpiarJson(texto) {
  let limpio = texto.trim();
  limpio = limpio.replace(/^```(?:json)?\s*/i, '');
  limpio = limpio.replace(/```\s*$/i, '');
  return limpio.trim();
}

// --- El prompt de extracción que armamos para Brunpag (limpieza/almacén) ---

const BRUNPAG_PROMPT = `Sos un extractor de datos de facturas del proveedor Brunpag S.R.L. (limpieza/almacén).

Reglas específicas de este proveedor:
1. Los números usan formato estadounidense: coma de miles, punto decimal (ej. "1,560,722.04" = 1560722.04).
2. La tabla de ítems tiene columnas: Cantidad, Detalle, Remito, P. Unitario, Total. Este proveedor NO usa código de producto por ítem — identificá cada ítem solo por su descripción (Detalle).
   OJO con la columna "Cantidad": siempre viene escrita con tres decimales después del punto (ej. "1.000", "15.000", "84.000", "324.000"). Esos NO son miles — son cantidades simples con el punto como separador decimal: "1.000" = 1 (uno), "15.000" = 15 (quince), "324.000" = 324 (trescientos veinticuatro). NUNCA multipliques por mil un valor de esta columna. Si tenés dudas, fijate que cantidad_comprada × precio_unitario tiene que dar aproximadamente el total de esa línea — si te da mil veces más grande, dividí por 1000.
3. IGNORÁ COMPLETAMENTE cualquier línea cuyo Detalle sea "DESCUENTO" (la cantidad puede aparecer como "1.000" o "-1.000", y el total siempre es negativo). Es un descuento comercial global de toda la factura, NO es un producto — no lo incluyas en "items".
4. IGNORÁ COMPLETAMENTE cualquier línea que diga solo "GONDOLA" (u otra palabra suelta) sin cantidad, precio ni total numérico — es un encabezado de sección, no un ítem.
5. A diferencia de otros proveedores, acá NO hay descuento oculto por línea: cantidad_comprada × precio_unitario debe coincidir con el total tal cual, sin aplicar ningún % adicional. descuento_pct = 0 en todas las líneas, salvo que la factura muestre explícitamente otro valor en esa línea puntual (no el DESCUENTO global de la regla 3).
6. La factura tiene DOS fechas: "Cod Fecha" (fecha de emisión, arriba a la izquierda) y "Fecha de vencimiento pago". Usá SIEMPRE "Cod Fecha" como "fecha" — nunca la de vencimiento.
7. El número de comprobante aparece como "N°: 0008-00002461" (o similar) — usalo tal cual, con el guión.
8. CRÍTICO — el PDF de una factura de Brunpag casi siempre tiene 2 páginas, y el número de factura (N°) se repite igual en ambas páginas. Si ves el mismo número de comprobante en varias páginas del PDF, son la MISMA factura continuada — agrupá TODOS los ítems de todas esas páginas bajo una sola entrada en "facturas", no crees una factura nueva por cada página. Si en cambio aparece un número de comprobante distinto, ahí sí es una factura nueva.
9. Para cada línea, detectá si la descripción indica un empaque (BULTO, CAJA, CARTON, PAQUETE, BOLSA seguido de un número + unidad, o un tamaño como "X 25 KG", "X5 LTS", "X 10KG"). Si es así:
   - unidad_compra = el tipo de empaque (ej. "bulto", "caja", "bolsa"), o si el envase no tiene nombre propio usá la unidad de medida (ej. "lts", "kg")
   - contenido_por_unidad = el número que acompaña al empaque en la descripción
   - contenido_unidad_medida = "kg", "lts", o "unidad" según corresponda
   Si NO hay ninguna indicación de tamaño/empaque en la descripción, unidad_compra = "unidad", contenido_por_unidad = 1, contenido_unidad_medida = "unidad".
10. El PDF puede contener más de una factura distinta concatenada (con números de comprobante diferentes). Devolvé una lista de facturas.

Devolvé SOLO este JSON, sin texto adicional, sin markdown, sin backticks:
{
  "facturas": [
    {
      "proveedor": "Brunpag",
      "razon_social": "",
      "comprobante_nro": "",
      "fecha": "YYYY-MM-DD",
      "total_factura": 0,
      "items": [ { "codigo": null, "descripcion": "", "cantidad_comprada": 0, "unidad_compra": "", "contenido_por_unidad": 0, "contenido_unidad_medida": "", "precio_unitario": 0, "descuento_pct": 0, "total": 0 } ]
    }
  ]
}`;

// --- Handler principal (BACKGROUND FUNCTION: el navegador recibe un 202 inmediato,
//     esto sigue corriendo por atrás hasta 15 minutos, sin depender de que el navegador espere) ---

exports.handler = async (event, context) => {
  const runId = `run_${Date.now()}`;
  const runRef = db.collection('runs').doc(runId);
  await runRef.set({
    proveedor: 'Brunpag',
    estado: 'corriendo',
    inicio: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    const auth = new google.auth.GoogleAuth({
      credentials: getServiceAccount(),
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });

    // 1. Encontrar la carpeta "Brunpag" más reciente (la del mes actual)
    const foldersRes = await drive.files.list({
      q: "name = 'Brunpag' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name, createdTime)',
      orderBy: 'createdTime desc',
      pageSize: 1,
    });

    if (!foldersRes.data.files.length) {
      await runRef.update({ estado: 'error', error: 'No se encontró ninguna carpeta llamada Brunpag en Drive' });
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

    const MAX_POR_EJECUCION = 15;
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

        // 5. Mandarlo a la API de Anthropic, como documento (no como texto) —
        //    esto es CRÍTICO para Brunpag, porque la extracción de texto plano de
        //    Google Drive desordena las columnas de estas facturas.
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
                  { type: 'text', text: BRUNPAG_PROMPT },
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
          parsed = JSON.parse(limpiarJson(textBlock.text));
        } catch (e) {
          await db.collection('facturas_pendientes_revision').add({
            proveedor: 'Brunpag',
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
              proveedor: 'Brunpag',
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
          proveedor: 'Brunpag',
          lineas_validas: lineasValidas,
          lineas_pendientes_revision: lineasInvalidas,
          fecha_procesado: admin.firestore.FieldValue.serverTimestamp(),
        });

        resumen.procesadas++;
        if (lineasInvalidas > 0) resumen.pendientes_revision += lineasInvalidas;
        resumen.detalle.push({ archivo: file.name, lineas_validas: lineasValidas, lineas_pendientes: lineasInvalidas });

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
